# Privacy Policy

Effective August 27, 2026.

Zotero Gemini Notebook, including its Chrome extension **Zotero-Gemini Notebook Connector**, has one purpose: moving sources that a user stages in Zotero into a Gemini Notebook chosen by that user. The Zotero plugin and Chrome extension run on the user's computer. The project has no developer-operated server, analytics, advertising, or telemetry.

## Data the connector handles

To show and complete an import, the connector handles staged Zotero source information such as titles, creators, years, filenames, file types, local attachment identifiers, counts, and temporary job identifiers. When the user starts an import, it reads the selected local attachment files. On `notebook.google.com` and `notebooklm.google.com`, it also inspects the current page structure, notebook location, and upload state needed to complete and report the handoff.

The connector does not browse arbitrary files, read unstaged Zotero attachments, read browser cookies, or inspect pages outside those two Gemini Notebook hosts.

## How data is used and shared

Staged information and files travel from the Zotero plugin to the Chrome extension through a fixed local connection on `127.0.0.1`. When the user clicks **Import to Gemini Notebook**, the extension sends the selected files directly to the open Gemini Notebook page so Google can process them as sources. Files may contain personal or sensitive information. Google is the only third party that receives the selected filenames and contents, and that transfer occurs only as part of the user's requested import. Google's handling of the imported sources is governed by the user's agreement with Google and the [Google Privacy Policy](https://policies.google.com/privacy).

The developer does not receive, collect, sell, rent, analyze, or use Zotero metadata, file contents, Gemini Notebook page content, or browsing activity. The connector does not use this data for advertising, profiling, creditworthiness, or lending, and does not transfer it for any purpose unrelated to the import requested by the user.

## Storage and retention

The Chrome extension does not use persistent browser storage for source metadata or file contents. It holds staged metadata only while the popup is open and holds file data only while an import is being prepared or attempted. Popup metadata is released when the popup closes; file data is released when the attempt completes, fails, times out, is disarmed, or the extension context ends. Zotero keeps staged information in its process memory until the batch is claimed, replaced, cleared, expires under a job-specific limit, or Zotero closes.

## User control

Users choose what to stage in Zotero, may deselect sources in the Chrome popup, and must explicitly start the browser import. Removing the extension stops Chrome-side processing. Removing or disabling the Zotero plugin stops local staging and file service.

## Limited Use

The connector's use and transfer of information is limited to providing the single user-facing import function described here. Its handling of user data follows the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Contact and changes

Questions or privacy concerns may be filed through the project's [GitHub issue tracker](https://github.com/peterdresslar/zotero-gemini-notebook/issues). GitHub issues are public, so do not include source contents, credentials, or other personal information. Material changes to this policy will be published in this repository with a revised effective date.
