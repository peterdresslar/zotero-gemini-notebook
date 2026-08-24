from __future__ import annotations

import base64
import hmac
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))

import zotero_control
from zotero_control import (
    AUTH_BODY,
    AUTH_CONTENT_TYPE,
    AUTH_RESPONSE_SIGNATURE_HEADER,
    CONTROL_AUTH_CHECK_PATH,
    CONTROL_AUTH_CHECK_URL,
    CONTROL_TIMEOUT_SECONDS,
    InvalidLocalBridgeKey,
    build_auth_canonical,
    build_auth_response_canonical,
    check_zotero_control_authentication,
    create_auth_check_request,
    read_local_bridge_key,
    verify_auth_response_signature,
)

KEY = bytes(range(32))
TIMESTAMP = 1_787_558_400
NONCE_BYTES = bytes(range(16))
NONCE = "AAECAwQFBgcICQoLDA0ODw"
BODY_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
SIGNATURE = "IBgKEu-BEe213hse1WS9QLmFDlHZQsj5lpjdLMgUmEA"
RESPONSE_BODY = b'{"apiVersion":1,"authenticated":true}'
RESPONSE_BODY_SHA256 = (
    "9ffcda143f09709b95ac54dbba37b8893df5b6b7991f8cea01c69af9a7cb692c"
)
RESPONSE_SIGNATURE = "m6zXyLpSa25w2Q12Vf3htBaX0eNnqR-YLweKEMN3kZ8"


def write_key_tree(
    home: Path,
    *,
    key: bytes = KEY,
    file_mode: int = 0o600,
) -> Path:
    private_root = home / ".zotero-gemini-notebook"
    mcp_root = private_root / "mcp"
    for directory in (private_root, mcp_root):
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
    path = mcp_root / "local-bridge.key"
    path.write_bytes(key)
    path.chmod(file_mode)
    return path


class FakeHeaders(dict[str, str]):
    def get_content_type(self) -> str:
        return self.get("Content-Type", "text/plain").split(";", 1)[0].strip()


class FakeResponse:
    def __init__(
        self,
        document: object,
        *,
        url: str = CONTROL_AUTH_CHECK_URL,
        status: int = 200,
        content_type: str = "application/json",
        body: bytes | None = None,
        content_length: str | None = None,
        response_signature: str | None = None,
    ) -> None:
        self.status = status
        self._url = url
        self._body = (
            json.dumps(document, separators=(",", ":")).encode("utf-8")
            if body is None
            else body
        )
        response_headers = {
            "Content-Type": content_type,
            "Content-Length": (
                str(len(self._body))
                if content_length is None
                else content_length
            ),
        }
        if response_signature is not None:
            response_headers[AUTH_RESPONSE_SIGNATURE_HEADER] = response_signature
        self.headers = FakeHeaders(response_headers)
        self.read_limit: int | None = None

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def getcode(self) -> int:
        return self.status

    def read(self, limit: int) -> bytes:
        self.read_limit = limit
        return self._body[:limit]


class FakeHTTPError(urllib.error.HTTPError):
    def __init__(self, code: int, document: object) -> None:
        body = json.dumps(document, separators=(",", ":")).encode("utf-8")
        headers = FakeHeaders(
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            }
        )
        super().__init__(
            CONTROL_AUTH_CHECK_URL,
            code,
            "fixed test error",
            headers,
            io.BytesIO(body),
        )


class FakeOpener:
    def __init__(self, result: object) -> None:
        self.result = result
        self.requests: list[urllib.request.Request] = []
        self.timeouts: list[float] = []

    def open(
        self,
        request: urllib.request.Request,
        timeout: float,
    ) -> FakeResponse:
        self.requests.append(request)
        self.timeouts.append(timeout)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result  # type: ignore[return-value]


def error_document(code: str, *, retryable: bool) -> dict[str, object]:
    return {
        "apiVersion": 1,
        "error": {
            "code": code,
            "message": "Fixed local control failure.",
            "retryable": retryable,
        },
    }


