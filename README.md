# Zotero → Gemini Notebook

> **Updated (again!) for new Google branding**: The Chrome extension now correctly anticipates the correct URL
> for Gemini Notebook (_nee_ NotebookLM):
> [notebook.google.com](https://notebook.google.com)

Want an easier way to build notebooks in Gemini Notebook from Zotero files on
your computer? This connector lets you browse your Zotero collections, stage
source files, and send them to Gemini Notebook without manually digging through
Zotero's filesystem.

While the direct interface with the browser window is tricky to make perfect,
we've made an effort to make the upload of Zotero articles to the web as
seamless as possible.

<p align="center">🌴 🌴 🌴</p>

<p align="center">
  <img src="public/zotero-gemini-notebook.png" alt="Chrome extension popup showing 6 Zotero sources staged for import to Gemini Notebook" width="400">
</p>

## Why

Zotero stores PDFs in opaque, key-based folder names. Manually gathering files
from a subcollection and uploading them to Gemini Notebook is tedious and
error-prone. This tool automates the handoff: browse your collections in
Zotero, pick your sources, and push them to Gemini Notebook.

## How It Works

The system has two parts:

1. **Zotero Plugin** — Adds an "Export to Gemini Notebook" dialog to Zotero's
   Tools menu. Browse your collection tree, search/filter items, and select
   which sources to stage. The plugin registers endpoints on Zotero's local
   HTTP server. The Chrome companion connects through `127.0.0.1`, and file
   requests are rejected unless the attachment was explicitly staged.

2. **Chrome Extension** — Connects to the Zotero plugin's local server, fetches
   the staged files, and uploads them into Gemini Notebook. Google Chrome is
   required; Firefox and other browsers are not supported.

## Installation

For normal use, install from the latest GitHub release. You do not need Node.js
or pnpm unless you are building from source.

### Download

1. Open the
   [latest release](https://github.com/peterdresslar/zotero-gemini-notebook/releases/latest).
2. Download both installable assets. Releases from `v0.3.0` use:
   - `zotero-gemini-notebook.xpi`
   - `zotero-gemini-notebook-chrome-extension.zip`

   The `v0.2.0` release retains the former NotebookLM filenames:
   - `zotero-notebook-lm.xpi`
   - `zotero-notebooklm-chrome-extension.zip`

3. Unzip the Chrome extension `.zip` somewhere you can keep it. Chrome loads
   the extension from that folder, so do not delete it after installation.

If there is not a published release yet, use the source build steps below.

### Install the Zotero Plugin

1. Open Zotero.
2. Go to **Tools → Plugins**.
3. Drag the downloaded `.xpi` onto the Plugins window, or use its gear menu and
   choose **Install Plugin From File...**.
4. Restart Zotero if prompted.

### Install the Chrome Extension

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the unzipped Chrome extension folder. It should be the folder that
   contains `manifest.json`.
5. Optional: pin **Zotero → Gemini Notebook** to your Chrome toolbar.

Zotero checks the plugin's update manifest for compatible releases. The unpacked
Chrome extension does not update automatically: download the latest release,
replace the files in its existing folder, and click **Reload** on
`chrome://extensions/`. If you move it to a new folder, remove the old unpacked
extension and use **Load unpacked** again. From v0.3.0 onward, the Chrome
companion checks the compatible-version list advertised by the Zotero plugin.
When the version direction is clear, the warning identifies which side needs
attention: an older Chrome companion must be replaced manually, while an older
Zotero plugin can usually be updated from **Tools → Plugins → gear menu →
Check for Updates** in Zotero. The Zotero plugin also retains still-compatible
earlier companion versions so either component can receive its update first
when that is safe.

### Source Build

Use this path only if you want to build the project locally.

Prerequisites:

- Node.js 22+
- pnpm
- Git
- Zotero 7, 8, or 9
- Google Chrome (required for the companion extension)

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run package:release
```

The generated install files are:

```text
.scaffold/build/zotero-gemini-notebook.xpi
.scaffold/build/zotero-gemini-notebook-chrome-extension.zip
```

Install those files using the same Zotero and Chrome steps above.

## Usage

### Step 1: Stage Sources in Zotero

For a quick handoff, select one or more regular items in Zotero's items pane,
right-click, and choose **Export Selected to Gemini Notebook**. Zotero stages
the supported local attachments immediately. A selection with at least one
supported attachment replaces the previously staged batch; an unsupported-only
selection leaves that batch intact.

For collection browsing, searching, or more deliberate selection:

1. Open Zotero and go to **Tools → Export to Gemini Notebook...**
2. Browse the collection tree on the left to find your subcollection
3. Use the search box to filter items by title, author, or year
4. Click items to select them (checked items will be exported). Items without a
   supported local PDF, DOCX, Markdown, or text attachment are greyed out.
5. Click **Export to Gemini Notebook** to stage the selected files

### Step 2: Import into Gemini Notebook

1. Open [Gemini Notebook](https://notebook.google.com) in Chrome. Both the
   current `notebook.google.com` host and the legacy `notebooklm.google.com`
   host are supported. You may open an existing notebook, or start from the
   main page and let the extension create a new notebook.
2. Click the Zotero → Gemini Notebook extension icon in your Chrome toolbar
3. The popup will show your staged sources with a green "Zotero connected" indicator
4. Click **Import to Gemini Notebook**
5. The extension will fetch each file from Zotero, then upload them all to
   Gemini Notebook's sources panel.

### Tips

- Keep Zotero running while importing — the Chrome extension fetches files from
  Zotero's local server.
- You can deselect items in the Chrome popup if you change your mind
- After a successful import, staged items are automatically cleared
- Keep the Gemini Notebook tab open until the import starts.
- If the import does not start, use **Add sources** in Gemini Notebook to open the
  file dialog, then click **Upload files**.
- If the import fails, refresh the Gemini Notebook tab and try again.

## Development

Use the source build command above to produce release-style install files.

During Chrome-extension development, you can load `chrome-extension/` directly
in `chrome://extensions/` and click **Reload** after editing extension files.

Before opening a PR, run:

```bash
pnpm run package:release
pnpm run lint:check
```

Maintainers should follow the
[release and auto-update checklist](docs/releasing.md) before publishing a new
version.

The planned agent/MCP bridge is not installable yet. Its trust boundary, job
model, and phased `0.4.0` roadmap are documented in
[MCP Bridge Architecture](docs/mcp-bridge.md).

## Known Issues

- Large batches may take longer to start because Gemini Notebook creates its
  upload controls asynchronously.
- Gemini Notebook's DOM structure may change without notice, which could break
  the upload mechanism.

## License

MIT — see [LICENSE](LICENSE).
