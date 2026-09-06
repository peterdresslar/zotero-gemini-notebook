# Zotero → Gemini Notebook

> **:sparkle: New in 0.5.0 :sparkle:**
>
> - The Chrome Extension is now published to the Chrome Store and will auto-upgrade. You can install just by downloading the Zotero plugin and setup from within the upgraded tools menu.
> - MCP functionality can now include a prompt for Studio creation in Gemini Notebook

Want an easier way to build notebooks in Gemini Notebook from Zotero files on your computer? This connector lets you browse your Zotero collections, stage source files, and send them to Gemini Notebook (formerly NotebookLM) without manually digging through Zotero's filesystem.

While the direct interface with the browser window is tricky to make perfect, we've made an effort to make the upload of Zotero articles to the web as seamless as possible.

<p align="center">🌴 🌴 🌴</p>

<p align="center">
  <img src="public/zotero-gemini-notebook.png" alt="Chrome extension popup showing 6 Zotero sources staged for import to Gemini Notebook" width="400">
</p>

## Why

Zotero stores PDFs in key-based folders that are difficult to find—a _lot_ of folders. Manually gathering files from a subcollection and uploading them to Gemini Notebook is tedious and error-prone. This tool automates the handoff: browse your collections in Zotero, pick your sources, and push them to Gemini Notebook. Or, ask your favorite tool-using agent to do it.

## Getting started

Start with the Zotero plugin, an `.xpi` file you can download to your machine from this link: [latest plugin](https://github.com/peterdresslar/zotero-gemini-notebook/releases/latest/download/zotero-gemini-notebook.xpi). To install the plugin, go to **Tools → Plugins**. In the Plugins window, click the gear and choose **Install Plugin From File...**. More information about Zotero plugins is available [here](https://www.zotero.org/support/plugins/). You may need to restart Zotero once installed.

To check if installation is successful, go to your Tools menu. There should be a new item in the menu called **Gemini Notebook Connector**.

Next, you'll need the Chrome extension that connects Zotero to Gemini Notebook. To get the extension, go to the Gemini Notebook Connector menu and click **Install Chrome Extension**. If that menu item is unavailable, install it directly from the [Chrome Web Store](https://chrome.google.com/webstore/detail/pcjiogpdekoojnbfdcfcfjnbdojcofhp).

## How It Works

The system has three parts:

1. **Zotero Plugin**: Adds a **Gemini Notebook Connector** submenu to Zotero's Tools menu. Browse your collection tree, search/filter items, and select which sources to stage. The plugin registers endpoints on Zotero's local HTTP server. The Chrome companion connects through `127.0.0.1`, and file requests are rejected unless the attachment was explicitly staged.

2. **Chrome Extension**: Connects to the Zotero plugin's local server, fetches the staged files, and uploads them into Gemini Notebook. Google Chrome is required; Firefox and other browsers are not supported. More information about the Chrome extension is available on its [Chrome Web Store page](https://chrome.google.com/webstore/detail/pcjiogpdekoojnbfdcfcfjnbdojcofhp).

3. **MCP** _(beta)_: An optional interface for your preferred AI client to interact with your Zotero articles and prep them for delivery to Gemini Notebook. This feature is in beta and feedback would be greatly appreciated.

### Optional: Using the MCP

The optional MCP connection lets your AI assistant queue Zotero sources for a notebook and check on the import from your chat. To find and select articles, your assistant needs another Zotero connection[^zotero-mcp] that can search your library, or Zotero item or collection keys you provide.

You could ask:

> Find articles about eusocial insect behavior, queue them for Gemini Notebook using the connector tool, and prepare an Audio Overview prompt focused on the methods they use and where their findings disagree, keyed to my current research.

In the upcoming release, the `suggest-studio-prompt` tool gives your assistant guidance for drafting roughly 100–200 words around your sources and interests. You can ask for another Studio format, or leave out the prompt for an ordinary import.

Once your assistant confirms that the sources are queued:

1. Open Gemini Notebook in Chrome and click the connector's toolbar icon. Start from the home page for a new notebook, or open the notebook you want to add to.
2. If you requested a prompt, click **Copy Studio Prompt** before **Import**. A checkmark confirms that the text is on your clipboard.
3. Click **Import** and follow any upload instructions. After the sources arrive, paste your copied prompt into Studio's instructions and start generation there.

[^zotero-mcp]: We recommend [zotero-mcp](https://github.com/54yyyu/zotero-mcp) as an MCP companion that can search your library and browse collections.

#### Configuring the MCP

MCP is in beta and stays off until you configure it.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/), Python 3.10–3.13, and a supported MCP client. Guided Auto-configure is available for Codex, Claude Code, and Gemini CLI.
2. In Zotero, open **Tools → Gemini Notebook Connector → Configure MCP...**.
3. Select your client, press **Auto-configure**, and confirm. Zotero sets up the connection; the first setup may download Python packages.
4. Restart or reopen your client, then ask it to check the Zotero bridge connection using `get_zotero_bridge_status`.

Auto-configure requires the software in step 1 to be installed already. Claude Desktop automatic setup is not available yet; **Advanced** provides manual connection settings for other clients.

## Detailed Connector Usage

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

## Source Build

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

Install the `.xpi` through Zotero's Plugins window as described above. For Chrome, unzip the extension package, open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.

## Known Issues

- Large batches may take longer to start because Gemini Notebook creates its upload controls asynchronously.
- Gemini Notebook's DOM structure may change without notice, which could break the upload mechanism.

## Privacy

The connector processes staged Zotero metadata and files locally, then sends selected files directly to Gemini Notebook only when you start an import. The developer does not receive them. See the [Privacy Policy](PRIVACY.md) for details.

## License

MIT — see [LICENSE](LICENSE).
