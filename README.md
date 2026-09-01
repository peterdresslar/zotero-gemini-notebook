# Zotero → Gemini Notebook

> **:sparkle: New in 0.4.0 :sparkle:**
>
> - Zotero 10 support.
> - Upgraded user interaction in the Chrome extension; we're hoping to make the file upload process as transparent as possible.
> - New Beta MCP! Ask your AI agents to prep a notebook upload, head to your browser, and it's ready to load. A feature we hope to expand in the future.

Want an easier way to build notebooks in Gemini Notebook from Zotero files on your computer? This connector lets you browse your Zotero collections, stage source files, and send them to Gemini Notebook without manually digging through Zotero's filesystem.

While the direct interface with the browser window is tricky to make perfect, we've made an effort to make the upload of Zotero articles to the web as seamless as possible.

<p align="center">🌴 🌴 🌴</p>

<p align="center">
  <img src="public/zotero-gemini-notebook.png" alt="Chrome extension popup showing 6 Zotero sources staged for import to Gemini Notebook" width="400">
</p>

## Why

Zotero stores PDFs in opaque, key-based folder names. Manually gathering files from a subcollection and uploading them to Gemini Notebook is tedious and error-prone. This tool automates the handoff: browse your collections in Zotero, pick your sources, and push them to Gemini Notebook.

## How It Works

The system has three parts:

1. **Zotero Plugin**: Adds a **Gemini Notebook Connector** submenu to Zotero's Tools menu. Browse your collection tree, search/filter items, and select which sources to stage. The plugin registers endpoints on Zotero's local HTTP server. The Chrome companion connects through `127.0.0.1`, and file requests are rejected unless the attachment was explicitly staged.

2. **Chrome Extension**: Connects to the Zotero plugin's local server, fetches the staged files, and uploads them into Gemini Notebook. Google Chrome is required; Firefox and other browsers are not supported.

3. **MCP**: An optional interface for your preferred AI client to interact with your Zotero articles and prep them for delivery to Gemini Notebook. This feature is in beta and feedback would be greatly appreciated.

## Installation

For normal use, install from the latest GitHub release. You do not need Node.js or pnpm unless you are building from source.

### Download

1. Open the [latest release](https://github.com/peterdresslar/zotero-gemini-notebook/releases/latest).
2. Download both installable assets:
   - `zotero-gemini-notebook.xpi`
   - `zotero-gemini-notebook-chrome-extension.zip`

3. Unzip the Chrome extension `.zip` somewhere you can keep it. Chrome loads the extension from that folder, so do not delete it after installation.

### Install the Zotero Plugin

1. Open Zotero.
2. Go to **Tools → Plugins**.
3. Drag the downloaded `.xpi` onto the Plugins window, or use its gear menu and choose **Install Plugin From File...**.
4. Restart Zotero if prompted.

### Install the Chrome Extension

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the unzipped Chrome extension folder. It should be the folder that contains `manifest.json`.
5. Optional: pin **Zotero-Gemini Notebook Connector** to your Chrome toolbar.

Install the Zotero plugin and Chrome companion from the same release. Zotero can update the plugin automatically, but the unpacked Chrome companion does not update itself: replace its files, click **Reload** on `chrome://extensions/`, and refresh open Gemini Notebook tabs. If the popup reports a version mismatch, update the component it identifies.

### Optional: Configure the MCP

The optional MCP beta stays off until you configure it. It lets a supported AI client check the connector's status, queue supported Zotero attachments, and read the resulting handoff state. It does not search or rank your Zotero library on its own, inspect attachment contents, create a Gemini Notebook, or upload files without the Chrome extension.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/), Python 3.10–3.13, and a supported MCP client. Guided Auto-configure is available for Codex, Claude Code, and Gemini CLI.
2. In Zotero, open **Tools → Gemini Notebook Connector → Configure MCP...**.
3. Select your client and press **Auto-configure**. After you confirm, Zotero installs or validates the adapter bundled in the plugin, registers the single MCP server named `zotero-gemini-notebook`, and enables authenticated local MCP access only if setup succeeds.
4. Restart or reopen the client, then ask it to call `get_zotero_bridge_status`. A working connection reports that the bridge is opted in.

The staging tool accepts stable Zotero item or collection keys supplied by the client. Use another Zotero-aware interface to discover and select sources, or provide keys you already know. After the client queues a job, finish the normal browser handoff in [Step 2: Import into Gemini Notebook](#step-2-import-into-gemini-notebook). Opening the Chrome import from an existing notebook adds the sources there; starting from the Gemini Notebook home page creates a new notebook.

Auto-configure does not install the AI client, `uv`, or Python. Its first preflight may download the adapter's pinned Python packages into uv's isolated cache. Re-running Auto-configure asks for confirmation and replaces only the `zotero-gemini-notebook` registration; it does not reset other MCP servers. Claude Desktop automatic setup is not available in this beta, and its Desktop Extension (`.mcpb`) integration is deferred to a later milestone; **Advanced** provides the manual STDIO settings for developers and custom clients.

### Source Build

Use this path only if you want to build the project locally.

Prerequisites:

- Node.js 22+
- pnpm
- Git
- Zotero 7 through 10. Zotero 9 and 10 are actively tested; support for Zotero 7 and 8 is best-effort.
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

For a quick handoff, select one or more regular items in Zotero's items pane, right-click, and choose **Export Selected to Gemini Notebook**. Zotero stages the supported local attachments immediately. A selection with at least one supported attachment replaces the previously staged batch; an unsupported-only selection leaves that batch intact.

For collection browsing, searching, or more deliberate selection:

1. Open Zotero and go to **Tools → Gemini Notebook Connector → Export to Gemini Notebook...**
2. Browse the collection tree on the left to find your subcollection
3. Use the search box to filter items by title, author, or year
4. Click items to select them (checked items will be exported). Items without a supported local PDF, DOCX, Markdown, or text attachment are greyed out.
5. Click **Export to Gemini Notebook** to stage the selected files

### Step 2: Import into Gemini Notebook

1. Open [Gemini Notebook](https://notebook.google.com) in Chrome. Both the current `notebook.google.com` host and the legacy `notebooklm.google.com` host are supported. You may open an existing notebook, or start from the main page and let the extension create a new notebook.
2. Click the Zotero-Gemini Notebook Connector icon in your Chrome toolbar
3. The popup will show your staged sources with a green "Zotero connected" indicator
4. Click **Import to Gemini Notebook**
5. If the page highlights **Add sources** or **Upload files**, click that Gemini Notebook button once. Chrome requires a genuine page click before Gemini can expose its file input; you do not need to choose the files.
6. The extension will fetch each file from Zotero, then hand them to Gemini Notebook's sources panel.

### Tips

- Keep Zotero running while importing — the Chrome extension fetches files from Zotero's local server.
- You can deselect items in the Chrome popup if you change your mind
- If an MCP import fails or times out, check the notebook's Sources panel first. If anything is missing, restage the sources before starting a new import.

## Development

During Chrome-extension development, you can load `chrome-extension/` directly in `chrome://extensions/` and click **Reload** after editing extension files.

## Known Issues

- Large batches may take longer to start because Gemini Notebook creates its upload controls asynchronously.
- Gemini Notebook's DOM structure may change without notice, which could break the upload mechanism.

## Privacy

The connector processes staged Zotero metadata and files locally, then sends selected files directly to Gemini Notebook only when you start an import. The developer does not receive them. See the [Privacy Policy](PRIVACY.md) for details.

## License

MIT — see [LICENSE](LICENSE).
