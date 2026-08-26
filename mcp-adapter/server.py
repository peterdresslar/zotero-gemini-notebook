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
        "created a Gemini Notebook or verified the uploaded sources. This "
        "server does not search library metadata, rank sources, or inspect "
        "attachment contents. If another Zotero interface performs discovery "
        "or selection, attribute those actions to that separate interface. "
        "After a staging call, interpret the returned state rather than the "
        "tool verb, and lead with the returned state and message before "
        "listing sources. If the state is staged, say that the files are "
        "queued only in Zotero, "
        "that no upload has occurred, and that the user must finish the "
        "handoff with the Zotero to Gemini Notebook Chrome extension. Treat "
        "expiresAt as Unix epoch milliseconds. A non-staged result from this "
        "tool may be an idempotent replay; do not call it newly queued."
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
    title="Queue Zotero sources for Chrome import",
    description=(
        "Resolve stable Zotero item or collection keys and stage their "
        "supported local attachments for a later Chrome import. Report the "
        "returned state and message before any source summary. A staged job "
        "only queues files in Zotero; it does not create a notebook or upload "
        "a source. To continue, the user opens Gemini Notebook in Chrome—home "
        "for a new notebook or the intended existing notebook—then opens the "
        "Zotero to Gemini Notebook extension and clicks Import. An idempotent "
        "retry returns the existing job at its current state—even submitted or "
        "expired—and does not restage files or extend expiresAt. Do not call it "
        "a newly created queue based on the tool name or status alone; report "
        "the returned state. Use a new request_id for a new handoff. expiresAt "
        "is Unix epoch milliseconds; new jobs normally expire one hour after "
        "staging. itemCount is the number of queued files. skippedCount counts "
        "requested or resolved candidates not admitted as supported readable "
        "local attachments; it does not identify individual reasons. Provide "
        "exactly one of item_keys or collection_key, and reuse the same "
        "request_id only for the same request."
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
        "only its sanitized lifecycle state, counts, timestamps, fixed "
        "actionable message, and retryability. Report the returned state and "
        "message together; submitted means only that Chrome handed files to "
        "Gemini's uploader. This does not return source metadata, files, claim "
        "credentials, or a Gemini Notebook URL."
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
