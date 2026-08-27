from __future__ import annotations

import json
import sys
import unittest
import urllib.error
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))

import zotero_status
from zotero_status import (
    MAX_STATUS_BODY_BYTES,
    STATUS_TIMEOUT_SECONDS,
    ZOTERO_STATUS_URL,
    InvalidZoteroStatusResponse,
    parse_zotero_status_document,
    read_zotero_bridge_status,
)

VALID_DOCUMENT = {
    "ready": True,
    "count": 2,
    "zoteroVersion": "10.0.1",
    "pluginVersion": "Zotero Gemini Notebook 0.4.0",
}


class FakeHeaders(dict[str, str]):
    def get_content_type(self) -> str:
        return self.get("Content-Type", "text/plain").split(";", 1)[0].strip()


class FakeResponse:
    def __init__(
        self,
        document: object = None,
        *,
        body: bytes | None = None,
        status: int = 200,
        url: str = ZOTERO_STATUS_URL,
        content_type: str = "application/json",
        content_length: str | None = None,
    ) -> None:
        self.status = status
        self._url = url
        self._body = (
            json.dumps(document if document is not None else {}).encode("utf-8")
            if body is None
            else body
        )
        self.headers = FakeHeaders({"Content-Type": content_type})
        if content_length is not None:
            self.headers["Content-Length"] = content_length
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


class FakeOpener:
    def __init__(self, response: FakeResponse | BaseException) -> None:
        self.response = response
        self.request: object | None = None
        self.timeout: float | None = None

    def open(self, request: object, timeout: float) -> FakeResponse:
        self.request = request
        self.timeout = timeout
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response


class ParseStatusTests(unittest.TestCase):
    def test_missing_opt_in_is_unsupported_and_ignores_unlisted_fields(self) -> None:
        result = parse_zotero_status_document(
            {
                **VALID_DOCUMENT,
                "libraryPath": "/private/Zotero",
                "token": "do-not-return",
            }
        )

        self.assertEqual(
            asdict(result),
            {
                "status": "unsupported",
                "mcpOptedIn": None,
                "hasStagedSources": True,
                "stagedSourceCount": 2,
                "zoteroVersion": "10.0.1",
                "pluginVersion": "Zotero Gemini Notebook 0.4.0",
            },
        )

    def test_false_is_disabled(self) -> None:
        result = parse_zotero_status_document(
            {**VALID_DOCUMENT, "mcpOptedIn": False}
        )
        self.assertEqual(result.status, "disabled")
        self.assertIs(result.mcpOptedIn, False)

    def test_true_is_opted_in(self) -> None:
        result = parse_zotero_status_document(
            {**VALID_DOCUMENT, "mcpOptedIn": True}
        )
        self.assertEqual(result.status, "opted_in")
        self.assertIs(result.mcpOptedIn, True)

    def test_rejects_non_boolean_opt_in_values(self) -> None:
        for value in (0, 1, None, "true", [], {}):
            with self.subTest(value=value):
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(
                        {**VALID_DOCUMENT, "mcpOptedIn": value}
                    )

    def test_rejects_non_object_documents(self) -> None:
        for value in (None, [], "status", True, 1):
            with self.subTest(value=value):
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(value)

    def test_rejects_versions_that_could_carry_paths_or_control_text(self) -> None:
        for value in (
            "/private/Zotero",
            r"C:\\Users\\person\\Zotero",
            "10.0\nsecret",
            "x" * 129,
            10,
            None,
        ):
            with self.subTest(value=value):
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(
                        {
                            **VALID_DOCUMENT,
                            "mcpOptedIn": True,
                            "zoteroVersion": value,
                        }
                    )

    def test_accepts_stable_and_prerelease_connector_semver(self) -> None:
        versions = (
            "Zotero Gemini Notebook 0.4.0",
            "Zotero Gemini Notebook 0.4.0-beta.1",
            "Zotero Gemini Notebook 10.2.3-rc.1+build.7",
        )

        for version in versions:
            with self.subTest(version=version):
                result = parse_zotero_status_document(
                    {
                        **VALID_DOCUMENT,
                        "pluginVersion": version,
                        "mcpOptedIn": True,
                    }
                )
                self.assertEqual(result.pluginVersion, version)

    def test_rejects_unrecognized_or_invalid_connector_versions(self) -> None:
        invalid_versions = (
            "Gemini Notebook 0.4.0",
            "Zotero Gemini Notebook v0.4.0",
            "Zotero Gemini Notebook 00.4.0",
            "Zotero Gemini Notebook 0.04.0",
            "Zotero Gemini Notebook 0.4",
            "Zotero Gemini Notebook 0.4.0-01",
            "Zotero Gemini Notebook 0.4.0/../../private",
            "Zotero Gemini Notebook 0.4.0\nsecret",
            "Zotero Gemini Notebook " + "1" * 65,
        )

        for version in invalid_versions:
            with self.subTest(version=version):
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(
                        {
                            **VALID_DOCUMENT,
                            "pluginVersion": version,
                            "mcpOptedIn": True,
                        }
                    )

    def test_requires_strict_ready_count_and_version_fields(self) -> None:
        invalid_updates = (
            {"ready": 1},
            {"count": True},
            {"count": -1},
            {"count": 2**53},
            {"ready": True, "count": 0},
            {"ready": False, "count": 1},
            {"pluginVersion": None},
        )

        for update in invalid_updates:
            with self.subTest(update=update):
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(
                        {**VALID_DOCUMENT, **update, "mcpOptedIn": True}
                    )

        for missing_key in VALID_DOCUMENT:
            with self.subTest(missing_key=missing_key):
                document = {**VALID_DOCUMENT, "mcpOptedIn": True}
                del document[missing_key]
                with self.assertRaises(InvalidZoteroStatusResponse):
                    parse_zotero_status_document(document)


