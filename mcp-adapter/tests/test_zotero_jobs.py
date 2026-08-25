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
    CONTROL_JOB_CONTENT_TYPE,
    CONTROL_JOB_PATH,
    CONTROL_JOB_URL,
    MAX_JOB_BODY_BYTES,
    InvalidZoteroJobInput,
    InvalidZoteroJobResponse,
    create_stage_job_body,
    create_stage_job_request,
    parse_stage_job_success,
    stage_zotero_import_job,
)

KEY = bytes(range(32))
TIMESTAMP = 1_787_558_400
NONCE_BYTES = bytes(range(16))
NONCE = "AAECAwQFBgcICQoLDA0ODw"
JOB_ID = "123e4567-e89b-42d3-a456-426614174000"


def job_document(
    *,
    state: str = "staged",
    expires_at: int | None = None,
) -> dict[str, object]:
    return {
        "apiVersion": 1,
        "job": {
            "jobId": JOB_ID,
            "state": state,
            "itemCount": 2,
            "skippedCount": 1,
            "createdAt": 1_000,
            "updatedAt": 1_100,
            "expiresAt": expires_at,
        },
    }


def encode_document(document: object) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


def response_signature(body: bytes, *, status: int = 200) -> str:
    canonical = build_control_auth_response_canonical(
        timestamp=TIMESTAMP,
        nonce=NONCE,
        method="POST",
        pathname=CONTROL_JOB_PATH,
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
        document: object | None = None,
        *,
        url: str = CONTROL_JOB_URL,
        status: int = 200,
        body: bytes | None = None,
        content_type: str = "application/json",
        content_length: str | None = None,
        signature: str | None = None,
    ) -> None:
        self.status = status
        self._url = url
        self._body = encode_document(document) if body is None else body
        self.headers = FakeHeaders(
            {
                "Content-Type": content_type,
                "Content-Length": (
                    str(len(self._body))
                    if content_length is None
                    else content_length
                ),
            }
        )
        if signature is not None:
            self.headers["X-ZGN-Response-Signature"] = signature
        self.read_limit: int | None = None

    def __enter__(self) -> FakeResponse:
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
    def __init__(
        self,
        code: int,
        document: object,
        *,
        content_type: str = "application/json",
    ) -> None:
        body = encode_document(document)
        super().__init__(
            CONTROL_JOB_URL,
            code,
            "remote detail must not cross the adapter",
            FakeHeaders(
                {
                    "Content-Type": content_type,
                    "Content-Length": str(len(body)),
                }
            ),
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
            "message": "/private/remote/error must be ignored",
            "retryable": retryable,
        },
    }


def run_stage(result: object) -> tuple[zotero_jobs.ZoteroImportJobResult, FakeOpener]:
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
        response = stage_zotero_import_job(
            request_id="request-1",
            library_id=1,
            item_keys=["BBBB2222", "aaaa1111"],
        )
    return response, opener


