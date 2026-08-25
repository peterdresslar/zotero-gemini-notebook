from __future__ import annotations

import ast
import errno
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))

# Mirror production startup: the entrypoint sets FastMCP's stdio-safe
# environment before any direct FastMCP import in this process.
import server
from fastmcp import Client
from fastmcp.client.transports import StdioTransport

from zotero_jobs import ZoteroImportJobResult, ZoteroImportJobStatusResult
from zotero_status import ZoteroBridgeStatus


EXPECTED_STATUS = {
    "status": "opted_in",
    "mcpOptedIn": True,
    "hasStagedSources": True,
    "stagedSourceCount": 2,
    "zoteroVersion": "10.0.1",
    "pluginVersion": "Zotero Gemini Notebook 0.4.0",
}

EXPECTED_JOB = {
    "status": "ok",
    "jobId": "123e4567-e89b-42d3-a456-426614174000",
    "state": "staged",
    "itemCount": 2,
    "skippedCount": 1,
    "createdAt": 1_000,
    "updatedAt": 1_100,
    "expiresAt": None,
    "message": None,
    "retryable": False,
}

EXPECTED_STATUS_JOB = {
    **EXPECTED_JOB,
    "state": "submitted",
}

SERVER_PATH = ADAPTER_DIR / "server.py"
PROJECT_PATH = ADAPTER_DIR / "pyproject.toml"
LOCK_PATH = ADAPTER_DIR / "uv.lock"


class StaticServerSourceTests(unittest.TestCase):
    def test_project_pins_and_locks_fastmcp_without_direct_crypto_dependency(
        self,
    ) -> None:
        project = PROJECT_PATH.read_text(encoding="utf-8")
        lock = LOCK_PATH.read_text(encoding="utf-8")

        self.assertIn('dependencies = ["fastmcp==3.4.7"]', project)
        self.assertNotIn('"cryptography==', project)
        self.assertRegex(
            lock,
            r'\[\[package\]\]\nname = "fastmcp"\nversion = "3\.4\.7"',
        )

    def test_fastmcp_suppression_precedes_import_and_server_never_writes_stdout(
        self,
    ) -> None:
        source = SERVER_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)

        fastmcp_import_line = next(
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module == "fastmcp"
        )
        required_settings = {
            "FASTMCP_LOG_ENABLED": "false",
            "FASTMCP_SHOW_SERVER_BANNER": "false",
            "FASTMCP_CHECK_FOR_UPDATES": "off",
        }
        assignments: dict[str, tuple[str, int]] = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Attribute)
                and isinstance(target.value.value, ast.Name)
                and target.value.value.id == "os"
                and target.value.attr == "environ"
                and isinstance(target.slice, ast.Constant)
                and isinstance(target.slice.value, str)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                assignments[target.slice.value] = (node.value.value, node.lineno)

        for key, expected_value in required_settings.items():
            with self.subTest(setting=key):
                value, line = assignments[key]
                self.assertEqual(value, expected_value)
                self.assertLess(line, fastmcp_import_line)

        forbidden_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "print"
        ]
        stdout_accesses = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and node.attr in {"stdout", "__stdout__"}
        ]
        self.assertEqual(forbidden_calls, [])
        self.assertEqual(stdout_accesses, [])
        self.assertIn('mcp.run(transport="stdio", show_banner=False)', source)


class InMemoryServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovers_annotated_status_tool_and_calls_it(self) -> None:
        fixed_status = ZoteroBridgeStatus(
            status="opted_in",
            mcpOptedIn=True,
            hasStagedSources=True,
            stagedSourceCount=2,
            zoteroVersion="10.0.1",
            pluginVersion="Zotero Gemini Notebook 0.4.0",
        )

        with patch.object(
            server,
            "read_zotero_bridge_status",
            return_value=fixed_status,
        ):
            async with Client(server.mcp) as client:
                tools = await client.list_tools()
                resources = await client.list_resources()
                prompts = await client.list_prompts()
                tool = next(
                    candidate
                    for candidate in tools
                    if candidate.name == "get_zotero_bridge_status"
                )
                result = await client.call_tool("get_zotero_bridge_status", {})

        self.assertIs(tool.annotations.readOnlyHint, True)
        self.assertIs(tool.annotations.destructiveHint, False)
        self.assertIs(tool.annotations.idempotentHint, True)
        self.assertIs(tool.annotations.openWorldHint, False)
        self.assertEqual(tool.inputSchema.get("properties"), {})
        self.assertEqual(resources, [])
        self.assertEqual(prompts, [])
        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content, EXPECTED_STATUS)

    async def test_discovers_truthful_annotated_staging_tool_and_calls_it(
        self,
    ) -> None:
        fixed_job = ZoteroImportJobResult(
            status="ok",
            jobId="123e4567-e89b-42d3-a456-426614174000",
            state="staged",
            itemCount=2,
            skippedCount=1,
            createdAt=1_000,
            updatedAt=1_100,
            expiresAt=None,
            message=None,
            retryable=False,
        )
        with patch.object(
            server,
            "stage_zotero_import_job_request",
            return_value=fixed_job,
        ) as stage_request:
            async with Client(server.mcp) as client:
                tools = await client.list_tools()
                tool = next(
                    candidate
                    for candidate in tools
                    if candidate.name == "stage_zotero_import_job"
                )
                result = await client.call_tool(
                    "stage_zotero_import_job",
                    {
                        "request_id": "request-1",
                        "library_id": 1,
                        "item_keys": ["AAAA1111"],
                    },
                )

        self.assertIs(tool.annotations.readOnlyHint, False)
        self.assertIs(tool.annotations.destructiveHint, False)
        self.assertIs(tool.annotations.idempotentHint, True)
        self.assertIs(tool.annotations.openWorldHint, False)
        self.assertIn("later starts the Chrome import", tool.description)
        self.assertIn("active Gemini Notebook", tool.description)
        self.assertIn("new notebook", tool.description)
        self.assertNotIn(
            "job_not_found",
            tool.outputSchema["properties"]["status"]["enum"],
        )
        self.assertIn(
            "pending_job_exists",
            tool.outputSchema["properties"]["status"]["enum"],
        )
        self.assertEqual(
            set(tool.inputSchema["properties"]),
            {
                "request_id",
                "library_id",
                "item_keys",
                "collection_key",
                "recursive",
            },
        )
        self.assertEqual(
            set(tool.inputSchema["required"]),
            {"request_id", "library_id"},
        )
        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content, EXPECTED_JOB)
        stage_request.assert_called_once_with(
            request_id="request-1",
            library_id=1,
            item_keys=["AAAA1111"],
            collection_key=None,
            recursive=False,
        )

    async def test_discovers_read_only_job_status_tool_and_calls_it(self) -> None:
        fixed_job = ZoteroImportJobStatusResult(
            status="ok",
            jobId="123e4567-e89b-42d3-a456-426614174000",
            state="submitted",
            itemCount=2,
            skippedCount=1,
            createdAt=1_000,
            updatedAt=1_100,
            expiresAt=None,
            message=None,
            retryable=False,
        )
        with patch.object(
            server,
            "get_zotero_import_job_request",
            return_value=fixed_job,
        ) as get_request:
            async with Client(server.mcp) as client:
                tools = await client.list_tools()
                tool = next(
                    candidate
                    for candidate in tools
                    if candidate.name == "get_zotero_import_job"
                )
                result = await client.call_tool(
                    "get_zotero_import_job",
                    {"job_id": "123e4567-e89b-42d3-a456-426614174000"},
                )

        self.assertIs(tool.annotations.readOnlyHint, True)
        self.assertIs(tool.annotations.destructiveHint, False)
        self.assertIs(tool.annotations.idempotentHint, True)
        self.assertIs(tool.annotations.openWorldHint, False)
        self.assertEqual(set(tool.inputSchema["properties"]), {"job_id"})
        self.assertEqual(set(tool.inputSchema["required"]), {"job_id"})
        status_values = set(tool.outputSchema["properties"]["status"]["enum"])
        self.assertIn("job_not_found", status_values)
        self.assertNotIn("library_not_found", status_values)
        self.assertNotIn("pending_job_exists", status_values)
        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content, EXPECTED_STATUS_JOB)
        get_request.assert_called_once_with(
            job_id="123e4567-e89b-42d3-a456-426614174000"
        )

    async def test_masks_unexpected_tool_errors(self) -> None:
        secret = "/private/zotero/library/path"

        with patch.object(
            server,
            "read_zotero_bridge_status",
            side_effect=RuntimeError(secret),
        ):
            async with Client(server.mcp) as client:
                result = await client.call_tool("get_zotero_bridge_status", {})

        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "status": "internal_error",
                "mcpOptedIn": None,
                "hasStagedSources": None,
                "stagedSourceCount": None,
                "zoteroVersion": None,
                "pluginVersion": None,
            },
        )
        self.assertNotIn(secret, repr(result))

    async def test_masks_unexpected_staging_tool_errors(self) -> None:
        secret = "/private/zotero/library/path"
        with patch.object(
            server,
            "stage_zotero_import_job_request",
            side_effect=RuntimeError(secret),
        ):
            async with Client(server.mcp) as client:
                result = await client.call_tool(
                    "stage_zotero_import_job",
                    {
                        "request_id": "request-1",
                        "library_id": 1,
                        "collection_key": "AAAA1111",
                    },
                )

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content["status"], "internal_error")
        self.assertIsNone(result.structured_content["jobId"])
        self.assertNotIn(secret, repr(result))

    async def test_masks_unexpected_job_status_tool_errors(self) -> None:
        secret = "/private/zotero/library/path"
        with patch.object(
            server,
            "get_zotero_import_job_request",
            side_effect=RuntimeError(secret),
        ):
            async with Client(server.mcp) as client:
                result = await client.call_tool(
                    "get_zotero_import_job",
                    {"job_id": "123e4567-e89b-42d3-a456-426614174000"},
                )

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content["status"], "internal_error")
        self.assertIsNone(result.structured_content["jobId"])
        self.assertNotIn(secret, repr(result))


class StdioServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_process_discovers_tools_and_calls_status_tool(
        self,
    ) -> None:
        records: list[dict[str, object]] = []
        bridge_response_body = json.dumps(
            {
                "ready": True,
                "count": 2,
                "zoteroVersion": "10.0.1",
                "pluginVersion": "Zotero Gemini Notebook 0.4.0",
                "mcpOptedIn": True,
                "secret": "must-not-cross-the-tool-boundary",
            },
            separators=(",", ":"),
        ).encode("utf-8")

        class StatusHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                declared_length = self.headers.get("Content-Length")
                body_length = int(declared_length) if declared_length else 0
                request_body = self.rfile.read(body_length) if body_length else b""
                records.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "accept": self.headers.get("Accept"),
                        "allowed": self.headers.get("Zotero-Allowed-Request"),
                        "contentLength": declared_length,
                        "transferEncoding": self.headers.get("Transfer-Encoding"),
                        "body": request_body,
                    }
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(bridge_response_body)))
                self.end_headers()
                self.wfile.write(bridge_response_body)

            def log_message(self, format: str, *args: object) -> None:
                return None

        try:
            http_server = ThreadingHTTPServer(
                ("127.0.0.1", 23119),
                StatusHandler,
            )
        except OSError as error:
            if error.errno == errno.EADDRINUSE:
                if os.environ.get("CI"):
                    self.fail("127.0.0.1:23119 must be free in CI")
                self.skipTest("127.0.0.1:23119 is occupied")
            raise

        http_server.daemon_threads = True
        server_thread = threading.Thread(
            target=http_server.serve_forever,
            name="fake-zotero-status-server",
            daemon=True,
        )
        server_thread.start()

        hostile_environment = {
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "ALL_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "",
            "FASTMCP_TRANSPORT": "http",
            "FASTMCP_LOG_ENABLED": "true",
            "FASTMCP_SHOW_SERVER_BANNER": "true",
            "FASTMCP_CHECK_FOR_UPDATES": "prerelease",
        }
        transport = StdioTransport(
            command=sys.executable,
            args=[str(SERVER_PATH)],
            env=hostile_environment,
            cwd=str(ADAPTER_DIR),
            keep_alive=False,
        )

        try:
            async with Client(transport) as client:
                await client.ping()
                tool_names = {tool.name for tool in await client.list_tools()}
                bridge_result = await client.call_tool(
                    "get_zotero_bridge_status",
                    {},
                )
        finally:
            http_server.shutdown()
            http_server.server_close()
            server_thread.join(timeout=5)

        self.assertEqual(
            tool_names,
            {
                "get_zotero_bridge_status",
                "stage_zotero_import_job",
                "get_zotero_import_job",
            },
        )
        self.assertFalse(bridge_result.is_error)
        self.assertEqual(bridge_result.structured_content, EXPECTED_STATUS)
        self.assertEqual(
            records,
            [
                {
                    "method": "GET",
                    "path": "/notebooklm/status",
                    "accept": "application/json",
                    "allowed": "1",
                    "contentLength": None,
                    "transferEncoding": None,
                    "body": b"",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
