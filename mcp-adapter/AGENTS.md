# MCP Adapter Working Agreement

This file supplements the repository-root `AGENTS.md` for work under `mcp-adapter/`.

- Reserve stdout exclusively for MCP. Suppress FastMCP banners, logs, update notices, tracebacks, and other incidental output before importing FastMCP.
- Use only the fixed numeric Zotero loopback endpoints, with proxies and redirects disabled. Authenticate before sending stable Zotero identifiers or job IDs; never transmit the local key or add configurable key-path overrides.
- Keep requests canonical and bounded. Validate authenticated control and job responses strictly, require request-bound response proof, return explicit field allowlists, and fail with fixed sanitized errors. Never expose attachment bytes, paths, source metadata, browser claims, cookies, or Gemini state.
- Preserve staging idempotency: an exact retry returns the existing job at its current state, changed input under the same request ID is a conflict, and the adapter never silently replaces a pending job.
- Keep FastMCP exactly pinned and commit `uv.lock` with dependency changes. Package only the runtime allowlist and treat installed adapter directories as immutable.
- Run `pnpm run test:mcp` for adapter changes and `pnpm run package:release` when packaging or the runtime allowlist changes.

Keep end-user setup in the root README and Zotero UI. Do not recreate a long implementation or testing guide here.