class LocalBridgeKeyTests(unittest.TestCase):
    def test_reads_only_the_fixed_raw_32_byte_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            path = write_key_tree(home)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                result = read_local_bridge_key()

        self.assertEqual(result, KEY)
        self.assertEqual(path.name, "local-bridge.key")
        self.assertEqual(path.parent.name, "mcp")

    def test_rejects_missing_and_wrong_sized_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            for key in (b"", b"x" * 31, b"x" * 33):
                with self.subTest(size=len(key)):
                    write_key_tree(home, key=key)
                    with patch.object(
                        zotero_control,
                        "_home_directory",
                        return_value=home,
                    ):
                        with self.assertRaises(InvalidLocalBridgeKey):
                            read_local_bridge_key()

            (home / ".zotero-gemini-notebook" / "mcp" / "local-bridge.key").unlink()
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

    @unittest.skipUnless(os.name == "posix", "POSIX permission contract")
    def test_rejects_unsafe_file_mode_directory_mode_and_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            path = write_key_tree(home, file_mode=0o640)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

            path.chmod(0o600)
            path.parent.chmod(0o755)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

            path.parent.chmod(0o700)
            with (
                patch.object(zotero_control, "_home_directory", return_value=home),
                patch.object(
                    zotero_control.os,
                    "geteuid",
                    return_value=os.geteuid() + 1,
                ),
            ):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

    def test_rejects_symlinks_and_hardlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            path = write_key_tree(home)
            target = path.with_name("key-target")
            path.rename(target)
            path.symlink_to(target)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

            path.unlink()
            os.link(target, path)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()

    def test_rejects_symlinked_private_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "home"
            home.mkdir()
            target = Path(temp_dir) / "private-target"
            target.mkdir(mode=0o700)
            (home / ".zotero-gemini-notebook").symlink_to(target)
            with patch.object(zotero_control, "_home_directory", return_value=home):
                with self.assertRaises(InvalidLocalBridgeKey):
                    read_local_bridge_key()


