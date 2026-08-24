"""Stage one narrow, authenticated Zotero-to-Gemini import job.

The public operation creates only a Zotero staging job. It does not claim that
Chrome created a Gemini Notebook or uploaded any source. Stable Zotero keys are
sent only after the fixed authentication check proves that the live loopback
server possesses the user's private local bridge key.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal

from zotero_control import (
    AUTH_RESPONSE_SIGNATURE_HEADER,
    AUTH_VERSION,
    CONTROL_API_VERSION,
    CONTROL_TIMEOUT_SECONDS,
    InvalidControlResponse,
    InvalidLocalBridgeKey,
    _NoRedirectHandler,
    build_control_auth_canonical,
    check_zotero_control_authentication,
    read_local_bridge_key,
    verify_control_response_signature,
)

CONTROL_JOB_PATH = "/notebooklm/control/v1/jobs"
CONTROL_JOB_URL = f"http://127.0.0.1:23119{CONTROL_JOB_PATH}"
CONTROL_JOB_CONTENT_TYPE = "application/vnd.zotero-gemini-notebook.job+json"
MAX_JOB_BODY_BYTES = 16 * 1024
MAX_JOB_RESPONSE_BYTES = 16 * 1024

_SAFE_INTEGER_MAX = 2**53 - 1
MAX_ITEM_KEYS = 256
_REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_ZOTERO_KEY_PATTERN = re.compile(r"[A-Za-z0-9]{8}\Z")
_JOB_ID_PATTERN = re.compile(
    r"(?:[0-9A-Fa-f]{32}|"
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12})\Z"
)

BridgeJobState = Literal[
    "staged",
    "claimed",
    "submitted",
    "verifying",
    "verified",
    "unverified",
    "failed",
    "cancelled",
    "expired",
    "superseded",
]
JobResultStatus = Literal[
    "ok",
    "invalid_request",
    "key_unavailable",
    "control_disabled",
    "authentication_failed",
    "temporarily_unavailable",
    "unsupported",
    "unavailable",
    "invalid_response",
    "library_not_found",
    "collection_not_found",
    "no_supported_attachments",
    "pending_job_exists",
    "idempotency_conflict",
    "source_limit_exceeded",
    "internal_error",
]


@dataclass(frozen=True)
class ZoteroImportJobResult:
    """The complete allowlist returned by the staging MCP tool."""

    status: JobResultStatus
    jobId: str | None
    state: BridgeJobState | None
    itemCount: int | None
    skippedCount: int | None
    createdAt: int | None
    updatedAt: int | None
    expiresAt: int | None
    message: str | None
    retryable: bool


class InvalidZoteroJobInput(ValueError):
    """Raised when a staging request is outside the public allowlist."""


class InvalidZoteroJobResponse(ValueError):
    """Raised when the job endpoint returns an invalid document."""


@dataclass(frozen=True)
class _FailureDefinition:
    message: str
    retryable: bool
    http_statuses: frozenset[int]


_FAILURES: dict[str, _FailureDefinition] = {
    "invalid_request": _FailureDefinition(
        "The Zotero import-job request is invalid.", False, frozenset({400})
    ),
    "key_unavailable": _FailureDefinition(
        "Zotero's local MCP connection is unavailable.", False, frozenset()
    ),
    "control_disabled": _FailureDefinition(
        "MCP support is disabled in Zotero.", False, frozenset({403})
    ),
    "authentication_failed": _FailureDefinition(
        "Zotero's local MCP connection could not be authenticated.",
        False,
        frozenset({403}),
    ),
    "temporarily_unavailable": _FailureDefinition(
        "Zotero's MCP control endpoint is temporarily unavailable.",
        True,
        frozenset({503}),
    ),
    "unsupported": _FailureDefinition(
        "The installed Zotero plugin does not support import jobs.",
        False,
        frozenset({404}),
    ),
    "unavailable": _FailureDefinition(
        "Zotero is unavailable on the local connector port.",
        True,
        frozenset(),
    ),
    "invalid_response": _FailureDefinition(
        "Zotero returned an invalid import-job response.",
        False,
        frozenset(),
    ),
    "library_not_found": _FailureDefinition(
        "The requested Zotero library was not found.", False, frozenset({404})
    ),
    "collection_not_found": _FailureDefinition(
        "The requested Zotero collection was not found.",
        False,
        frozenset({404}),
    ),
    "no_supported_attachments": _FailureDefinition(
        "No supported local attachments were found for the requested sources.",
        False,
        frozenset({400}),
    ),
    "pending_job_exists": _FailureDefinition(
        "A Zotero import job is already staged.", False, frozenset({409})
    ),
    "idempotency_conflict": _FailureDefinition(
        "The request ID was already used for a different import job.",
        False,
        frozenset({409}),
    ),
    "source_limit_exceeded": _FailureDefinition(
        "The requested import exceeds the connector's source limit.",
        False,
        frozenset({400}),
    ),
    "internal_error": _FailureDefinition(
        "The Zotero import job could not be staged because of an internal error.",
        True,
        frozenset({500}),
    ),
}

_PREFLIGHT_FAILURES = frozenset(
    {
        "key_unavailable",
        "control_disabled",
        "authentication_failed",
        "temporarily_unavailable",
        "unsupported",
        "unavailable",
        "invalid_response",
    }
)
_JOB_STATES = frozenset(BridgeJobState.__args__)


def stage_zotero_import_job(
    *,
    request_id: str,
    library_id: int,
    item_keys: list[str] | None = None,
    collection_key: str | None = None,
    recursive: bool = False,
) -> ZoteroImportJobResult:
    """Validate, authenticate, and stage one idempotent import job."""

    try:
        body = create_stage_job_body(
            request_id=request_id,
            library_id=library_id,
            item_keys=item_keys,
            collection_key=collection_key,
            recursive=recursive,
        )
    except InvalidZoteroJobInput:
        return create_job_failure("invalid_request")

    # This preflight is a privacy boundary, not just a health check. Do not send
    # stable library, collection, or item keys until the fixed-port server has
    # returned a request-bound proof of the private local key.
    try:
        preflight = check_zotero_control_authentication()
    except Exception:
        return create_job_failure("internal_error")
    if preflight != "authenticated":
        status = preflight if preflight in _PREFLIGHT_FAILURES else "invalid_response"
        return create_job_failure(status)

    try:
        key = read_local_bridge_key()
    except InvalidLocalBridgeKey:
        return create_job_failure("key_unavailable")

    timestamp = int(time.time())
    nonce = _encode_base64url(secrets.token_bytes(16))
    try:
        request = create_stage_job_request(
            key,
            body,
            timestamp=timestamp,
            nonce=nonce,
        )
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirectHandler(),
        )
        with opener.open(request, timeout=CONTROL_TIMEOUT_SECONDS) as response:
            response_body = _read_job_response_body(response, expected_status=200)
            verify_control_response_signature(
                key,
                timestamp=timestamp,
                nonce=nonce,
                method="POST",
                pathname=CONTROL_JOB_PATH,
                status=200,
                body=response_body,
                headers=response.headers,
            )
            return parse_stage_job_success(_parse_json_body(response_body))
    except urllib.error.HTTPError as error:
        return _map_job_http_error(error)
    except (
        InvalidControlResponse,
        InvalidZoteroJobResponse,
        TypeError,
        ValueError,
    ):
        return create_job_failure("invalid_response")
    except (http.client.HTTPException, OSError):
        return create_job_failure("unavailable")


def create_internal_error_job_result() -> ZoteroImportJobResult:
    """Return a fixed adapter-owned error without exception details."""

    return create_job_failure("internal_error")


def create_stage_job_body(
    *,
    request_id: str,
    library_id: int,
    item_keys: list[str] | None = None,
    collection_key: str | None = None,
    recursive: bool = False,
) -> bytes:
    """Build the exact compact, sort-key canonical job request body."""

    if (
        type(request_id) is not str
        or _REQUEST_ID_PATTERN.fullmatch(request_id) is None
    ):
        raise InvalidZoteroJobInput(
            "request_id must use 1 to 128 safe ASCII characters"
        )
    if (
        type(library_id) is not int
        or library_id < 1
        or library_id > _SAFE_INTEGER_MAX
    ):
        raise InvalidZoteroJobInput("library_id must be a positive safe integer")
    if type(recursive) is not bool:
        raise InvalidZoteroJobInput("recursive must be a boolean")

    has_item_keys = item_keys is not None
    has_collection_key = collection_key is not None
    if has_item_keys == has_collection_key:
        raise InvalidZoteroJobInput(
            "Provide exactly one Zotero source selector"
        )

    document: dict[str, object] = {
        "destination": "new",
        "libraryID": library_id,
        "replace": False,
        "requestId": request_id,
    }
    if has_item_keys:
        if recursive:
            raise InvalidZoteroJobInput(
                "recursive is only valid with collection_key"
            )
        if (
            type(item_keys) is not list
            or not item_keys
            or len(item_keys) > MAX_ITEM_KEYS
        ):
            raise InvalidZoteroJobInput(
                f"item_keys must contain 1 to {MAX_ITEM_KEYS} keys"
            )
        normalized_keys = [_normalize_zotero_key(key) for key in item_keys]
        if len(set(normalized_keys)) != len(normalized_keys):
            raise InvalidZoteroJobInput("item_keys must not contain duplicates")
        document["itemKeys"] = sorted(normalized_keys)
    else:
        document["collectionKey"] = _normalize_zotero_key(collection_key)
        document["recursive"] = recursive

    try:
        body = json.dumps(
            document,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeError):
        raise InvalidZoteroJobInput("The job request is not encodable") from None
    if len(body) > MAX_JOB_BODY_BYTES:
        raise InvalidZoteroJobInput("The job request is too large")
    return body


def create_stage_job_request(
    key: bytes,
    body: bytes,
    *,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> urllib.request.Request:
    """Create the fixed authenticated job POST without transmitting the key."""

    if type(key) is not bytes or len(key) != 32:
        raise InvalidLocalBridgeKey("Local bridge key has an invalid size")
    if type(body) is not bytes or not body or len(body) > MAX_JOB_BODY_BYTES:
        raise InvalidZoteroJobInput("The job request body is invalid")
    if timestamp is None:
        timestamp = int(time.time())
    if nonce is None:
        nonce = _encode_base64url(secrets.token_bytes(16))

    body_sha256 = hashlib.sha256(body).hexdigest()
    canonical = build_control_auth_canonical(
        timestamp=timestamp,
        nonce=nonce,
        method="POST",
        pathname=CONTROL_JOB_PATH,
        content_type=CONTROL_JOB_CONTENT_TYPE,
        body_sha256=body_sha256,
    )
    signature = _encode_base64url(hmac.digest(key, canonical, "sha256"))
    return urllib.request.Request(
        CONTROL_JOB_URL,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": CONTROL_JOB_CONTENT_TYPE,
            "Content-Length": str(len(body)),
            "X-ZGN-Auth-Version": AUTH_VERSION,
            "X-ZGN-Timestamp": str(timestamp),
            "X-ZGN-Nonce": nonce,
            "X-ZGN-Signature": signature,
        },
        method="POST",
    )


def parse_stage_job_success(document: object) -> ZoteroImportJobResult:
    """Validate the exact successful control DTO and make a public result."""

    if (
        type(document) is not dict
        or set(document) != {"apiVersion", "job"}
        or type(document.get("apiVersion")) is not int
        or document["apiVersion"] != CONTROL_API_VERSION
    ):
        raise InvalidZoteroJobResponse("The job response envelope is invalid")
    job = document.get("job")
    expected_keys = {
        "jobId",
        "state",
        "itemCount",
        "skippedCount",
        "createdAt",
        "updatedAt",
        "expiresAt",
    }
    if type(job) is not dict or set(job) != expected_keys:
        raise InvalidZoteroJobResponse("The job response fields are invalid")

    job_id = job.get("jobId")
    state = job.get("state")
    item_count = _read_safe_integer(job, "itemCount", minimum=1)
    skipped_count = _read_safe_integer(job, "skippedCount", minimum=0)
    created_at = _read_safe_integer(job, "createdAt", minimum=0)
    updated_at = _read_safe_integer(job, "updatedAt", minimum=created_at)
    expires_at_value = job.get("expiresAt")
    if expires_at_value is None:
        expires_at = None
    elif (
        type(expires_at_value) is int
        and created_at <= expires_at_value <= _SAFE_INTEGER_MAX
    ):
        expires_at = expires_at_value
    else:
        raise InvalidZoteroJobResponse("expiresAt is invalid")

    if type(job_id) is not str or _JOB_ID_PATTERN.fullmatch(job_id) is None:
        raise InvalidZoteroJobResponse("jobId is invalid")
    if type(state) is not str or state not in _JOB_STATES:
        raise InvalidZoteroJobResponse("state is invalid")

    return ZoteroImportJobResult(
        status="ok",
        jobId=job_id,
        state=state,
        itemCount=item_count,
        skippedCount=skipped_count,
        createdAt=created_at,
        updatedAt=updated_at,
        expiresAt=expires_at,
        message=None,
        retryable=False,
    )


def create_job_failure(status: str) -> ZoteroImportJobResult:
    """Build one fixed failure without carrying remote or exception text."""

    definition = _FAILURES.get(status)
    if definition is None or status == "ok":
        definition = _FAILURES["internal_error"]
        status = "internal_error"
    return ZoteroImportJobResult(
        status=status,  # type: ignore[arg-type]
        jobId=None,
        state=None,
        itemCount=None,
        skippedCount=None,
        createdAt=None,
        updatedAt=None,
        expiresAt=None,
        message=definition.message,
        retryable=definition.retryable,
    )


def _map_job_http_error(error: urllib.error.HTTPError) -> ZoteroImportJobResult:
    if error.code == 404 and not _is_json_response(error):
        return create_job_failure("unsupported")
    definition: _FailureDefinition
    try:
        with error:
            body = _read_job_response_body(error, expected_status=error.code)
            document = _parse_json_body(body)
        code, retryable = _read_error_document(document)
        definition = _FAILURES[code]
        if (
            error.code not in definition.http_statuses
            or retryable is not definition.retryable
        ):
            raise InvalidZoteroJobResponse("The job error mapping is invalid")
    except (KeyError, InvalidZoteroJobResponse):
        return create_job_failure("invalid_response")
    return create_job_failure(code)


def _read_error_document(document: object) -> tuple[str, bool]:
    if (
        type(document) is not dict
        or set(document) != {"apiVersion", "error"}
        or type(document.get("apiVersion")) is not int
        or document["apiVersion"] != CONTROL_API_VERSION
    ):
        raise InvalidZoteroJobResponse("The job error envelope is invalid")
    error = document.get("error")
    if (
        type(error) is not dict
        or set(error) != {"code", "message", "retryable"}
        or type(error.get("code")) is not str
        or type(error.get("message")) is not str
        or not error["message"]
        or len(error["message"]) > 256
        or type(error.get("retryable")) is not bool
    ):
        raise InvalidZoteroJobResponse("The job error fields are invalid")
    return error["code"], error["retryable"]


def _read_job_response_body(response: object, *, expected_status: int) -> bytes:
    status = getattr(response, "status", None)
    if status is None:
        status = response.getcode()
    if status != expected_status:
        raise InvalidZoteroJobResponse("The job endpoint returned a bad status")
    if response.geturl() != CONTROL_JOB_URL:
        raise InvalidZoteroJobResponse("The job endpoint redirected")

    headers = response.headers
    if headers.get_content_type().lower() != "application/json":
        raise InvalidZoteroJobResponse("The job response is not JSON")
    content_encoding = headers.get("Content-Encoding")
    if content_encoding not in (None, "", "identity"):
        raise InvalidZoteroJobResponse("The job response encoding is unsupported")
    declared_length = headers.get("Content-Length")
    if declared_length is not None:
        if type(declared_length) is not str or re.fullmatch(
            r"[0-9]+", declared_length
        ) is None:
            raise InvalidZoteroJobResponse("The job response length is invalid")
        if int(declared_length, 10) > MAX_JOB_RESPONSE_BYTES:
            raise InvalidZoteroJobResponse("The job response is too large")

    body = response.read(MAX_JOB_RESPONSE_BYTES + 1)
    if not isinstance(body, bytes) or len(body) > MAX_JOB_RESPONSE_BYTES:
        raise InvalidZoteroJobResponse("The job response is too large")
    return body


def _parse_json_body(body: bytes) -> object:
    try:
        return json.loads(
            body.decode("utf-8", errors="strict"),
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_nonstandard_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        raise InvalidZoteroJobResponse("The job response is not strict JSON") from None


def _object_without_duplicate_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("The job response has duplicate keys")
        result[key] = value
    return result


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError("The job response has a nonstandard JSON constant")


def _read_safe_integer(
    document: dict[str, object],
    key: str,
    *,
    minimum: int,
) -> int:
    value = document.get(key)
    if type(value) is not int or value < minimum or value > _SAFE_INTEGER_MAX:
        raise InvalidZoteroJobResponse(f"{key} is invalid")
    return value


def _normalize_zotero_key(value: object) -> str:
    if type(value) is not str or _ZOTERO_KEY_PATTERN.fullmatch(value) is None:
        raise InvalidZoteroJobInput(
            "Zotero object keys must be eight alphanumeric characters"
        )
    return value.upper()


def _is_json_response(response: object) -> bool:
    try:
        return response.headers.get_content_type().lower() == "application/json"
    except (AttributeError, TypeError, ValueError):
        return False


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