class JobInputTests(unittest.TestCase):
    def test_builds_exact_canonical_item_request(self) -> None:
        body = create_stage_job_body(
            request_id="request-1",
            library_id=2,
            item_keys=["bbbb2222", "AAAA1111"],
        )
        self.assertEqual(
            body,
            b'{"destination":"active-or-new","itemKeys":["AAAA1111","BBBB2222"],'
            b'"libraryID":2,"replace":false,"requestId":"request-1"}',
        )

    def test_builds_exact_canonical_collection_request(self) -> None:
        body = create_stage_job_body(
            request_id="collection-request",
            library_id=3,
            collection_key="abcd1234",
            recursive=True,
        )
        self.assertEqual(
            body,
            b'{"collectionKey":"ABCD1234","destination":"active-or-new",'
            b'"libraryID":3,"recursive":true,"replace":false,'
            b'"requestId":"collection-request"}',
        )

    def test_rejects_missing_ambiguous_and_invalid_selectors(self) -> None:
        base = {"request_id": "request-1", "library_id": 1}
        invalid = (
            {},
            {"item_keys": ["AAAA1111"], "collection_key": "BBBB2222"},
            {"item_keys": []},
            {"item_keys": ["short"]},
            {"item_keys": ["aaaa1111", "AAAA1111"]},
            {"item_keys": ["AAAA1111"], "recursive": True},
            {"collection_key": "not-a-key"},
        )
        for override in invalid:
            with self.subTest(override=override):
                with self.assertRaises(InvalidZoteroJobInput):
                    create_stage_job_body(**base, **override)

    def test_rejects_invalid_identifiers_flags_and_oversized_body(self) -> None:
        cases = (
            {"request_id": "", "library_id": 1, "item_keys": ["AAAA1111"]},
            {
                "request_id": " unsafe ",
                "library_id": 1,
                "item_keys": ["AAAA1111"],
            },
            {
                "request_id": "x" * 129,
                "library_id": 1,
                "item_keys": ["AAAA1111"],
            },
            {"request_id": "x", "library_id": True, "item_keys": ["AAAA1111"]},
            {"request_id": "x", "library_id": 0, "item_keys": ["AAAA1111"]},
            {
                "request_id": "x",
                "library_id": 2**53,
                "item_keys": ["AAAA1111"],
            },
            {
                "request_id": "x",
                "library_id": 1,
                "collection_key": "AAAA1111",
                "recursive": 1,
            },
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(InvalidZoteroJobInput):
                    create_stage_job_body(**value)  # type: ignore[arg-type]

        many_keys = [f"{index:08X}" for index in range(257)]
        with self.assertRaises(InvalidZoteroJobInput):
            create_stage_job_body(
                request_id="too-large",
                library_id=1,
                item_keys=many_keys,
            )


class SignedJobRequestTests(unittest.TestCase):
    def test_builds_exact_fixed_signed_post_without_a_body_digest_header(self) -> None:
        body = create_stage_job_body(
            request_id="request-1",
            library_id=1,
            item_keys=["AAAA1111"],
        )
        request = create_stage_job_request(
            KEY,
            body,
            timestamp=TIMESTAMP,
            nonce=NONCE,
        )
        headers = {name.lower(): value for name, value in request.header_items()}
        body_sha256 = hashlib.sha256(body).hexdigest()
        canonical = zotero_jobs.build_control_auth_canonical(
            timestamp=TIMESTAMP,
            nonce=NONCE,
            method="POST",
            pathname=CONTROL_JOB_PATH,
            content_type=CONTROL_JOB_CONTENT_TYPE,
            body_sha256=body_sha256,
        )
        expected_signature = (
            base64.urlsafe_b64encode(hmac.digest(KEY, canonical, "sha256"))
            .rstrip(b"=")
            .decode("ascii")
        )

        self.assertEqual(request.full_url, CONTROL_JOB_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, body)
        self.assertEqual(headers["accept"], "application/json")
        self.assertEqual(headers["content-type"], CONTROL_JOB_CONTENT_TYPE)
        self.assertEqual(headers["content-length"], str(len(body)))
        self.assertEqual(headers["x-zgn-auth-version"], "1")
        self.assertEqual(headers["x-zgn-timestamp"], str(TIMESTAMP))
        self.assertEqual(headers["x-zgn-nonce"], NONCE)
        self.assertEqual(headers["x-zgn-signature"], expected_signature)
        self.assertNotIn("x-zgn-body-sha256", headers)
        self.assertNotIn("authorization", headers)
        self.assertNotIn("zotero-allowed-request", headers)

    def test_matches_the_shared_javascript_job_request_vector(self) -> None:
        body = create_stage_job_body(
            request_id="a3c14c56-1f00-4d2e-8e68-b36fc7068be3",
            library_id=2,
            collection_key="ABCD1234",
        )
        request = create_stage_job_request(
            KEY,
            body,
            timestamp=TIMESTAMP,
            nonce=NONCE,
        )
        headers = {name.lower(): value for name, value in request.header_items()}

        self.assertEqual(len(body), 157)
        self.assertEqual(
            hashlib.sha256(body).hexdigest(),
            "7ffd4c55ae95909da28f9d58f80e83f4121631af4d528548b14cf4c1b5122953",
        )
        self.assertEqual(
            headers["x-zgn-signature"],
            "XSfMQ6wcGPNhAl6Wos-leApCh-ViXOfwMSjqeKu4VmA",
        )

        response_body = (
            b'{"apiVersion":1,"job":{"createdAt":1787558400000,'
            b'"expiresAt":null,"itemCount":2,'
            b'"jobId":"f84bf93c-1435-41a2-ae08-b25e0eed195f",'
            b'"skippedCount":1,"state":"staged",'
            b'"updatedAt":1787558400000}}'
        )
        self.assertEqual(
            response_signature(response_body),
            "20dBnXP0_QYiMvnDMnkad6h-q0AZBM4O8845VDAcxsQ",
        )

    def test_rejects_bad_keys_and_bodies_before_building_a_request(self) -> None:
        for key in (b"", b"x" * 31, b"x" * 33):
            with self.subTest(key_size=len(key)):
                with self.assertRaises(zotero_jobs.InvalidLocalBridgeKey):
                    create_stage_job_request(
                        key,
                        b"{}",
                        timestamp=TIMESTAMP,
                        nonce=NONCE,
                    )
        for body in (b"", b"x" * (MAX_JOB_BODY_BYTES + 1)):
            with self.subTest(body_size=len(body)):
                with self.assertRaises(InvalidZoteroJobInput):
                    create_stage_job_request(
                        KEY,
                        body,
                        timestamp=TIMESTAMP,
                        nonce=NONCE,
                    )


class JobResponseTests(unittest.TestCase):
    def test_accepts_only_the_explicit_success_dto(self) -> None:
        result = parse_stage_job_success(job_document())
        self.assertEqual(
            result,
            zotero_jobs.ZoteroImportJobResult(
                status="ok",
                jobId=JOB_ID,
                state="staged",
                itemCount=2,
                skippedCount=1,
                createdAt=1_000,
                updatedAt=1_100,
                expiresAt=None,
                message=None,
                retryable=False,
            ),
        )

        retained = parse_stage_job_success(
            job_document(state="claimed", expires_at=4_700_000)
        )
        self.assertEqual(retained.status, "ok")
        self.assertEqual(retained.state, "claimed")
        self.assertEqual(retained.expiresAt, 4_700_000)

    def test_rejects_extra_private_fields_and_malformed_job_values(self) -> None:
        cases: list[object] = [
            {**job_document(), "private": "/private/path"},
            {"apiVersion": 2, "job": job_document()["job"]},
            {"apiVersion": 1, "job": None},
        ]
        job_variants = (
            {"source": {"itemKeys": ["PRIVATE1"]}},
            {"jobId": "not-an-opaque-job-id"},
            {"state": "complete"},
            {"itemCount": 0},
            {"skippedCount": -1},
            {"createdAt": True},
            {"updatedAt": 999},
            {"expiresAt": 999},
        )
        for override in job_variants:
            document = job_document()
            document["job"] = {**document["job"], **override}  # type: ignore[misc]
            cases.append(document)

        for document in cases:
            with self.subTest(document=document):
                with self.assertRaises(InvalidZoteroJobResponse):
                    parse_stage_job_success(document)


class JobControlFlowTests(unittest.TestCase):
    def test_never_sends_stable_identifiers_when_preflight_is_not_authenticated(
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
                        side_effect=AssertionError("must not read for a job"),
                    ),
                    patch.object(
                        zotero_jobs.urllib.request,
                        "build_opener",
                        side_effect=AssertionError("must not send a job"),
                    ),
                ):
                    result = stage_zotero_import_job(
                        request_id="private-request",
                        library_id=9,
                        collection_key="PRIV1234",
                    )
                self.assertEqual(result.status, state)
                self.assertIsNone(result.jobId)

    def test_sends_one_fresh_signed_job_post_after_preflight_and_verifies_success(
        self,
    ) -> None:
        body = encode_document(job_document())
        result, opener = run_stage(
            FakeResponse(
                body=body,
                signature=response_signature(body),
            )
        )

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.jobId, JOB_ID)
        self.assertEqual(result.state, "staged")
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0].full_url, CONTROL_JOB_URL)
        self.assertEqual(opener.requests[0].get_method(), "POST")
        self.assertEqual(opener.timeouts, [zotero_jobs.CONTROL_TIMEOUT_SECONDS])

    def test_requires_a_request_bound_success_signature(self) -> None:
        body = encode_document(job_document())
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
        )
        for response in cases:
            with self.subTest(response=response):
                result, _ = run_stage(response)
                self.assertEqual(result.status, "invalid_response")
                self.assertIsNone(result.jobId)

    def test_rejects_malformed_duplicate_oversized_and_extra_success_data(
        self,
    ) -> None:
        duplicate = (
            b'{"apiVersion":1,"apiVersion":1,"job":'
            + encode_document(job_document()["job"])
            + b"}"
        )
        extra_document = job_document()
        extra_document["secret"] = "/private/library/path"
        bodies = (
            b"not-json",
            duplicate,
            encode_document(extra_document),
        )
        for body in bodies:
            with self.subTest(body=body):
                result, _ = run_stage(
                    FakeResponse(body=body, signature=response_signature(body))
                )
                self.assertEqual(result.status, "invalid_response")
                self.assertNotIn("private", repr(result).lower())

        oversized = b"x" * (zotero_jobs.MAX_JOB_RESPONSE_BYTES + 1)
        result, _ = run_stage(
            FakeResponse(
                body=oversized,
                signature=response_signature(oversized),
            )
        )
        self.assertEqual(result.status, "invalid_response")

    def test_maps_only_exact_allowlisted_error_envelopes_to_static_results(
        self,
    ) -> None:
        cases = (
            (400, "invalid_request", False),
            (403, "control_disabled", False),
            (403, "authentication_failed", False),
            (404, "library_not_found", False),
            (404, "collection_not_found", False),
            (409, "pending_job_exists", False),
            (409, "idempotency_conflict", False),
            (400, "source_limit_exceeded", False),
            (400, "no_supported_attachments", False),
            (500, "internal_error", True),
            (503, "temporarily_unavailable", True),
        )
        for status, code, retryable in cases:
            with self.subTest(code=code):
                result, _ = run_stage(
                    FakeHTTPError(
                        status,
                        error_document(code, retryable=retryable),
                    )
                )
                self.assertEqual(result.status, code)
                self.assertEqual(result.retryable, retryable)
                self.assertNotIn("/private/remote", repr(result))
                self.assertIsNone(result.jobId)

    def test_sanitizes_unknown_mismatched_and_non_json_http_errors(self) -> None:
        cases = (
            FakeHTTPError(409, error_document("unknown", retryable=False)),
            FakeHTTPError(
                400,
                error_document("pending_job_exists", retryable=False),
            ),
            FakeHTTPError(
                409,
                error_document("pending_job_exists", retryable=True),
            ),
            FakeHTTPError(400, {"error": "/private/path"}),
        )
        for error in cases:
            with self.subTest(error=error):
                result, _ = run_stage(error)
                self.assertEqual(result.status, "invalid_response")
                self.assertNotIn("private", repr(result).lower())

        unsupported, _ = run_stage(
            FakeHTTPError(404, {}, content_type="text/plain")
        )
        self.assertEqual(unsupported.status, "unsupported")

    def test_maps_network_failure_without_exposing_exception_text(self) -> None:
        result, _ = run_stage(OSError("/private/zotero/profile"))
        self.assertEqual(result.status, "unavailable")
        self.assertTrue(result.retryable)
        self.assertNotIn("/private", repr(result))


if __name__ == "__main__":
    unittest.main()