class AuthenticationProofTests(unittest.TestCase):
    def test_builds_shared_canonical_vector_without_a_trailing_lf(self) -> None:
        canonical = build_auth_canonical(
            timestamp=TIMESTAMP,
            nonce=NONCE,
            body_sha256=BODY_SHA256,
        )

        self.assertEqual(
            canonical,
            (
                "ZGN-LOCAL-AUTH-V1\n"
                "1787558400\n"
                "AAECAwQFBgcICQoLDA0ODw\n"
                "POST\n"
                "/notebooklm/control/v1/auth-check\n"
                "application/json\n"
                "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
            ).encode("ascii"),
        )
        self.assertFalse(canonical.endswith(b"\n"))

    def test_builds_and_verifies_shared_response_proof_vector(self) -> None:
        canonical = build_auth_response_canonical(
            timestamp=TIMESTAMP,
            nonce=NONCE,
            body_sha256=RESPONSE_BODY_SHA256,
        )
        self.assertEqual(
            canonical,
            (
                "ZGN-LOCAL-AUTH-RESPONSE-V1\n"
                "1787558400\n"
                "AAECAwQFBgcICQoLDA0ODw\n"
                "POST\n"
                "/notebooklm/control/v1/auth-check\n"
                "200\n"
                "9ffcda143f09709b95ac54dbba37b8893df5b6b7991f8cea01c69af9a7cb692c"
            ).encode("ascii"),
        )
        self.assertEqual(
            base64.urlsafe_b64encode(hmac.digest(KEY, canonical, "sha256"))
            .rstrip(b"=")
            .decode("ascii"),
            RESPONSE_SIGNATURE,
        )
        verify_auth_response_signature(
            KEY,
            timestamp=TIMESTAMP,
            nonce=NONCE,
            status=200,
            body=RESPONSE_BODY,
            headers=FakeHeaders(
                {AUTH_RESPONSE_SIGNATURE_HEADER: RESPONSE_SIGNATURE}
            ),
        )

    def test_rejects_unsigned_malformed_and_mismatched_response_proofs(self) -> None:
        cases = (
            ({}, TIMESTAMP, NONCE, 200, RESPONSE_BODY),
            (
                {AUTH_RESPONSE_SIGNATURE_HEADER: "not-a-signature"},
                TIMESTAMP,
                NONCE,
                200,
                RESPONSE_BODY,
            ),
            (
                {AUTH_RESPONSE_SIGNATURE_HEADER: RESPONSE_SIGNATURE},
                TIMESTAMP + 1,
                NONCE,
                200,
                RESPONSE_BODY,
            ),
            (
                {AUTH_RESPONSE_SIGNATURE_HEADER: RESPONSE_SIGNATURE},
                TIMESTAMP,
                "AQECAwQFBgcICQoLDA0ODw",
                200,
                RESPONSE_BODY,
            ),
            (
                {AUTH_RESPONSE_SIGNATURE_HEADER: RESPONSE_SIGNATURE},
                TIMESTAMP,
                NONCE,
                201,
                RESPONSE_BODY,
            ),
            (
                {AUTH_RESPONSE_SIGNATURE_HEADER: RESPONSE_SIGNATURE},
                TIMESTAMP,
                NONCE,
                200,
                RESPONSE_BODY + b" ",
            ),
        )
        for headers, timestamp, nonce, status, body in cases:
            with self.subTest(headers=headers, timestamp=timestamp, status=status):
                with self.assertRaises(zotero_control.InvalidControlResponse):
                    verify_auth_response_signature(
                        KEY,
                        timestamp=timestamp,
                        nonce=nonce,
                        status=status,
                        body=body,
                        headers=FakeHeaders(headers),
                    )

    def test_builds_exact_fixed_hmac_request(self) -> None:
        request = create_auth_check_request(
            KEY,
            timestamp=TIMESTAMP,
            nonce=NONCE,
        )
        headers = {name.lower(): value for name, value in request.header_items()}

        self.assertEqual(request.full_url, CONTROL_AUTH_CHECK_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, AUTH_BODY)
        self.assertEqual(headers["accept"], "application/json")
        self.assertEqual(headers["content-type"], AUTH_CONTENT_TYPE)
        self.assertEqual(headers["content-length"], "2")
        self.assertEqual(headers["x-zgn-auth-version"], "1")
        self.assertEqual(headers["x-zgn-timestamp"], str(TIMESTAMP))
        self.assertEqual(headers["x-zgn-nonce"], NONCE)
        self.assertNotIn("x-zgn-body-sha256", headers)
        self.assertEqual(headers["x-zgn-signature"], SIGNATURE)
        self.assertEqual(len(base64.urlsafe_b64decode(SIGNATURE + "=")), 32)
        self.assertNotIn("x-zgn-credential-id", headers)
        self.assertNotIn("authorization", headers)
        self.assertNotIn("zotero-allowed-request", headers)

    def test_rejects_variable_targets_and_malformed_inputs(self) -> None:
        cases = (
            {"timestamp": True, "nonce": NONCE},
            {"timestamp": -1, "nonce": NONCE},
            {"timestamp": 1_000_000_000_000, "nonce": NONCE},
            {"timestamp": TIMESTAMP, "nonce": "short"},
            {"timestamp": TIMESTAMP, "nonce": NONCE, "method": "GET"},
            {"timestamp": TIMESTAMP, "nonce": NONCE, "pathname": "/other"},
            {"timestamp": TIMESTAMP, "nonce": NONCE, "content_type": "text/plain"},
            {"timestamp": TIMESTAMP, "nonce": NONCE, "body_sha256": "A" * 64},
        )
        for inputs in cases:
            with self.subTest(inputs=inputs):
                with self.assertRaises(ValueError):
                    build_auth_canonical(**inputs)  # type: ignore[arg-type]

        for key in (b"", b"x" * 31, b"x" * 33):
            with self.subTest(key_size=len(key)):
                with self.assertRaises(InvalidLocalBridgeKey):
                    create_auth_check_request(key, timestamp=TIMESTAMP, nonce=NONCE)


