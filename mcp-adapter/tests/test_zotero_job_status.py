from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))

import zotero_jobs
from zotero_control import build_control_auth_response_canonical
from zotero_jobs import (
    CONTROL_JOB_STATUS_CONTENT_TYPE,
    CONTROL_JOB_STATUS_PATH,
    CONTROL_JOB_STATUS_URL,
    MAX_JOB_RESPONSE_BYTES,
    MAX_JOB_STATUS_BODY_BYTES,
    InvalidZoteroJobInput,
    create_job_status_body,
    create_job_status_failure,
    create_job_status_request,
    get_zotero_import_job,
)

KEY = bytes(range(32))
TIMESTAMP = 1_787_558_400
NONCE_BYTES = bytes(range(16))
NONCE = "AAECAwQFBgcICQoLDA0ODw"
JOB_ID = "123e4567-e89b-42d3-a456-426614174000"


def job_document(
    *,
    job_id: str = JOB_ID,
    state: str = "submitted",
) -> dict[str, object]:
    return {
        "apiVersion": 1,
        "job": {
            "jobId": job_id,
            "state": state,
            "itemCount": 11,
            "skippedCount": 9,
            "createdAt": 1_000,
            "updatedAt": 1_200,
            "expiresAt": 4_600_000,
        },
    }


def error_document(code: str, *, retryable: bool) -> dict[str, object]:
    return {
        "apiVersion": 1,
        "error": {
            "code": code,
            "message": "/private/remote/detail must be ignored",
            "retryable": retryable,
        },
    }


def encode_document(document: object) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


def response_signature(
    body: bytes,
    *,
    status: int = 200,
    pathname: str = CONTROL_JOB_STATUS_PATH,
) -> str:
    canonical = build_control_auth_response_canonical(
        timestamp=TIMESTAMP,
        nonce=NONCE,
        method="POST",
        pathname=pathname,
        status=status,
        body_sha256=hashlib.sha256(body).hexdigest(),
    )
    return (
        base64.urlsafe_b64encode(hmac.digest(KEY, canonical, "sha256"))
        .rstrip(b"=")
        .decode("ascii")
    )


class FakeHeaders(dict[str, str]):
    def get_content_type(self) -> str:
        return self.get("Content-Type", "text/plain").split(";", 1)[0].strip()


class FakeResponse:
    def __init__(
        self,
        *,
        body: bytes,
        url: str = CONTROL_JOB_STATUS_URL,
        status: int = 200,
        content_type: str = "application/json",
        content_encoding: str | None = None,
        content_length: str | None = None,
        signature: str | None = None,
    ) -> None:
        self.status = status
        self._url = url
        self._body = body
        self.headers = FakeHeaders(
            {
                "Content-Type": content_type,
                "Content-Length": (
                    str(len(body)) if content_length is None else content_length
                ),
            }
        )
        if signature is not None:
            self.headers["X-ZGN-Response-Signature"] = signature
        if content_encoding is not None:
            self.headers["Content-Encoding"] = content_encoding

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def getcode(self) -> int:
        return self.status

    def read(self, limit: int) -> bytes:
        return self._body[:limit]


