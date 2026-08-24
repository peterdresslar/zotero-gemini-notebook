# MCP Bridge Architecture

Issue [#4](https://github.com/peterdresslar/zotero-gemini-notebook/issues/4)
tracks a `0.4.0` bridge that will let a trusted local agent create and populate a
Gemini Notebook from Zotero-managed sources.

> [!IMPORTANT]
> This document describes the target architecture and the internal foundations
> for it. The current beta contains a repository-local adapter with one
> read-only connector-status tool and one authenticated staging tool. It does
> **not** autonomously create a Gemini Notebook, drive Chrome, or verify an
> import.

## Product Contract

After the user explicitly configures a trusted local agent client, that client
may run an authorized notebook-import job without asking for a confirmation
click for every transfer. This is trusted agent autonomy within the existing
product boundary, not unrestricted access to Zotero, the filesystem, or Chrome.

The initial user-facing MCP workflow will be able to:

1. identify a Zotero library and either a collection key or explicit item keys;
2. ask Zotero to resolve the supported local attachments and create a job with
   a frozen attachment-record allowlist;
3. let the installed Chrome companion create a Gemini Notebook and transfer only
   the files authorized for that job; and
4. query the job until the expected sources are visibly present in Gemini
   Notebook or the job reaches an honest non-success state.

The first planned MCP tools are:

- `create_notebook_from_zotero`, which returns a job ID and sanitized
  staged/skipped counts; and
- `get_notebook_job`, which returns sanitized state, counts, timestamps,
  actionable failure information, and the notebook URL when known.

An idempotent `cancel_notebook_job` may be added with the job controller. Audio
and Video Overview controls are valuable follow-up work, but they are not part
of the initial source-import contract.

## Component Boundaries

The complete bridge will use four deliberately separate components:

```text
MCP host --stdio--> local Python FastMCP adapter --authenticated loopback--> Zotero plugin
                                                                            |
                                                                            v
                                                installed Chrome companion --> Gemini Notebook
```

### MCP host and local Python FastMCP adapter

The MCP adapter is a separate local Python process built with FastMCP 3.x and
using MCP's standard stdio transport. It runs outside Zotero's Firefox runtime
even if its files are eventually distributed with the product.

The checked-in adapter pins FastMCP `3.4.7` exactly and commits its complete
`uv.lock`. `get_zotero_bridge_status` reads the existing fixed loopback status
endpoint and returns an allowlisted diagnostic result. The first authenticated
action, `stage_zotero_import_job`, accepts stable Zotero keys and creates only a
bounded job in the existing Chrome handoff queue. Its result contains an opaque
job ID, state, counts, and timestamps—not sources or paths. The opt-in result is
not an authentication credential.

The autonomous workflow tools will build on the staging preview's separately
authenticated loopback calls. Generated launch guidance must not use an
unpinned `fastmcp` dependency or a floating `>=3` range. Its stdio launch tuple
will keep the runtime executable, arguments, and adapter entrypoint distinct
and will use absolute, stable paths. Changing the framework pin will be a
deliberate release change with adapter tests, not a client-side automatic
upgrade.

The adapter is a control plane only. MCP tool arguments and results may contain
stable Zotero identifiers, job identifiers, sanitized counts and status, and a
Gemini Notebook URL when known. They must never contain attachment bytes,
filesystem paths, browser cookies, or Gemini page contents.

### Zotero plugin

Zotero is the job authority. It resolves stable Zotero identifiers, selects
supported local attachments, records each job's attachment allowlist, owns all
job transitions, and publishes sanitized status.

Only Zotero may turn a collection or item request into attachment access. An
external caller must not be able to supply a Zotero database row ID, attachment
ID, raw file path, or file contents as a substitute for that resolution step.

### Chrome companion

Chrome is the data plane for Gemini Notebook. The installed companion claims an
authorized job, obtains only the files in that job's frozen allowlist, creates
or opens the intended notebook, submits the files through Gemini's browser UI,
and reports observations back to Zotero.

Gemini Notebook is still controlled through third-party DOM automation. Chrome
therefore reports distinct handoff and verification events; it does not decide
that message delivery or file-input injection equals success.

### Gemini Notebook

Gemini Notebook is the destination and the source of truth for final import
verification. The bridge may report `verified` only after the Chrome companion
observes the expected sources in Gemini's source UI.

## Stable Zotero Inputs

Public agent requests identify a stable Zotero `libraryID` plus exactly one of:

- a Zotero collection key; or
- one or more Zotero item keys.

These keys are stable within their Zotero library. Numeric item and attachment
database IDs are process-local implementation details and are not part of the
MCP or future loopback contract. Zotero resolves keys to current items and
attachments when it creates a job, records unsupported or missing sources as
sanitized skipped results, and then freezes the set of allowed attachment
records.

That record allowlist prevents a second staging action or a guessed attachment
identifier from expanding a job. It is not a byte snapshot: the current file is
resolved from the same Zotero attachment record when Chrome requests it. If the
user changes or removes that attachment before handoff, the bytes may change or
the fetch may fail. Content hashing or a private path-and-identity snapshot is a
separate pre-network design decision if stronger immutability is required.

## Job Semantics

The bridge uses explicit states so each status claim says what has actually
happened:

```text
staged -> claimed -> submitted -> verifying -> verified
   |         |           |            |
   `---------+-----------+------------+-> unverified / failed / cancelled / expired
             `--------------------------> superseded
```

| State        | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `staged`     | Zotero resolved the request and froze its supported attachment allowlist.                                     |
| `claimed`    | The installed Chrome companion accepted responsibility for the job.                                           |
| `submitted`  | Chrome handed the job's files to Gemini's uploader. Processing may still fail.                                |
| `verifying`  | Chrome is comparing Gemini's visible source UI with the expected job sources.                                 |
| `verified`   | Chrome observed the expected sources in the destination notebook. This is the only successful terminal state. |
| `unverified` | Chrome submitted the sources but could not conclusively observe the expected result.                          |
| `failed`     | A non-retryable error or exhausted retry policy stopped the job.                                              |
| `cancelled`  | An authorized cancellation stopped further work. Repeating cancellation is harmless.                          |
| `expired`    | The job exceeded its bounded lifetime before completion.                                                      |
| `superseded` | A permitted replacement made an older unclaimed job obsolete.                                                 |

If submission happened but DOM verification is inconclusive, status must remain
non-successful. It may stay in `verifying` while bounded retries remain, then
become `unverified`. It must never be promoted to `verified` merely because the
injector accepted a message or populated a file input.

Every status DTO should expose only the information needed to understand and
recover the job: its opaque ID, current state, counts, timestamps, notebook URL
when known, and stable machine-readable error information. Source contents and
private browser state do not belong in status.

## Pending-Job and Idempotency Rules

The first controller intentionally supports one pending `staged` job slot. This
keeps the attachment allowlist unambiguous without claiming that the current
Chrome companion can report a complete job lifecycle.

- A request with a new idempotency key may create a job only under the
  controller's pending-slot rule.
- Repeating the same idempotency key with the same normalized request returns
  the existing job rather than staging a duplicate transfer.
- Reusing an idempotency key with different input is a conflict.
- Creating a different job while the slot is occupied requires an explicit,
  permitted replacement. Replacement marks the older unclaimed job
  `superseded`; it does not silently delete it.
- Human staging deliberately uses that replacement behavior to preserve the
  established rule that a newly supported batch replaces the previous pending
  batch.
- Claiming a job clears the pending slot but retains the claimed job and its
  attachment-record allowlist in history for a bounded lifetime. A human
  selection may narrow that allowlist at claim time but can never expand it. A
  later human action may therefore stage a new pending job without mutating the
  claimed record.
- Cancellation and terminal-state updates are idempotent. Stale updates for a
  superseded, expired, or otherwise terminal job cannot mutate a newer pending
  job.

Clearing the slot on claim is a compatibility boundary for the current
transitional Chrome handoff, which does not yet send terminal job callbacks.
Once Chrome reports the full lifecycle, the autonomous controller can enforce
one agent-controlled in-flight job as well as one pending slot. Until then,
claimed jobs expire after one hour so repeated imports cannot retain attachment
allowlists for the lifetime of the Zotero process.

The first beta scans at most 256 candidate items and 1,000 collections,
enforces at most 50 staged sources, 200,000,000 bytes per source, 200,000,000
bytes for the complete staged batch, and a one-hour lifetime from staging. The
source count and per-file ceiling track Google's documented free
[Notebook and upload limits](https://support.google.com/notebooklm/answer/16215270),
while the lower aggregate ceiling bounds the current Chrome companion's
in-memory batch. These limits belong to the Zotero-owned job rather than to MCP
transport logic. Each admitted per-source byte bound remains private in that
job; the file endpoint revalidates the current regular file and caps the actual
read so later file growth cannot bypass the staged limits.

## First Foundation PR

The first issue #4 PR introduces the job abstraction and its tests inside the
Zotero plugin. It replaces the anonymous mutable staged batch with a job-scoped
attachment-record allowlist, sanitized public data-transfer objects, and a
narrow in-process API.
The existing human staging flow calls the same job authority so later MCP work
does not create a parallel security model.

The frozen `addon.api` surface provides:

- asynchronous `createJob(input)`;
- synchronous `getJob(jobId)` and `getActiveJob()`; and
- idempotent `cancelJob(jobId)`.

Agent-oriented creation requires `destination: "new"`, a stable `libraryID`,
and exactly one source selector: `itemKeys` or `collectionKey`. Collection
requests may set `recursive` (normalized to `false` when omitted). `requestId`
supplies the idempotency key, and an explicit `replace` option requests the
permitted replacement behavior. Numeric item or attachment IDs are rejected.
The returned snapshot contains job metadata and counts, not resolved items or
paths.

Human staging uses the internal controller with a `human` origin and an
`active-or-new` destination. It shares job invariants with the agent API without
making the human UI call an MCP-shaped interface.

This boundary is intentionally in-process. The first PR does **not** add:

- an MCP package or stdio server;
- local authorization storage;
- a new HTTP mutation or job-control endpoint;
- autonomous Chrome job claiming; or
- a claim that the MCP feature can already be installed or used.

Deferring network mutation is a security requirement, not just packaging work.
The job model and public DTOs can be tested without prematurely exposing
agent-control methods through the current browser-facing local server.

The legacy browser endpoints retain their existing Zotero request-header
boundary for released companion compatibility; they do not deliberately enable
wildcard CORS. Updated companion code echoes the job ID for file reads and
clearing so a stale popup cannot consume a replacement job. Older companions
remain an explicitly legacy, unscoped path. A job ID is a correlation
identifier, not a credential. Future agent-control endpoints must not reuse
this browser-request authorization boundary.

## Configuration, Diagnostic, and Staging Preview

The current phase adds the user-facing configuration surface, a narrow
read-only MCP diagnostic, and authenticated staging. The Zotero Tools menu
provides **Gemini Notebook Connector** with separate **Export to Gemini
Notebook...** and **Configure MCP...** actions. MCP support remains off by
default.

The configuration dialog may store Zotero-owned preferences, select a supported
MCP client preset, and resolve or accept separate runtime-executable, adapter-
entrypoint, and client-configuration locations. Saving the enabled state also
creates or validates the private local authorization material required for the
adapter's second hop into Zotero. That implementation detail is provisioned
automatically and is not part of MCP client configuration. A later phase will
generate setup text for the user to copy. The dialog must not edit Codex,
Claude, or another client's configuration file. It also does not install
Python, `uv`, or FastMCP; start an adapter process; or claim that staging means
the planned notebook workflow has completed.

Client presets are configuration guidance rather than model behavior. Codex,
Claude Desktop, and Claude Code use different configuration surfaces, so each
future formatter will stay isolated and can be updated when a client format
changes. Generated stdio configurations will use separate command and argument
fields plus absolute paths. The adapter path must be stable across Zotero plugin
updates; an unpacked, version-specific extension path is not a durable client
target.

Enabling the preference prepares the private local authorization boundary for
control calls. The diagnostic remains read-only, and the staging action accepts
only stable Zotero keys and returns no source metadata. See the
[MCP adapter beta guide](../mcp-adapter/README.md) for the current local setup
and test commands.

## Local Authorization and Network Security

MCP itself uses the standard stdio process boundary and has no pairing
ceremony. The unusual boundary is the adapter's second hop into Zotero's
already-running loopback server. Zotero therefore creates one private,
mode-restricted local bridge key after the user explicitly saves MCP as enabled.
The adapter discovers that fixed local file automatically; users do not copy,
configure, or manage it.

Control requests carry a fresh timestamp, nonce, and HMAC-SHA256 signature over
the method, path, media type, and request-body digest. The digest remains inside
the signed canonical value rather than appearing in Zotero's logged request
headers. The key never crosses HTTP or MCP, and replayed nonces are rejected. A
successful authentication check includes a domain-separated,
request-bound response signature, so the adapter also verifies that the local
server possesses the key. This avoids placing a reusable bearer token in
headers that Zotero's server may record in debug logs. Zotero also rejects
browser-originated control requests; the endpoint does not opt into CORS or
wildcard CORS, and it suppresses control responses from debug logging. The
current internal authentication-check request has the exact body `{}`.

On POSIX systems both Zotero and the adapter require `0700` private directories
and a `0600`, 32-byte regular key file; the adapter also rejects symlinks,
unexpected ownership, and hard-linked files. Windows relies on the current
user profile's inherited ACLs because POSIX mode bits are unavailable. This
protects the local bridge from browser pages, accidental callers, and other OS
users. It is not protection from malicious software already running as the same
user, which can generally access that user's Zotero data directly.

Missing or invalid local authorization fails closed. The configuration UI
presents this as a generic local setup state; an explicit reset action appears
only when recovery is needed. It never displays key material or its filesystem
path.

Every source or job-control endpoint must implement and preserve the same
reviewed authenticated boundary. The bridge must:

- require explicit local opt-in and private local authorization;
- authenticate every agent-control request and require a request-bound server
  proof before trusting a successful response;
- bind to loopback and reject non-loopback access;
- reject browser-originated requests and avoid wildcard CORS on control
  endpoints;
- accept only stable library, collection, and item identifiers;
- serve files only from the exact allowlist frozen into the claimed job;
- enforce job ownership, idempotency, TTLs, count limits, and byte limits;
- avoid broadening Chrome host, cookie, or tab permissions; and
- avoid logging credentials, file contents, local paths, filenames, private
  library metadata, browser cookies, or Gemini page state.

Network responses must be built from explicit allowlisted DTO schemas.
The internal job store's defensive JSON filtering is not an authentication or
privacy boundary for untrusted input.

Zotero's server records ordinary JSON, form, and text request bodies before an
add-on endpoint runs. The staging endpoint therefore puts no private library
identifiers in those logged body types, headers, or query parameters. It uses a
fixed vendor media type, a 16 KiB raw-body limit, HMAC verification over the
exact bytes, and strict canonical parsing into an allowlisted schema only after
verification. Future control calls must preserve that boundary.

The existing human Chrome transport and any future authenticated control
transport should remain separate enough that adding MCP does not turn a browser
origin into an agent authority.

## Road to `0.4.0`

The work is intentionally phased so each security and truthfulness boundary can
be reviewed before the next one depends on it.

1. **Job foundation:** replace anonymous staging with the tested Zotero job
   authority, sanitized DTOs, stable-key resolution boundaries, and the narrow
   in-process API. Preserve the current human workflow.
2. **Configuration foundation:** add the disabled-by-default Zotero UI and
   record client presets and locations for later copy-only setup guidance,
   without installing an adapter or modifying external client files.
3. **Diagnostic and local-authorization foundation:** add the
   exact-version-pinned FastMCP stdio process, one read-only status tool, and
   automatic local bridge authorization without exposing source data or
   mutations.
4. **Authenticated job control:** add the first narrow authenticated staging
   endpoint and retain the same no-browser, no-CORS, log-safe boundary for later
   status and cancellation operations.
5. **Chrome job identity:** extend the current fetch-and-clear job binding
   through submission, failure, retry, and cancellation. Retain retryable state
   instead of clearing it on message delivery.
6. **Verification:** add autonomous claiming, new-notebook creation, and source
   list comparison so `verified` reflects visible Gemini state.
7. **Workflow tools:** replace the current staging-only preview with the
   truthful create-and-verify workflow, add job status, and add cancellation
   only if it remains safely idempotent.
8. **Release gates:** document setup, privacy, recovery, compatibility, and
   tested versions; complete the automated and live end-to-end checks for
   `0.4.0`.

## Verification Gates

### Automated gates

- State-transition tests reject impossible, stale, and post-terminal updates.
- Stable-key resolution tests reject unknown libraries and collections, count
  missing or unsupported requested items as sanitized skips, and never accept
  arbitrary attachment IDs or paths.
- Snapshot tests prove a job serves only its frozen attachment allowlist.
- Idempotency and replacement tests cover duplicate requests, key conflicts,
  superseding an unclaimed job, and protecting a claimed job.
- Sanitization tests prove public DTOs contain no attachment bytes or local file
  paths.
- Authentication and staging-endpoint tests cover missing or wrong
  authorization, browser origins, query rejection, replay and clock windows,
  exact request bodies, canonical encoding, and size limits.
- Chrome tests distinguish claimed, submitted, verifying, verified, retryable,
  and terminal failure paths.

### Manual and end-to-end gates

- The existing Zotero dialog and context-menu workflows still stage and import
  supported sources through the Chrome companion.
- A supported MCP host can stage a job from both a collection key and explicit
  item keys with `stage_zotero_import_job`.
- Chrome can claim exactly that job, create a notebook, transfer only its
  sources, and retain useful status across expected page latency.
- `submitted` is visible before verification, and a missing or renamed Gemini
  source never produces `verified`.
- Timeout, DOM incompatibility, cancellation, expiry, replacement, retry, Zotero
  restart, Chrome reload, and version mismatch paths produce actionable and
  truthful status.
- Logs and MCP results are inspected for source contents, local paths,
  credentials, cookies, and private page state.
- The complete create-to-`verified` workflow passes on the documented supported
  Zotero, macOS, and Chrome versions before `0.4.0` is released.

Issue #4 is complete only when a configured, trusted MCP client can run that full workflow
and observe `verified` after the expected Gemini sources appear. The internal
job foundation alone deliberately does not satisfy that close condition.
