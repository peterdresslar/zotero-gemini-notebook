"""Internal authentication for the narrow Zotero loopback control boundary.

This module is transport infrastructure, not an MCP tool. It reads one fixed
user-private key and can prove possession only to the fixed authentication-check
endpoint. It does not discover profiles, accept alternate paths, or expose key
material in a result.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import stat
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Literal

CONTROL_API_VERSION = 1
CONTROL_AUTH_CHECK_PATH = "/notebooklm/control/v1/auth-check"
CONTROL_AUTH_CHECK_URL = f"http://127.0.0.1:23119{CONTROL_AUTH_CHECK_PATH}"
CONTROL_TIMEOUT_SECONDS = 2.0
MAX_CONTROL_BODY_BYTES = 16 * 1024

AUTH_VERSION = "1"
AUTH_CANONICAL_PREFIX = "ZGN-LOCAL-AUTH-V1"
AUTH_RESPONSE_CANONICAL_PREFIX = "ZGN-LOCAL-AUTH-RESPONSE-V1"
AUTH_RESPONSE_SIGNATURE_HEADER = "X-ZGN-Response-Signature"
AUTH_CONTENT_TYPE = "application/json"
AUTH_BODY = b"{}"

LOCAL_BRIDGE_KEY_BYTES = 32
LOCAL_BRIDGE_KEY_FILENAME = "local-bridge.key"
_SAFE_INTEGER_MAX = 2**53 - 1
_MAX_AUTH_TIMESTAMP = 999_999_999_999
_BASE64URL_PATTERN = re.compile(r"[A-Za-z0-9_-]+\Z")

ControlAuthState = Literal[
    "authenticated",
    "key_unavailable",
    "control_disabled",
    "authentication_failed",
    "temporarily_unavailable",
    "unsupported",
    "unavailable",
    "invalid_response",
]


class InvalidLocalBridgeKey(ValueError):
    """Raised when the one fixed local key is absent or unsafe to read."""


class InvalidControlResponse(ValueError):
    """Raised when the fixed control endpoint returns an invalid response."""


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


def check_zotero_control_authentication() -> ControlAuthState:
    """Run the fixed auth check and return only a sanitized internal state."""

    try:
        key = read_local_bridge_key()
    except InvalidLocalBridgeKey:
        return "key_unavailable"

    timestamp = int(time.time())
    nonce = _encode_base64url(secrets.token_bytes(16))
    request = create_auth_check_request(key, timestamp=timestamp, nonce=nonce)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _NoRedirectHandler(),
    )
    try:
        with opener.open(request, timeout=CONTROL_TIMEOUT_SECONDS) as response:
            response_body = _read_response_body(
                response,
                expected_status=200,
            )
            verify_auth_response_signature(
                key,
                timestamp=timestamp,
                nonce=nonce,
                status=200,
                body=response_body,
                headers=response.headers,
            )
            document = _parse_json_body(response_body)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return "unsupported"
        if error.code not in (403, 503):
            return "invalid_response"
        try:
            with error:
                error_body = _read_response_body(
                    error,
                    expected_status=error.code,
                )
                document = _parse_json_body(error_body)
            error_code, retryable = _read_control_error(document)
        except InvalidControlResponse:
            return "invalid_response"

        if error.code == 403 and not retryable:
            if error_code == "control_disabled":
                return "control_disabled"
            if error_code == "authentication_failed":
                return "authentication_failed"
        if (
            error.code == 503
            and retryable
            and error_code == "temporarily_unavailable"
        ):
            return "temporarily_unavailable"
        return "invalid_response"
    except InvalidControlResponse:
        return "invalid_response"
    except (http.client.HTTPException, OSError):
        return "unavailable"

    if (
        type(document) is not dict
        or set(document) != {"apiVersion", "authenticated"}
        or type(document.get("apiVersion")) is not int
        or document["apiVersion"] != CONTROL_API_VERSION
        or document.get("authenticated") is not True
    ):
        return "invalid_response"
    return "authenticated"


def read_local_bridge_key() -> bytes:
    """Read exactly the fixed raw 32-byte key from private user storage."""

    private_root = _home_directory() / ".zotero-gemini-notebook"
    mcp_root = private_root / "mcp"
    for directory in (private_root, mcp_root):
        _validate_private_directory(directory)

    path = mcp_root / LOCAL_BRIDGE_KEY_FILENAME
    try:
        before = path.lstat()
    except OSError:
        raise InvalidLocalBridgeKey("Local bridge key is unavailable") from None
    _validate_key_metadata(before)

    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise InvalidLocalBridgeKey("Local bridge key is unavailable") from None
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise InvalidLocalBridgeKey("Local bridge key changed while opening")
        _validate_key_metadata(opened)

        chunks: list[bytes] = []
        remaining = LOCAL_BRIDGE_KEY_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        body = b"".join(chunks)
        if len(body) != LOCAL_BRIDGE_KEY_BYTES:
            raise InvalidLocalBridgeKey("Local bridge key has an invalid size")
    finally:
        os.close(descriptor)

    return body


def build_auth_canonical(
    *,
    timestamp: int,
    nonce: str,
    method: str = "POST",
    pathname: str = CONTROL_AUTH_CHECK_PATH,
    content_type: str = AUTH_CONTENT_TYPE,
    body_sha256: str | None = None,
) -> bytes:
    """Build the exact LF-delimited payload authenticated by the local key."""

    if method != "POST" or pathname != CONTROL_AUTH_CHECK_PATH:
        raise ValueError("Authentication target is fixed")
    if content_type != AUTH_CONTENT_TYPE:
        raise ValueError("Authentication content type is fixed")
    if body_sha256 is None:
        body_sha256 = hashlib.sha256(AUTH_BODY).hexdigest()
    return build_control_auth_canonical(
        timestamp=timestamp,
        nonce=nonce,
        method=method,
        pathname=pathname,
        content_type=content_type,
        body_sha256=body_sha256,
    )


def build_control_auth_canonical(
    *,
    timestamp: int,
    nonce: str,
    method: str,
    pathname: str,
    content_type: str,
    body_sha256: str,
) -> bytes:
    """Build the shared authenticated-control request canonical form.

    Endpoint modules remain responsible for passing fixed method, path, and
    media-type constants. This helper rejects ambiguous fields but does not
    turn any caller-controlled URL into an allowed target.
    """

    _validate_control_canonical_fields(
        timestamp=timestamp,
        nonce=nonce,
        method=method,
        pathname=pathname,
        body_sha256=body_sha256,
    )
    if (
        type(content_type) is not str
        or not content_type
        or "\n" in content_type
        or "\r" in content_type
    ):
        raise ValueError("content_type is invalid")

    return "\n".join(
        (
            AUTH_CANONICAL_PREFIX,
            str(timestamp),
            nonce,
            method,
            pathname,
            content_type,
            body_sha256,
        )
    ).encode("ascii")


def build_auth_response_canonical(
    *,
    timestamp: int,
    nonce: str,
    method: str = "POST",
    pathname: str = CONTROL_AUTH_CHECK_PATH,
    status: int = 200,
    body_sha256: str,
) -> bytes:
    """Build the exact server proof bound to one authenticated request."""

    if method != "POST" or pathname != CONTROL_AUTH_CHECK_PATH:
        raise ValueError("Authentication response target is fixed")
    if status != 200:
        raise ValueError("Authentication response status is fixed")
    return build_control_auth_response_canonical(
        timestamp=timestamp,
        nonce=nonce,
        method=method,
        pathname=pathname,
        status=status,
        body_sha256=body_sha256,
    )


def build_control_auth_response_canonical(
    *,
    timestamp: int,
    nonce: str,
    method: str,
    pathname: str,
    status: int,
    body_sha256: str,
) -> bytes:
    """Build the shared request-bound control-response canonical form."""

    _validate_control_canonical_fields(
        timestamp=timestamp,
        nonce=nonce,
        method=method,
        pathname=pathname,
        body_sha256=body_sha256,
    )
    if type(status) is not int or status < 100 or status > 599:
        raise ValueError("status must be a valid HTTP status")

    return "\n".join(
        (
            AUTH_RESPONSE_CANONICAL_PREFIX,
            str(timestamp),
            nonce,
            method,
            pathname,
            str(status),
            body_sha256,
        )
    ).encode("ascii")


def verify_auth_response_signature(
    key: bytes,
    *,
    timestamp: int,
    nonce: str,
    status: int,
    body: bytes,
    headers: object,
) -> None:
    """Require Zotero to prove possession of the local key for this response."""

    if status != 200:
        raise InvalidControlResponse("Control response proof is invalid")
    verify_control_response_signature(
        key,
        timestamp=timestamp,
        nonce=nonce,
        method="POST",
        pathname=CONTROL_AUTH_CHECK_PATH,
        status=status,
        body=body,
        headers=headers,
    )


def verify_control_response_signature(
    key: bytes,
    *,
    timestamp: int,
    nonce: str,
    method: str,
    pathname: str,
    status: int,
    body: bytes,
    headers: object,
) -> None:
    """Verify a response proof for one fixed control-module request."""

    if type(key) is not bytes or len(key) != LOCAL_BRIDGE_KEY_BYTES:
        raise InvalidControlResponse("Local bridge key is invalid")
    if type(body) is not bytes:
        raise InvalidControlResponse("Control response body is invalid")
    signature_text = _read_single_header(
        headers,
        AUTH_RESPONSE_SIGNATURE_HEADER,
    )
    try:
        signature = _decode_fixed_signature(signature_text)
        canonical = build_control_auth_response_canonical(
            timestamp=timestamp,
            nonce=nonce,
            method=method,
            pathname=pathname,
            status=status,
            body_sha256=hashlib.sha256(body).hexdigest(),
        )
    except (TypeError, ValueError):
        raise InvalidControlResponse("Control response proof is invalid") from None

    expected = hmac.digest(key, canonical, "sha256")
    if not hmac.compare_digest(expected, signature):
        raise InvalidControlResponse("Control response proof is invalid")


def _validate_control_canonical_fields(
    *,
    timestamp: int,
    nonce: str,
    method: str,
    pathname: str,
    body_sha256: str,
) -> None:
    if (
        type(timestamp) is not int
        or timestamp < 0
        or timestamp > _MAX_AUTH_TIMESTAMP
    ):
        raise ValueError("timestamp must be a nonnegative safe integer")
    _decode_fixed_nonce(nonce)
    if type(method) is not str or re.fullmatch(r"[A-Z]+", method) is None:
        raise ValueError("method must use uppercase ASCII letters")
    if (
        type(pathname) is not str
        or not pathname.startswith("/")
        or "?" in pathname
        or "#" in pathname
        or "\n" in pathname
        or "\r" in pathname
    ):
        raise ValueError("pathname is invalid")
    if type(body_sha256) is not str or re.fullmatch(
        r"[0-9a-f]{64}", body_sha256
    ) is None:
        raise ValueError("body_sha256 must be lowercase SHA-256 hex")


def create_auth_check_request(
    key: bytes,
    *,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> urllib.request.Request:
    """Create the one fixed authenticated request without transmitting the key."""

    if type(key) is not bytes or len(key) != LOCAL_BRIDGE_KEY_BYTES:
        raise InvalidLocalBridgeKey("Local bridge key has an invalid size")
    if timestamp is None:
        timestamp = int(time.time())
    if nonce is None:
        nonce = _encode_base64url(secrets.token_bytes(16))

    body_sha256 = hashlib.sha256(AUTH_BODY).hexdigest()
    canonical = build_auth_canonical(
        timestamp=timestamp,
        nonce=nonce,
        body_sha256=body_sha256,
    )
    signature = _encode_base64url(hmac.digest(key, canonical, "sha256"))

    return urllib.request.Request(
        CONTROL_AUTH_CHECK_URL,
        data=AUTH_BODY,
        headers={
            "Accept": "application/json",
            "Content-Type": AUTH_CONTENT_TYPE,
            "Content-Length": str(len(AUTH_BODY)),
            "X-ZGN-Auth-Version": AUTH_VERSION,
            "X-ZGN-Timestamp": str(timestamp),
            "X-ZGN-Nonce": nonce,
            "X-ZGN-Signature": signature,
        },
        method="POST",
    )


def _validate_private_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        raise InvalidLocalBridgeKey("Local bridge directory is unavailable") from None
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise InvalidLocalBridgeKey("Local bridge directory is invalid")
    if os.name == "posix":
        if stat.S_IMODE(metadata.st_mode) != 0o700:
            raise InvalidLocalBridgeKey("Local bridge directory permissions are unsafe")
        if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
            raise InvalidLocalBridgeKey("Local bridge directory owner is unsafe")


def _validate_key_metadata(metadata: os.stat_result) -> None:
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise InvalidLocalBridgeKey("Local bridge key must be a regular file")
    if metadata.st_size != LOCAL_BRIDGE_KEY_BYTES or metadata.st_nlink != 1:
        raise InvalidLocalBridgeKey("Local bridge key is not private")
    if os.name == "posix":
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise InvalidLocalBridgeKey("Local bridge key permissions are unsafe")
        if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
            raise InvalidLocalBridgeKey("Local bridge key owner is unsafe")


def _read_control_error(document: object) -> tuple[str, bool]:
    if (
        type(document) is not dict
        or set(document) != {"apiVersion", "error"}
        or type(document.get("apiVersion")) is not int
        or document["apiVersion"] != CONTROL_API_VERSION
    ):
        raise InvalidControlResponse("Control error envelope is invalid")
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
        raise InvalidControlResponse("Control error envelope is invalid")
    return error["code"], error["retryable"]


def _read_response_body(
    response: object,
    *,
    expected_status: int,
) -> bytes:
    status_code = getattr(response, "status", None)
    if status_code is None:
        status_code = response.getcode()
    if status_code != expected_status:
        raise InvalidControlResponse("Control endpoint returned an invalid status")
    if response.geturl() != CONTROL_AUTH_CHECK_URL:
        raise InvalidControlResponse("Control endpoint redirected")

    headers = response.headers
    if headers.get_content_type().lower() != "application/json":
        raise InvalidControlResponse("Control response must be JSON")
    content_encoding = headers.get("Content-Encoding")
    if content_encoding not in (None, "", "identity"):
        raise InvalidControlResponse("Control response encoding is unsupported")
    declared_length = _read_declared_length(headers.get("Content-Length"))
    if declared_length is not None and declared_length > MAX_CONTROL_BODY_BYTES:
        raise InvalidControlResponse("Control response is too large")

    body = response.read(MAX_CONTROL_BODY_BYTES + 1)
    if not isinstance(body, bytes) or len(body) > MAX_CONTROL_BODY_BYTES:
        raise InvalidControlResponse("Control response is too large")
    return body


def _parse_json_body(body: bytes) -> object:
    try:
        text = body.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_nonstandard_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        raise InvalidControlResponse("Control response is not strict JSON") from None


def _object_without_duplicate_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Control response has duplicate keys")
        result[key] = value
    return result


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError("Control response has a nonstandard JSON constant")


def _read_declared_length(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is not str or re.fullmatch(r"[0-9]+", value) is None:
        raise InvalidControlResponse("Control response length is invalid")
    length = int(value, 10)
    if length > _SAFE_INTEGER_MAX:
        raise InvalidControlResponse("Control response length is invalid")
    return length


def _read_single_header(headers: object, name: str) -> str:
    try:
        items = list(headers.items())
    except (AttributeError, TypeError, ValueError):
        raise InvalidControlResponse("Control response headers are invalid") from None
    matches = [
        value
        for candidate, value in items
        if isinstance(candidate, str) and candidate.lower() == name.lower()
    ]
    if len(matches) != 1 or type(matches[0]) is not str:
        raise InvalidControlResponse("Control response proof is invalid")
    return matches[0]


def _decode_fixed_signature(value: str) -> bytes:
    if (
        type(value) is not str
        or re.fullmatch(r"[A-Za-z0-9_-]{43}", value) is None
    ):
        raise ValueError("signature is invalid")
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (TypeError, ValueError, binascii.Error):
        raise ValueError("signature is invalid") from None
    if len(decoded) != 32 or _encode_base64url(decoded) != value:
        raise ValueError("signature is invalid")
    return decoded


def _decode_fixed_nonce(value: object) -> bytes:
    if (
        type(value) is not str
        or len(value) != 22
        or _BASE64URL_PATTERN.fullmatch(value) is None
    ):
        raise ValueError("nonce must encode exactly 16 bytes")
    try:
        decoded = base64.b64decode(
            value + "==",
            altchars=b"-_",
            validate=True,
        )
    except (TypeError, ValueError):
        raise ValueError("nonce must be canonical base64url") from None
    if len(decoded) != 16 or _encode_base64url(decoded) != value:
        raise ValueError("nonce must be canonical base64url")
    return decoded


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _home_directory() -> Path:
    return Path.home()
