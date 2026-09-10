# Contributing

Contributions are welcome. We keep the process lightweight: agree on the problem, make a focused change, and show how it was tested.

**Read and follow [AGENTS.md](AGENTS.md) before contributing.** It is the authoritative working agreement for this repository and applies to human and agent-assisted contributions alike. Follow any additional `AGENTS.md` instructions in the directories you change. If you use a coding agent, make sure it follows those instructions and review its work yourself. You are responsible for the contribution you submit.

## Issues, branches, and pull requests

- Check existing issues before starting. Open or use an issue for a bug fix or feature so the problem and intended scope are clear. A small documentation correction or routine maintenance change can go straight to a PR.
- Discuss changes to product scope, dependencies, security boundaries, or the release process with the maintainer before implementing them.
- Work on a feature branch, using a fork if needed. Every change goes through a pull request; do not commit directly to `main`.
- Keep each PR focused on one issue or coherent task, and link the relevant issue. Explain what changed, why, and how you tested it. A short description is enough when the change is small.

## Plan for integration testing

Testing a PR here takes some hands-on work. The product spans a Zotero plugin, a Chrome extension, and Gemini Notebook's changing web interface. Installing or reloading both components and exercising them together is labor intensive; please budget for that when choosing the scope of a contribution.

Use `pnpm`. For typical code changes, run:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint:check
```

Run any additional tests relevant to your change, such as `pnpm run test:mcp` for MCP changes. See the [source build instructions](README.md#source-build) for packaging and installing local builds.

For changes affecting behavior, test the PR's Zotero plugin and Chrome companion together with Zotero running and Gemini Notebook open in Chrome. Exercise the affected workflow from staging sources through import, and confirm the expected sources actually appear in the notebook. Include new or existing notebooks, error recovery, large transfers, or the optional MCP client when your change affects those paths. Passing automated checks alone does not establish that the integration works.

In the PR, briefly record the versions and setup you tested, the steps you tried, the results, and anything you could not verify. If you cannot complete the necessary integration testing, open a draft PR and say what still needs testing. Documentation-only changes need checks appropriate to the files changed, not a full import test.

Keep private library details, credentials, and local profile data out of reports and commits. The remaining engineering, review, and release rules live in [AGENTS.md](AGENTS.md).