class FakeHTTPError(urllib.error.HTTPError):
    def __init__(
        self,
        code: int,
        document: object,
        *,
        content_type: str = "application/json",
        url: str = CONTROL_JOB_STATUS_URL,
        signature: str | None = None,
    ) -> None:
        body = encode_document(document)
        headers = FakeHeaders(
            {
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
            }
        )
        if signature is not None:
            headers["X-ZGN-Response-Signature"] = signature
        super().__init__(
            url,
            code,
            "remote detail must not cross the adapter",
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


def run_status(
    result: object,
    *,
    job_id: str = JOB_ID,
) -> tuple[zotero_jobs.ZoteroImportJobStatusResult, FakeOpener]:
    opener = FakeOpener(result)
    with (
        patch.object(
            zotero_jobs,
            "check_zotero_control_authentication",
            return_value="authenticated",
        ),
        patch.object(zotero_jobs, "read_local_bridge_key", return_value=KEY),
        patch.object(
            zotero_jobs.urllib.request,
            "build_opener",
            return_value=opener,
        ),
        patch.object(zotero_jobs.time, "time", return_value=TIMESTAMP),
        patch.object(
            zotero_jobs.secrets,
            "token_bytes",
            return_value=NONCE_BYTES,
        ),
    ):
        response = get_zotero_import_job(job_id=job_id)
    return response, opener


class JobStatusInputTests(unittest.TestCase):
    def test_builds_the_exact_canonical_uuid_and_hex_bodies(self) -> None:
        self.assertEqual(
            create_job_status_body(job_id=JOB_ID),
            b'{"jobId":"123e4567-e89b-42d3-a456-426614174000"}',
        )
        self.assertEqual(
            create_job_status_body(job_id="A" * 32),
            b'{"jobId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
        )

    def test_rejects_nonopaque_or_non_v4_job_identifiers(self) -> None:
        invalid: tuple[object, ...] = (
            None,
            True,
            "",
            " " + JOB_ID,
            JOB_ID + " ",
            "123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-42d3-7456-426614174000",
            "x" * 32,
            "0" * 31,
            "0" * 33,
        )
        for job_id in invalid:
            with self.subTest(job_id=job_id):
                with self.assertRaises(InvalidZoteroJobInput):
                    create_job_status_body(job_id=job_id)  # type: ignore[arg-type]

    def test_builds_the_fixed_signed_vendor_request(self) -> None:
        body = create_job_status_body(job_id=JOB_ID)
        request = create_job_status_request(
            KEY,
            body,
            timestamp=TIMESTAMP,
            nonce=NONCE,
        )
        headers = {name.lower(): value for name, value in request.header_items()}
        canonical = zotero_jobs.build_control_auth_canonical(
            timestamp=TIMESTAMP,
            nonce=NONCE,
            method="POST",
            pathname=CONTROL_JOB_STATUS_PATH,
            content_type=CONTROL_JOB_STATUS_CONTENT_TYPE,
            body_sha256=hashlib.sha256(body).hexdigest(),
        )
        signature = (
            base64.urlsafe_b64encode(hmac.digest(KEY, canonical, "sha256"))
            .rstrip(b"=")
            .decode("ascii")
        )

        self.assertEqual(request.full_url, CONTROL_JOB_STATUS_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, body)
        self.assertEqual(headers["accept"], "application/json")
        self.assertEqual(
            headers["content-type"], CONTROL_JOB_STATUS_CONTENT_TYPE
        )
        self.assertEqual(headers["content-length"], str(len(body)))
        self.assertEqual(headers["x-zgn-auth-version"], "1")
        self.assertEqual(headers["x-zgn-timestamp"], str(TIMESTAMP))
        self.assertEqual(headers["x-zgn-nonce"], NONCE)
        self.assertEqual(headers["x-zgn-signature"], signature)
        self.assertNotIn("authorization", headers)
        self.assertNotIn("zotero-allowed-request", headers)

    def test_matches_the_shared_javascript_status_vectors(self) -> None:
        vector_job_id = "f84bf93c-1435-41a2-ae08-b25e0eed195f"
        body = create_job_status_body(job_id=vector_job_id)
        request = create_job_status_request(
            KEY,
            body,
            timestamp=TIMESTAMP,
            nonce=NONCE,
        )
        headers = {name.lower(): value for name, value in request.header_items()}

        self.assertEqual(
            body,
            b'{"jobId":"f84bf93c-1435-41a2-ae08-b25e0eed195f"}',
        )
        self.assertEqual(len(body), 48)
        self.assertEqual(
            hashlib.sha256(body).hexdigest(),
            "86f575298e64434e0b9ecf4fd2de3cd9e00fe8b3152f0153d8219e1df574203d",
        )
        self.assertEqual(
            headers["x-zgn-signature"],
            "gy4aNIw9PqDzcVfIViqhhKKs3VhEG8iqDa4nAI7uGLg",
        )

        response_body = (
            b'{"apiVersion":1,"job":{"createdAt":1787558400000,'
            b'"expiresAt":null,"itemCount":2,'
            b'"jobId":"f84bf93c-1435-41a2-ae08-b25e0eed195f",'
            b'"skippedCount":1,"state":"submitted",'
            b'"updatedAt":1787558401000}}'
        )
        self.assertEqual(
            response_signature(response_body),
            "1RJN_K7ENzIreR9RjulByZ5J4LGeOEu8qFOcLuJaSyE",
        )

        not_found_body = (
            b'{"apiVersion":1,"error":{"code":"job_not_found",'
            b'"message":"The requested Zotero bridge job was not found.",'
            b'"retryable":false}}'
        )
        self.assertEqual(
            response_signature(not_found_body, status=404),
            "C0624VScuPMXb4uXxnsCReQ7e6RiOT5aSHJjxAUqJtA",
        )

    def test_rejects_bad_keys_and_oversized_bodies(self) -> None:
        body = create_job_status_body(job_id=JOB_ID)
        for key in (b"", b"x" * 31, b"x" * 33):
            with self.subTest(key_size=len(key)):
                with self.assertRaises(zotero_jobs.InvalidLocalBridgeKey):
                    create_job_status_request(
                        key,
                        body,
                        timestamp=TIMESTAMP,
                        nonce=NONCE,
                    )
        noncanonical = (
            b"",
            b"x" * (MAX_JOB_STATUS_BODY_BYTES + 1),
            create_job_status_body(job_id=JOB_ID) + b" ",
            b'{"jobId":"123e4567-e89b-42d3-a456-426614174000",'
            b'"private":true}',
            b'{"jobId":"123e4567-e89b-42d3-a456-426614174000",'
            b'"jobId":"123e4567-e89b-42d3-a456-426614174000"}',
        )
        for invalid_body in noncanonical:
            with self.subTest(body_size=len(invalid_body)):
                with self.assertRaises(InvalidZoteroJobInput):
                    create_job_status_request(
                        KEY,
                        invalid_body,
                        timestamp=TIMESTAMP,
                        nonce=NONCE,
                    )


class JobStatusControlFlowTests(unittest.TestCase):
    def test_every_failure_uses_the_narrow_null_field_shape(self) -> None:
        statuses = (
            "invalid_request",
            "key_unavailable",
            "control_disabled",
            "authentication_failed",
            "temporarily_unavailable",
            "unsupported",
            "unavailable",
            "invalid_response",
            "job_not_found",
            "internal_error",
        )
        for status in statuses:
            with self.subTest(status=status):
                result = create_job_status_failure(status)
                self.assertIsInstance(
                    result,
                    zotero_jobs.ZoteroImportJobStatusResult,
                )
                self.assertEqual(result.status, status)
                self.assertIsNone(result.jobId)
                self.assertIsNone(result.state)
                self.assertIsNone(result.itemCount)
                self.assertIsNone(result.skippedCount)
                self.assertIsNone(result.createdAt)
                self.assertIsNone(result.updatedAt)
                self.assertIsNone(result.expiresAt)
                self.assertIsNotNone(result.message)

    def test_invalid_input_returns_before_authentication_or_transport(self) -> None:
        with (
            patch.object(
                zotero_jobs,
                "check_zotero_control_authentication",
                side_effect=AssertionError("must not authenticate"),
            ),
            patch.object(
                zotero_jobs.urllib.request,
                "build_opener",
                side_effect=AssertionError("must not send"),
            ),
        ):
            result = get_zotero_import_job(job_id="not-a-job-id")
        self.assertEqual(result.status, "invalid_request")
        self.assertIsNone(result.jobId)

    def test_never_sends_the_job_id_when_preflight_is_not_authenticated(
        self,
    ) -> None:
        for state in (
            "key_unavailable",
            "control_disabled",
            "authentication_failed",
            "temporarily_unavailable",
            "unsupported",
            "unavailable",
            "invalid_response",
        ):
            with self.subTest(state=state):
                with (
                    patch.object(
                        zotero_jobs,
                        "check_zotero_control_authentication",
                        return_value=state,
                    ),
                    patch.object(
                        zotero_jobs,
                        "read_local_bridge_key",
                        side_effect=AssertionError("must not read the key"),
                    ),
                    patch.object(
                        zotero_jobs.urllib.request,
                        "build_opener",
                        side_effect=AssertionError("must not send"),
                    ),
                ):
                    result = get_zotero_import_job(job_id=JOB_ID)
                self.assertEqual(result.status, state)
                self.assertIsNone(result.jobId)

    def test_sends_one_fresh_post_and_returns_only_the_allowlisted_job_dto(
        self,
    ) -> None:
        document = job_document()
        document["job"] = {**document["job"]}  # type: ignore[misc]
        body = encode_document(document)
        result, opener = run_status(
            FakeResponse(body=body, signature=response_signature(body))
        )

        self.assertEqual(
            result,
            zotero_jobs.ZoteroImportJobStatusResult(
                status="ok",
                jobId=JOB_ID,
                state="submitted",
                itemCount=11,
                skippedCount=9,
                createdAt=1_000,
                updatedAt=1_200,
                expiresAt=4_600_000,
                message=None,
                retryable=False,
            ),
        )
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0].full_url, CONTROL_JOB_STATUS_URL)
        self.assertEqual(opener.requests[0].data, create_job_status_body(job_id=JOB_ID))
        self.assertEqual(opener.timeouts, [zotero_jobs.CONTROL_TIMEOUT_SECONDS])
        self.assertNotIn("source", repr(result).lower())
        self.assertNotIn("claim", repr(result).lower())

    def test_accepts_every_public_lifecycle_state(self) -> None:
        states = (
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
        )
        for state in states:
            with self.subTest(state=state):
                body = encode_document(job_document(state=state))
                result, _ = run_status(
                    FakeResponse(body=body, signature=response_signature(body))
                )
                self.assertEqual(result.status, "ok")
                self.assertEqual(result.state, state)

    def test_requires_request_bound_proof_and_the_requested_job_id(self) -> None:
        body = encode_document(job_document())
        other_body = encode_document(
            job_document(job_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        )
        cases = (
            FakeResponse(body=body),
            FakeResponse(body=body, signature="A" * 43),
            FakeResponse(
                body=body + b" ",
                signature=response_signature(body),
            ),
            FakeResponse(
                body=body,
                signature=response_signature(body),
                url="http://127.0.0.1:23119/redirected",
            ),
            FakeResponse(
                body=other_body,
                signature=response_signature(other_body),
            ),
        )
        for response in cases:
            with self.subTest(response=response):
                result, _ = run_status(response)
                self.assertEqual(result.status, "invalid_response")
                self.assertIsNone(result.jobId)

    def test_rejects_private_extra_duplicate_and_oversized_response_data(
        self,
    ) -> None:
        extra = job_document()
        extra["job"] = {
            **extra["job"],  # type: ignore[misc]
            "sourceKeys": ["PRIVATE1"],
        }
        duplicate = (
            b'{"apiVersion":1,"apiVersion":1,"job":'
            + encode_document(job_document()["job"])
            + b"}"
        )
        for body in (b"not-json", encode_document(extra), duplicate):
            with self.subTest(body=body):
                result, _ = run_status(
                    FakeResponse(body=body, signature=response_signature(body))
                )
                self.assertEqual(result.status, "invalid_response")
                self.assertNotIn("private1", repr(result).lower())

        oversized = b"x" * (MAX_JOB_RESPONSE_BYTES + 1)
        result, _ = run_status(
            FakeResponse(
                body=oversized,
                signature=response_signature(oversized),
            )
        )
        self.assertEqual(result.status, "invalid_response")

    def test_rejects_wrong_media_type_encoding_and_declared_length(self) -> None:
        body = encode_document(job_document())
        cases = (
            FakeResponse(
                body=body,
                content_type="text/plain",
                signature=response_signature(body),
            ),
            FakeResponse(
                body=body,
                content_encoding="gzip",
                signature=response_signature(body),
            ),
            FakeResponse(
                body=body,
                content_length="not-an-integer",
                signature=response_signature(body),
            ),
            FakeResponse(
                body=body,
                content_length=str(MAX_JOB_RESPONSE_BYTES + 1),
                signature=response_signature(body),
            ),
        )
        for response in cases:
            with self.subTest(response=response):
                result, _ = run_status(response)
                self.assertEqual(result.status, "invalid_response")
                self.assertIsNone(result.jobId)

    def test_maps_only_status_allowlisted_errors_to_static_results(self) -> None:
        cases = (
            (400, "invalid_request", False),
            (403, "control_disabled", False),
            (403, "authentication_failed", False),
            (404, "job_not_found", False),
            (500, "internal_error", True),
            (503, "temporarily_unavailable", True),
        )
        for status, code, retryable in cases:
            with self.subTest(code=code):
                document = error_document(code, retryable=retryable)
                signature = (
                    response_signature(encode_document(document), status=404)
                    if code == "job_not_found"
                    else None
                )
                result, _ = run_status(
                    FakeHTTPError(
                        status,
                        document,
                        signature=signature,
                    )
                )
                self.assertEqual(result.status, code)
                self.assertEqual(result.retryable, retryable)
                self.assertIsNone(result.jobId)
                self.assertIsNone(result.state)
                self.assertIsNone(result.itemCount)
                self.assertIsNone(result.skippedCount)
                self.assertIsNone(result.createdAt)
                self.assertIsNone(result.updatedAt)
                self.assertIsNone(result.expiresAt)
                self.assertNotIn("private", repr(result).lower())

    def test_requires_job_not_found_proof_bound_to_body_status_and_path(
        self,
    ) -> None:
        document = error_document("job_not_found", retryable=False)
        body = encode_document(document)
        altered = encode_document(
            {
                **document,
                "error": {
                    **document["error"],  # type: ignore[misc]
                    "message": "different remote text",
                },
            }
        )
        cases = (
            FakeHTTPError(404, document),
            FakeHTTPError(404, document, signature="A" * 43),
            FakeHTTPError(
                404,
                document,
                signature=response_signature(body, status=200),
            ),
            FakeHTTPError(
                404,
                document,
                signature=response_signature(
                    body,
                    status=404,
                    pathname=zotero_jobs.CONTROL_JOB_PATH,
                ),
            ),
            FakeHTTPError(
                404,
                document,
                signature=response_signature(altered, status=404),
            ),
        )
        for error in cases:
            with self.subTest(error=error):
                result, _ = run_status(error)
                self.assertEqual(result.status, "invalid_response")
                self.assertIsNone(result.jobId)

    def test_distinguishes_unsupported_and_sanitizes_other_http_errors(
        self,
    ) -> None:
        unsupported, _ = run_status(
            FakeHTTPError(404, {}, content_type="text/plain")
        )
        self.assertEqual(unsupported.status, "unsupported")
        self.assertEqual(
            unsupported.message,
            "The installed Zotero plugin does not support import-job status.",
        )

        malformed = (
            FakeHTTPError(
                404,
                error_document("library_not_found", retryable=False),
            ),
            FakeHTTPError(
                400,
                error_document("job_not_found", retryable=False),
            ),
            FakeHTTPError(
                404,
                error_document("job_not_found", retryable=True),
            ),
            FakeHTTPError(400, {"error": "/private/path"}),
            FakeHTTPError(
                404,
                error_document("job_not_found", retryable=False),
                url="http://127.0.0.1:23119/redirected",
            ),
        )
        for error in malformed:
            with self.subTest(error=error):
                result, _ = run_status(error)
                self.assertEqual(result.status, "invalid_response")
                self.assertNotIn("private", repr(result).lower())

    def test_maps_network_failures_without_exposing_exception_details(self) -> None:
        result, _ = run_status(OSError("/private/zotero/profile"))
        self.assertEqual(result.status, "unavailable")
        self.assertTrue(result.retryable)
        self.assertNotIn("private", repr(result).lower())


if __name__ == "__main__":
    unittest.main()
