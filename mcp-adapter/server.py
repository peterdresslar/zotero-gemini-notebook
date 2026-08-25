"""FastMCP stdio adapter for the Zotero Gemini Notebook bridge."""

import os

# FastMCP must never write banners, logs, or update notices to the MCP stdout
# transport. Assign these before importing FastMCP so hostile ambient settings
# cannot re-enable them for this package-owned entry point.
os.environ["FASTMCP_LOG_ENABLED"] = "false"
os.environ["FASTMCP_SHOW_SERVER_BANNER"] = "false"
os.environ["FASTMCP_CHECK_FOR_UPDATES"] = "off"

from fastmcp import FastMCP

from zotero_jobs import (
    ZoteroImportJobResult,
    ZoteroImportJobStatusResult,
    create_internal_error_job_result,
    create_internal_error_job_status_result,
    get_zotero_import_job as get_zotero_import_job_request,
    stage_zotero_import_job as stage_zotero_import_job_request,
)
from zotero_status import (
    ZoteroBridgeStatus,
    create_internal_error_status,
    read_zotero_bridge_status,
)

mcp = FastMCP(
    "Zotero Gemini Notebook MCP",
    instructions=(
        "Report whether the installed Zotero Gemini Notebook bridge supports "
        "the MCP diagnostics, whether the user has opted in, and whether the "
        "existing handoff queue contains staged sources. This adapter does not "
        "expose attachment contents, local authentication material, or "
        "filesystem paths. It can stage an idempotent Zotero import job from "
        "stable item or collection keys and read back that job's sanitized "
        "lifecycle state, but staging or submission does not mean that Chrome "
        "created a Gemini Notebook or verified the uploaded sources."
    ),
    mask_error_details=True,
)


@mcp.tool(
    name="get_zotero_bridge_status",
    title="Get Zotero bridge status",
    description=(
        "Check the fixed local Zotero bridge endpoint and return only its "
        "sanitized connector, opt-in, and staged-source status."
    ),
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
def get_zotero_bridge_status() -> ZoteroBridgeStatus:
    try:
        return read_zotero_bridge_status()
    except Exception:
        return create_internal_error_status()


@mcp.tool(
    name="stage_zotero_import_job",
    title="Stage Zotero import job",
    description=(
        "Resolve stable Zotero item or collection keys and stage their "
        "supported local attachments for a new Gemini Notebook import. This "
        "does not create the notebook or claim that any source was uploaded. "
        "Provide exactly one of item_keys or collection_key, and reuse the "
        "same request_id only for the same request."
    ),
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
def stage_zotero_import_job(
    request_id: str,
    library_id: int,
    item_keys: list[str] | None = None,
    collection_key: str | None = None,
    recursive: bool = False,
) -> ZoteroImportJobResult:
    try:
        return stage_zotero_import_job_request(
            request_id=request_id,
            library_id=library_id,
            item_keys=item_keys,
            collection_key=collection_key,
            recursive=recursive,
        )
    except Exception:
        return create_internal_error_job_result()


@mcp.tool(
    name="get_zotero_import_job",
    title="Get Zotero import job",
    description=(
        "Read one previously returned opaque Zotero import-job ID and return "
        "only its sanitized lifecycle state, counts, and timestamps. This "
        "does not return source metadata, files, claim credentials, or a "
        "Gemini Notebook URL."
    ),
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
def get_zotero_import_job(job_id: str) -> ZoteroImportJobStatusResult:
    try:
        return get_zotero_import_job_request(job_id=job_id)
    except Exception:
        return create_internal_error_job_status_result()


if __name__ == "__main__":
    mcp.run(transport="stdio", show_banner=False)