class FetchStatusTests(unittest.TestCase):
    def test_uses_only_the_fixed_loopback_request(self) -> None:
        response = FakeResponse({**VALID_DOCUMENT, "mcpOptedIn": True})
        opener = FakeOpener(response)

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ) as build_opener:
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "opted_in")
        self.assertEqual(opener.request.full_url, ZOTERO_STATUS_URL)
        self.assertEqual(opener.request.get_method(), "GET")
        self.assertEqual(opener.timeout, STATUS_TIMEOUT_SECONDS)
        self.assertEqual(
            opener.request.get_header("Zotero-allowed-request"),
            "1",
        )
        self.assertEqual(response.read_limit, MAX_STATUS_BODY_BYTES + 1)
        handlers = build_opener.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], zotero_status._NoRedirectHandler)

    def test_network_errors_become_a_sanitized_unavailable_dto(self) -> None:
        secret = "/private/library/path"
        opener = FakeOpener(urllib.error.URLError(secret))

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        serialized = json.dumps(asdict(result))
        self.assertEqual(result.status, "unavailable")
        self.assertNotIn(secret, serialized)

    def test_http_errors_become_a_sanitized_invalid_response_dto(self) -> None:
        opener = FakeOpener(
            urllib.error.HTTPError(
                ZOTERO_STATUS_URL,
                503,
                "private upstream failure",
                {},
                None,
            )
        )

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "invalid_response")
        self.assertEqual(result.mcpOptedIn, None)

    def test_invalid_json_becomes_a_sanitized_invalid_response_dto(self) -> None:
        opener = FakeOpener(FakeResponse(body=b"not-json"))

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "invalid_response")
        self.assertEqual(result.mcpOptedIn, None)
        self.assertEqual(result.hasStagedSources, None)
        self.assertEqual(result.stagedSourceCount, None)
        self.assertEqual(result.zoteroVersion, None)
        self.assertEqual(result.pluginVersion, None)

    def test_rejects_duplicate_keys(self) -> None:
        opener = FakeOpener(
            FakeResponse(body=b'{"mcpOptedIn":true,"mcpOptedIn":false}')
        )

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "invalid_response")

    def test_rejects_non_json_content_types(self) -> None:
        opener = FakeOpener(
            FakeResponse(
                {**VALID_DOCUMENT, "mcpOptedIn": True},
                content_type="text/plain",
            )
        )

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "invalid_response")

    def test_caps_declared_and_actual_body_size(self) -> None:
        responses = (
            FakeResponse(
                {**VALID_DOCUMENT, "mcpOptedIn": True},
                content_length=str(MAX_STATUS_BODY_BYTES + 1),
            ),
            FakeResponse(body=b" " * (MAX_STATUS_BODY_BYTES + 1)),
        )

        for response in responses:
            with self.subTest(content_length=response.headers.get("Content-Length")):
                opener = FakeOpener(response)
                with patch.object(
                    zotero_status.urllib.request,
                    "build_opener",
                    return_value=opener,
                ):
                    result = read_zotero_bridge_status()
                self.assertEqual(result.status, "invalid_response")

    def test_rejects_redirected_final_urls(self) -> None:
        opener = FakeOpener(
            FakeResponse(
                {**VALID_DOCUMENT, "mcpOptedIn": True},
                url="http://example.invalid/status",
            )
        )

        with patch.object(
            zotero_status.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            result = read_zotero_bridge_status()

        self.assertEqual(result.status, "invalid_response")


if __name__ == "__main__":
    unittest.main()
