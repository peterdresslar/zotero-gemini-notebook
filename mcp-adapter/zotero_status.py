"""Read the narrow, sanitized Zotero connector status."""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal

ZOTERO_STATUS_URL = "http://127.0.0.1:23119/notebooklm/status"
STATUS_TIMEOUT_SECONDS = 2.0
MAX_STATUS_BODY_BYTES = 16 * 1024

BridgeStatus = Literal[
    "opted_in",
    "disabled",
    "unsupported",
    "unavailable",
    "invalid_response",
    "internal_error",
]

_MISSING = object()
_ZOTERO_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,127}\Z")
_PLUGIN_VERSION_PREFIX = "Zotero Gemini Notebook "
_SEMVER_PRERELEASE_IDENTIFIER = (
    r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
)
_PLUGIN_SEMVER_PATTERN = re.compile(
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)"
    rf"(?:-{_SEMVER_PRERELEASE_IDENTIFIER}"
    rf"(?:\.{_SEMVER_PRERELEASE_IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z"
)
_MAX_PLUGIN_SEMVER_LENGTH = 64


@dataclass(frozen=True)
class ZoteroBridgeStatus:
    """The complete allowlist of fields exposed through the MCP tool."""

    status: BridgeStatus
    mcpOptedIn: bool | None
    hasStagedSources: bool | None
    stagedSourceCount: int | None
    zoteroVersion: str | None
    pluginVersion: str | None


class InvalidZoteroStatusResponse(ValueError):
    """Raised when the fixed loopback endpoint returns an invalid document."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def read_zotero_bridge_status() -> ZoteroBridgeStatus:
    """Fetch status from the single fixed loopback endpoint.

    Network failures and malformed responses become fixed, sanitized states. Raw
    exception text and response data never cross the MCP boundary.
    """

    request = urllib.request.Request(
        ZOTERO_STATUS_URL,
        headers={
            "Accept": "application/json",
            "Zotero-Allowed-Request": "1",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _NoRedirectHandler(),
    )

    try:
        with opener.open(request, timeout=STATUS_TIMEOUT_SECONDS) as response:
            return _read_status_response(response)
    except urllib.error.HTTPError:
        return _empty_status("invalid_response")
    except InvalidZoteroStatusResponse:
        return _empty_status("invalid_response")
    except (http.client.HTTPException, OSError):
        return _empty_status("unavailable")


def parse_zotero_status_document(document: object) -> ZoteroBridgeStatus:
    """Validate a decoded status document and construct the allowlisted DTO."""

    if type(document) is not dict:
        raise InvalidZoteroStatusResponse("Status response must be an object")

    payload = document
    opted_in = payload.get("mcpOptedIn", _MISSING)
    if opted_in is _MISSING:
        status: BridgeStatus = "unsupported"
        normalized_opted_in = None
    elif type(opted_in) is bool:
        normalized_opted_in = opted_in
        status = "opted_in" if opted_in else "disabled"
    else:
        raise InvalidZoteroStatusResponse("mcpOptedIn must be a boolean")

    ready = _read_boolean(payload, "ready")
    count = _read_count(payload)
    if ready != (count > 0):
        raise InvalidZoteroStatusResponse("ready and count are inconsistent")

    return ZoteroBridgeStatus(
        status=status,
        mcpOptedIn=normalized_opted_in,
        hasStagedSources=ready,
        stagedSourceCount=count,
        zoteroVersion=_read_zotero_version(payload),
        pluginVersion=_read_plugin_version(payload),
    )


def create_internal_error_status() -> ZoteroBridgeStatus:
    """Return a fixed result without exposing unexpected exception details."""

    return _empty_status("internal_error")


def _read_status_response(response: object) -> ZoteroBridgeStatus:
    status_code = getattr(response, "status", None)
    if status_code is None:
        status_code = response.getcode()
    if status_code != 200:
        raise InvalidZoteroStatusResponse("Status endpoint did not return HTTP 200")

    final_url = response.geturl()
    if final_url != ZOTERO_STATUS_URL:
        raise InvalidZoteroStatusResponse("Status endpoint redirected")

    headers = response.headers
    if headers.get_content_type().lower() != "application/json":
        raise InvalidZoteroStatusResponse("Status response must be JSON")

    declared_length = headers.get("Content-Length")
    if declared_length is not None:
        try:
            content_length = int(declared_length, 10)
        except (TypeError, ValueError) as error:
            raise InvalidZoteroStatusResponse(
                "Status response has an invalid Content-Length"
            ) from error
        if content_length < 0 or content_length > MAX_STATUS_BODY_BYTES:
            raise InvalidZoteroStatusResponse("Status response is too large")

    body = response.read(MAX_STATUS_BODY_BYTES + 1)
    if not isinstance(body, bytes) or len(body) > MAX_STATUS_BODY_BYTES:
        raise InvalidZoteroStatusResponse("Status response is too large")

    try:
        text = body.decode("utf-8", errors="strict")
        document = json.loads(
            text,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_nonstandard_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise InvalidZoteroStatusResponse(
            "Status response is not valid JSON"
        ) from error

    return parse_zotero_status_document(document)


def _object_without_duplicate_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidZoteroStatusResponse("Status response has duplicate keys")
        result[key] = value
    return result


def _reject_nonstandard_json_constant(value: str) -> None:
    raise InvalidZoteroStatusResponse(
        f"Status response contains unsupported JSON constant {value}"
    )


def _read_boolean(payload: dict[object, object], key: str) -> bool:
    value = payload.get(key, _MISSING)
    if type(value) is not bool:
        raise InvalidZoteroStatusResponse(f"{key} must be a boolean")
    return value


def _read_count(payload: dict[object, object]) -> int:
    value = payload.get("count", _MISSING)
    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise InvalidZoteroStatusResponse("count must be a nonnegative safe integer")
    return value


def _read_zotero_version(payload: dict[object, object]) -> str:
    value = payload.get("zoteroVersion", _MISSING)
    if type(value) is not str or _ZOTERO_VERSION_PATTERN.fullmatch(value) is None:
        raise InvalidZoteroStatusResponse(
            "zoteroVersion must be a short version string"
        )
    return value


def _read_plugin_version(payload: dict[object, object]) -> str:
    value = payload.get("pluginVersion", _MISSING)
    if type(value) is not str or not value.startswith(_PLUGIN_VERSION_PREFIX):
        raise InvalidZoteroStatusResponse(
            "pluginVersion must identify Zotero Gemini Notebook"
        )

    semver = value[len(_PLUGIN_VERSION_PREFIX) :]
    if (
        not semver
        or len(semver) > _MAX_PLUGIN_SEMVER_LENGTH
        or _PLUGIN_SEMVER_PATTERN.fullmatch(semver) is None
    ):
        raise InvalidZoteroStatusResponse(
            "pluginVersion must contain a bounded semantic version"
        )
    return value


def _empty_status(
    status: Literal["unavailable", "invalid_response", "internal_error"],
) -> ZoteroBridgeStatus:
    return ZoteroBridgeStatus(
        status=status,
        mcpOptedIn=None,
        hasStagedSources=None,
        stagedSourceCount=None,
        zoteroVersion=None,
        pluginVersion=None,
    )
