# MCP Adapter Beta

This directory contains the first runnable MCP slice for the connector. It is a
repository-local developer preview, not the complete `0.4.0` workflow.

The adapter exposes three deliberately narrow tools:

- `get_zotero_bridge_status` reads Zotero's fixed local status endpoint and
  reports whether the installed plugin supports this diagnostic and whether the
  user opted in;
- `stage_zotero_import_job` asks Zotero to resolve stable collection or item
  keys and place their supported attachments in the existing Chrome handoff
  queue; and
- `get_zotero_import_job` reads one previously returned opaque job ID and
  reports only its sanitized lifecycle state, counts, and timestamps.

The staging result contains only an opaque job ID, state, counts, and
timestamps. It does not return source metadata or files, create a Gemini
Notebook, or claim that Chrome uploaded anything. The user must still open the
Chrome companion and click **Import**. After that click, the current companion
binds its upload batch to the staged job and records `submitted`, `unverified`,
or `failed` in Zotero. The read-only status tool does not return source
metadata, files, browser claim identifiers, or notebook URLs. Autonomous Chrome
wake-up, retries, and visible-source verification remain future work.

## Set up the locked environment

Install [`uv`](https://docs.astral.sh/uv/), then run from the repository root:

```bash
pnpm run mcp:setup
```

This creates an ignored `mcp-adapter/.venv` from the committed `uv.lock`. The
Zotero configuration dialog does not install Python packages or run this
command.

## Test the diagnostic tool

1. Build and install the current candidate XPI.
2. In Zotero, open **Tools → Gemini Notebook Connector → Configure MCP...**.
3. Select **Enable MCP setup (Beta)** and save.
4. Keep Zotero running, then run:

   ```bash
   pnpm run mcp:status
   ```

The structured result should have `status: "opted_in"`. An older plugin that
does not publish the opt-in field reports `unsupported`; a saved disabled state
reports `disabled`; and an unavailable or malformed local endpoint produces a
sanitized failure state. Unexpected adapter failures report `internal_error`
without exception details. `hasStagedSources` and `stagedSourceCount` describe
the existing human handoff queue; they do not mean that notebook-creation MCP
tools are available.

## Test authenticated staging

The staging tool requires a positive Zotero library ID, a unique request ID,
and exactly one stable selector: an eight-character collection key or one or
more eight-character item keys. It deliberately has no replacement option, so
it refuses rather than silently superseding a batch already staged by the user.

For a local developer test, select either one collection or one or more regular
items in Zotero, then use **Tools → Developer → Run JavaScript** to inspect
their stable identifiers. For one selected collection:

```javascript
(() => {
  const pane = Zotero.getMainWindow().ZoteroPane;
  const selected =
    typeof pane.getSelectedCollections === "function"
      ? pane.getSelectedCollections()
      : [pane.getSelectedCollection()].filter(Boolean);
  return JSON.stringify(
    selected.map((collection) => ({
      library_id: collection.libraryID,
      collection_key: collection.key,
    })),
    null,
    2,
  );
})();
```

For selected regular items from one library:

```javascript
(() => {
  const items = Zotero.getMainWindow()
    .ZoteroPane.getSelectedItems()
    .filter((item) => item.isRegularItem());
  return JSON.stringify(
    {
      library_id: items[0]?.libraryID,
      item_keys: items.map((item) => item.key),
    },
    null,
    2,
  );
})();
```

These commands only display identifiers in Zotero's local result window. Do
not include titles, filenames, or other private library data when sharing test
output.

With a current candidate XPI installed and MCP enabled, a collection request
has this form (replace the example IDs):

```bash
uv run --project mcp-adapter --locked fastmcp call \
  mcp-adapter/server.py stage_zotero_import_job \
  --input-json \
  '{"request_id":"manual-test-1","library_id":1,"collection_key":"ABCD1234","recursive":false}' \
  --json
```

An explicit item request uses `"item_keys":["ABCD1234","EFGH5678"]`
instead of `collection_key`. Reuse a request ID only for the exact same
normalized request; a retry then returns the existing job. A different request
with the same ID is rejected. A successful result means only that Zotero staged
the job. Confirm the count in the Chrome companion, click **Import**, and verify
the sources in Gemini Notebook. The companion reports `submitted` only after
Gemini's uploader accepts the file injection; that state does not mean the
sources have finished processing or passed visible-source verification.
After reloading an updated unpacked companion, refresh any already-open Gemini
Notebook tab before importing so its content script uses the same lifecycle
protocol version.

For developer diagnostics, copy the returned job ID and inspect the sanitized
in-memory state from **Tools → Developer → Run JavaScript**:

```javascript
(() => JSON.stringify(Zotero.ZoteroNotebookLM.api.getJob("JOB_ID"), null, 2))();
```

Do not share the full result because it may contain stable Zotero source keys.
After a successful Chrome handoff, inspect only that `state` is `submitted`.

## Read an import job

Use the opaque `jobId` returned by `stage_zotero_import_job`:

```bash
uv run --project mcp-adapter --locked fastmcp call \
  mcp-adapter/server.py get_zotero_import_job \
  --input-json \
  '{"job_id":"123e4567-e89b-42d3-a456-426614174000"}' \
  --json
```

The important lifecycle distinctions are:

- `staged` is waiting for the Chrome companion; `claimed` means the companion
  accepted responsibility for that exact job.
- `submitted` means Chrome handed the files to Gemini's uploader. It does not
  mean Gemini finished processing them or that the visible source list was
  verified.
- `verified` is reserved for a later positive comparison with Gemini's visible
  sources. `verifying` and `verified` are future-facing states that the current
  companion does not report.
- `unverified` means submission could not be conclusively observed; `failed`
  means the current handoff stopped with an error.
- `cancelled`, `expired`, and `superseded` mean the job ended without verified
  completion because it was stopped, exceeded its lifetime, or was replaced.

The status lookup is read-only and returns the same allowlisted field set as
staging: the opaque ID, current state, current counts, and timestamps. If Chrome
claims only a selected subset, `itemCount` reflects that claimed subset. A
`job_not_found` result means the in-memory job is no longer present—for example,
after Zotero restarts or old terminal history is pruned. It is not evidence that
the job ID never existed.

The first beta scans at most 256 candidate items and 1,000 collections, admits
at most 50 supported sources, rejects any source larger than 200,000,000 bytes,
caps the whole staged batch at 200,000,000 bytes, and expires the job one hour
after staging. These conservative limits match Google's documented
[free-user source-count and per-upload ceilings](https://support.google.com/notebooklm/answer/16215270)
while bounding the current Chrome companion's in-memory transfer. Zotero keeps
each admitted byte bound private and checks it again during Chrome's file read;
if a source grows past that bound, the user must stage it again.

Run the adapter test suite with:

```bash
pnpm run test:mcp
```

One subprocess test temporarily binds Zotero's fixed port to prove the exact
status request. It is skipped when Zotero is already using that port; quit
Zotero to exercise that particular test locally.

## Add the preview to an MCP host

Use absolute paths. For Codex, copy and adapt this command:

```bash
codex mcp add zotero-gemini-notebook -- \
  /absolute/path/to/uv run --locked \
  --project /absolute/path/to/zotero-notebooklm/mcp-adapter \
  /absolute/path/to/zotero-notebooklm/mcp-adapter/server.py
```

Start a new Codex session after adding it, then call
`get_zotero_bridge_status`. Remove the preview later with:

```bash
codex mcp remove zotero-gemini-notebook
```

The dialog's client and adapter locations are setup hints only. Zotero does not
read or modify Codex, Claude, or another MCP client's configuration.

## Safety boundary

The adapter uses stdio for MCP and communicates only with fixed numeric loopback
URLs below `http://127.0.0.1:23119/notebooklm/`. It disables proxies, rejects
redirects and oversized or malformed responses, and returns explicit field
allowlists.

The control path has internal localhost authorization; it is not a second MCP
tool or an interactive setup step. It reads only the raw
32-byte key at `~/.zotero-gemini-notebook/mcp/local-bridge.key`, with no
adapter-specific environment-variable or command-line path override. On Unix
it accepts only an owned, non-symlinked, single-link `0600` file inside owned
`0700` directories. It signs a fixed empty-body authentication check with
HMAC-SHA256 and requires a request-bound response proof without ever sending the
key. Before sending stable Zotero identifiers, the adapter completes that
signed check and verifies that the fixed-port listener possesses the key. The
job request then uses a fresh nonce and a vendor media type that Zotero core
does not record as ordinary JSON. On Windows, where POSIX mode bits are
unavailable, privacy relies on the current user's inherited profile ACLs.
