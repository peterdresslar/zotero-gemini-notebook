# Agent Working Agreement

This repository is maintained by Peter Dresslar with help from coding agents and human contributors. Treat this file as the shared contract for how work should be planned, changed, reviewed, and shipped.

## Project Boundary

This project is a Zotero plugin plus a Chrome extension for moving staged Zotero sources into Gemini Notebook (formerly NotebookLM). Keep changes inside that product boundary unless an issue or maintainer decision explicitly expands the scope.

An agent-facing or MCP-style interface is within scope when it serves the same workflow: allowing a trusted chatbot or automation client to select Zotero collections or items and create or populate a notebook in Gemini Notebook from those sources. Such work should reuse the same staging, permission, and local-server safety boundaries rather than opening broad library or filesystem access.

The integration with Gemini Notebook is browser-DOM automation against a third-party web app because stable public API access is not generally available to non-business users. Assume this DOM path is inherently brittle. Prefer small, well-isolated changes that make the failure modes easier to understand and recover from.

If supported Gemini Notebook API access becomes available, that should improve the transport path rather than obsolete the project. Keep the product centered on moving Zotero-managed sources into Gemini Notebook with the least brittle available mechanism for the user.

## MCP Bridge Decisions

MCP is explicit-opt-in trusted local automation, not a general Zotero, filesystem, or browser interface. Zotero remains the job and attachment authority; the stdio adapter is a control plane and the installed Chrome companion is the Gemini data plane. Public requests use stable Zotero keys and must not expose attachment bytes, paths, or private browser or Gemini state.

Chrome may transfer only the claimed job's bounded allowlist. Agent jobs use `active-or-new`: importing from a notebook detail page targets that notebook, while importing from the Gemini Notebook home page creates one. Submission or file-input injection is not success; `verified` requires observing the expected sources in Gemini. Existing-notebook imports remain manually confirmed unless a separately reviewed baseline-and-delta verifier is added.

Auto-configure is an explicit confirmed action that installs or validates the bundled adapter and registers it through the selected client's own interface. It must not invoke a shell, edit client configuration directly, install prerequisites, or alter unrelated MCP servers. Codex, Claude Code, and Gemini CLI are guided clients for this beta; Claude Desktop packaging and automatic setup are a later milestone.

## Roles

Humans own product direction, release decisions, issue prioritization, and security tradeoffs.

Agents may inspect, implement, test, document, and prepare PRs. Agents should make reasonable local engineering decisions, but should pause before changing the product shape, dependency strategy, release process, or security model.

Do not overwrite or revert work you did not make unless the maintainer explicitly asks for that operation.

## Branch And PR Discipline

Do not commit directly to `main`. Use a branch for every change and open a PR.

Keep PRs reviewable. A good default is one PR for one issue or one coherent maintenance task. Avoid mixing bug fixes, dependency migrations, UI polish, and documentation rewrites unless the PR description explains why they belong together.

Link PRs to the relevant GitHub issue when one exists.

## GitHub Ruleset

The active `Solo-to-Small Workflow` ruleset blocks direct commits to `main`, default-branch deletion, and non-fast-forward updates. The PR is the required self-review surface; no second approval is required, but ask for review when risk, scope, or security warrants it. Do not merge while required checks are red unless the maintainer explicitly authorizes an emergency bypass.

## Commit Messages

Follow GitHub-friendly commit messages. Use a short imperative subject, include the relevant issue number when one exists, and keep the body focused on why the change was made.

When a commit closes or fixes an issue on merge, use GitHub keywords in the PR description rather than forcing every commit subject to carry `Fixes #...`.

## Merge Policy

Squash merge PRs by default to keep `main` readable.

Use a regular merge only when the PR has a deliberately structured commit history that is useful to preserve. Do not use rebase merges unless the maintainer explicitly asks for one.

Before merging, make sure the final PR title and description are accurate, because the squash commit will usually become the durable history entry.

## Package Management

_Please_ use `pnpm` for dependency installation and scripts.

Avoid adding new runtime dependencies unless they materially reduce complexity or match an established project pattern.

## Local Tooling

