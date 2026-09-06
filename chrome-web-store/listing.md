# Chrome Web Store Listing

## Listing

**Name:** Zotero-Gemini Notebook Connector

**Summary:** Send selected Zotero PDFs and other supported files to Gemini Notebook through the Zotero plugin and Chrome extension

**Category:** Education

Zotero-Gemini Notebook Connector connects Zotero on your computer to Gemini Notebook in Chrome. Stage supported sources in Zotero, review the queue in the extension, and import them into the notebook you already have open or start from Gemini Notebook home to create a new notebook.

The extension requires the matching Zotero Gemini Notebook plugin, Zotero desktop, Google Chrome, and a signed-in Gemini Notebook account. It supports local PDF, DOCX, Markdown, and text attachments staged by the user. The optional MCP beta is configured in Zotero and is not required for ordinary imports.

Selected files move directly from Zotero on the user's computer to Gemini Notebook after the user clicks Import. The developer does not receive file contents, library metadata, browsing activity, or Gemini Notebook page content, and the extension includes no analytics, advertising, or remote code. See the public privacy policy for the complete data-handling description.

This is an independent open-source project and is not affiliated with or endorsed by Google or the Zotero project. Zotero is a registered trademark of the Corporation for Digital Scholarship. Gemini Notebook is a trademark of Google LLC, used here only to describe compatibility and subject to Google Permissions.

**Homepage:** https://github.com/peterdresslar/zotero-gemini-notebook

**Support:** https://github.com/peterdresslar/zotero-gemini-notebook/issues

**Privacy policy:** https://github.com/peterdresslar/zotero-gemini-notebook/blob/main/PRIVACY.md

## Single purpose

Transfer sources explicitly staged by the user in Zotero into the user's chosen Gemini Notebook.

## Permission and host justifications

`http://127.0.0.1:23119/*` connects only to the Zotero plugin on the same computer to read the staged source list and the selected staged files and to report the bounded handoff lifecycle.

`https://notebook.google.com/*` and `https://notebooklm.google.com/*` identify the current or newly created notebook and hand the user-selected files to Gemini Notebook's upload interface. The second host preserves compatibility with Google's legacy Gemini Notebook hostname.

The extension requests no general Chrome API permissions, does not expose external messaging, and does not load or execute remote code.

## Privacy Practices notes

We certify that the data handled by the extension is necessary for the stated single purpose and that it is not sold, used for advertising or profiling, or transferred except to Google for the user-requested import. No user data is persisted beyond use by the Chrome extension.

## Reviewer instructions

1. Download the matching Zotero plugin from https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/v0.5.0/zotero-gemini-notebook.xpi. In Zotero, open **Tools → Plugins**, choose the gear menu, select **Install Add-on From File…**, open the downloaded XPI, and restart Zotero if prompted.
2. In Zotero, select a regular library item with a local PDF, right-click, and choose **Export Selected to Gemini Notebook**.
3. Sign in to https://notebook.google.com with the reviewer's own Google account and open a disposable notebook, or remain on the home page to create one.
4. Open the Chrome extension. Confirm that the staged source appears, then click **Import to Gemini Notebook**.
5. If Gemini Notebook highlights **Add sources** or **Upload files**, click that highlighted page control once. Do not choose a file manually; the extension supplies the staged file.
6. Confirm that the file appears in the notebook's Sources panel. A `submitted` job state means the file was handed to Google's uploader, so the visible Sources panel is the final manual check.

The optional MCP setup is outside the core Chrome extension review path. Please see the repository for more information, if needed.