class ControlAuthenticationFlowTests(unittest.TestCase):
    def run_check(self, home: Path, result: object) -> tuple[str, FakeOpener]:
        opener = FakeOpener(result)
        with (
            patch.object(zotero_control, "_home_directory", return_value=home),
            patch.object(
                zotero_control.urllib.request,
                "build_opener",
                return_value=opener,
            ),
            patch.object(zotero_control.time, "time", return_value=TIMESTAMP),
            patch.object(
                zotero_control.secrets,
                "token_bytes",
                return_value=NONCE_BYTES,
            ),
        ):
            state = check_zotero_control_authentication()
        return state, opener

    def test_authenticates_with_one_fixed_post_and_no_discovery_get(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            write_key_tree(home)
            response = FakeResponse(
                {"apiVersion": 1, "authenticated": True},
                response_signature=RESPONSE_SIGNATURE,
            )
            opener = FakeOpener(response)
            with (
                patch.object(zotero_control, "_home_directory", return_value=home),
                patch.object(
                    zotero_control.urllib.request,
                    "build_opener",
                    return_value=opener,
                ) as build_opener,
                patch.object(zotero_control.time, "time", return_value=TIMESTAMP),
                patch.object(
                    zotero_control.secrets,
                    "token_bytes",
                    return_value=NONCE_BYTES,
                ),
            ):
                state = check_zotero_control_authentication()

        self.assertEqual(state, "authenticated")
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0].get_method(), "POST")
        self.assertEqual(opener.requests[0].full_url, CONTROL_AUTH_CHECK_URL)
        self.assertEqual(opener.timeouts, [CONTROL_TIMEOUT_SECONDS])
        handlers = build_opener.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], zotero_control._NoRedirectHandler)

    def test_missing_or_unsafe_key_does_not_make_a_request(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            with (
                patch.object(zotero_control, "_home_directory", return_value=home),
                patch.object(
                    zotero_control.urllib.request,
                    "build_opener",
                    side_effect=AssertionError("must not open a network request"),
                ),
            ):
                state = check_zotero_control_authentication()

        self.assertEqual(state, "key_unavailable")

    def test_maps_only_exact_control_errors_to_sanitized_states(self) -> None:
        cases = (
            (403, "control_disabled", False, "control_disabled"),
            (403, "authentication_failed", False, "authentication_failed"),
            (
                503,
                "temporarily_unavailable",
                True,
                "temporarily_unavailable",
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            write_key_tree(home)
            for status, code, retryable, expected in cases:
                with self.subTest(code=code):
                    result, _ = self.run_check(
                        home,
                        FakeHTTPError(
                            status,
                            error_document(code, retryable=retryable),
                        ),
                    )
                    self.assertEqual(result, expected)

    def test_sanitizes_network_unsupported_and_malformed_responses(self) -> None:
        cases = (
            (OSError("/private/zotero/profile"), "unavailable"),
            (FakeHTTPError(404, {}), "unsupported"),
            (
                FakeResponse({"apiVersion": 1, "authenticated": True}),
                "invalid_response",
            ),
            (
                FakeResponse(
                    {"apiVersion": 1, "authenticated": True},
                    response_signature="A" * 43,
                ),
                "invalid_response",
            ),
            (
                FakeResponse(
                    {"apiVersion": 1, "authenticated": True, "extra": True}
                ),
                "invalid_response",
            ),
            (
                FakeHTTPError(
                    403,
                    error_document("authentication_failed", retryable=True),
                ),
                "invalid_response",
            ),
            (
                FakeResponse(
                    {"apiVersion": 1, "authenticated": True},
                    url="http://127.0.0.1:23119/redirected",
                ),
                "invalid_response",
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            write_key_tree(home)
            for response, expected in cases:
                with self.subTest(expected=expected):
                    result, _ = self.run_check(home, response)
                    self.assertEqual(result, expected)
                    self.assertNotIn(str(home), result)


class StaticControlSafetyTests(unittest.TestCase):
    def test_module_has_no_path_override_or_public_discovery_request(self) -> None:
        source = (ADAPTER_DIR / "zotero_control.py").read_text(encoding="utf-8")

        self.assertNotIn("getenv(", source)
        self.assertNotIn("os.environ", source)
        self.assertNotIn("sys.argv", source)
        self.assertNotIn("control/v1/info", source)
        self.assertNotIn("X-ZGN-Credential-Id", source)
        self.assertNotIn('"Authorization"', source)
        self.assertNotIn('"Zotero-Allowed-Request"', source)
        self.assertNotIn("print(", source)
        self.assertIn('LOCAL_BRIDGE_KEY_FILENAME = "local-bridge.key"', source)


if __name__ == "__main__":
    unittest.main()