Keep personal editor, IDE, browser-profile, and local-agent state out of the repository. Do not add `.vscode`, `.idea`, `.cursor`, `.zed`, `.agents`, `.codex`, or similar tool-specific folders.

Shared project standards should live in editor-neutral files such as `AGENTS.md`, `package.json`, `tsconfig.json`, ESLint config, Prettier config, and test configuration. If a tool-specific setup becomes necessary, document the reason in the PR and prefer an editor-neutral script or command when possible.

## Verification

Before marking work ready for review, run the relevant checks for the files you touched. For typical code changes, expect:

- `pnpm install --frozen-lockfile`
- `pnpm run build`
- `pnpm run lint:check`

When automation cannot cover the behavior, document the manual verification in the PR. Browser-extension and Gemini Notebook DOM behavior usually needs manual testing in Chrome with Zotero running.

## Releases

Humans decide when to publish a release. The Zotero plugin and Chrome companion ship as one version, although only the `.xpi` auto-updates. In the release PR, set the same version in `package.json` and `chrome-extension/manifest.json`, review `companionCompatibility.validVersions`, confirm `addon/manifest.json` reflects the Zotero minor actually tested, and add `docs/releases/v<version>.md`. Never change `zotero-notebooklm@peterdresslar.com` or recreate the legacy `peterdresslar/zotero-notebooklm` repository; installed copies depend on those identities and redirects.

For the release PR and again after merging on a clean, current `main`, run:

```bash
pnpm install --frozen-lockfile
pnpm run test:mcp
pnpm run package:release
pnpm run lint:check
```

Create an annotated tag for the merged commit and a draft versioned GitHub release containing exactly `.scaffold/build/zotero-gemini-notebook.xpi`, `.scaffold/build/zotero-gemini-notebook-chrome-extension.zip`, and `.scaffold/build/update.json`. Publish it without marking it Latest, then validate the public manifest and XPI with `pnpm run release:verify-published --manifest-url <versioned-update-json-url>` before promotion.

The prerelease tagged `release` is Zotero's permanent stable updater endpoint and should contain only active `update.json` plus rolling `update.backup.json`; there is no beta channel. Promote only with:

```bash
pnpm run release:promote --from-version <previous-version> --dry-run
pnpm run release:promote --from-version <previous-version>
```

Stop on a dirty tree or any build, public-validation, or promotion failure; the promoter is resumable. Mark the versioned release Latest and announce only after promotion and applicable public-package testing succeed. Specifically exercise changes to browser or Gemini DOM behavior, transfers above Chrome's 64 MiB message limit, MCP job lifecycle, or updater identity and compatibility. Keep every versioned XPI available while an update manifest can reference it.

For rollback, preserve the failed manifest, restore `update.backup.json` as `update.json`, and verify the previous version. Never leave the permanent updater URL without `update.json`. Rollback prevents further upgrades but does not downgrade installed copies, so follow it with a higher-version fix.

## Extension And Local Server Safety

Keep the Zotero local HTTP server narrow. It should serve only staged items, not arbitrary file paths or unstaged attachments.

Keep CORS and request headers as specific as the workflow allows. Do not broaden host permissions, content-script matches, or local server endpoints without a clear reason.

Do not log file contents, credentials, browser cookies, private library data, or Gemini Notebook page state.

## Browser Automation Boundary

Keep Gemini Notebook selectors and injection logic isolated in the Chrome extension. When Gemini Notebook changes its DOM, fix the smallest reliable interaction path and leave notes about what was manually verified.

Prefer explicit loading, error, retry, and timeout states over silent failure.

## Documentation

Public docs should help a new user install, build, troubleshoot, and report issues without private context.

Keep README changes accurate to the release being prepared. A release-preparation branch may describe the upcoming version, but must not claim that version is publicly available until it is published.

Prefer recording durable maintainer decisions and their rationale. Do not preserve long implementation summaries, protocol walkthroughs, test matrices, or other details that can be reconstructed from code, tests, history, or ordinary tooling.

Use markdown for documentation, and instead of limiting line length please let the paragraphs flow.

## Privacy

Do not commit secrets, personal tokens, private assessment links, generated logs with personal data, or local browser/profile state.

When sharing command output in issues or PRs, remove paths, filenames, or Zotero library details that are not necessary to understand the problem.
