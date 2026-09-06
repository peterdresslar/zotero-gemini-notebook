import {
  classifyChromeCompanionCompatibility,
  COMPANION_COMPATIBILITY,
  getCompatibilityWarningCopy,
} from "./compatibility.js";
import {
  clearStagedJob,
  createStagedFileRequest,
  shouldUseLegacyPopupClear,
} from "./bridge-requests.js";
import "./upload-handoff.js";

const ZOTERO_BASE = "http://127.0.0.1:23119/notebooklm";
const ZOTERO_REQUEST_HEADERS = { "zotero-allowed-request": "1" };
const RELEASES_URL =
  "https://github.com/peterdresslar/zotero-gemini-notebook/releases";
const ZOTERO_JSON_HEADERS = {
  ...ZOTERO_REQUEST_HEADERS,
  "Content-Type": "application/json",
};
const { splitBase64IntoChunks } = globalThis.ZoteroUploadTransfer;
const { readDestination, requestPreparedDestination } =
  globalThis.ZoteroUploadDestination;
const { isCompatiblePingResponse } = globalThis.ZoteroUploadHandoff;

let stagedItems = [];
let selectedIds = new Set();
let companionCompatible = false;
let stagedJobId = null;
let stagedDestination = null;
let studioPrompt = null;
let studioPromptRevision = 0;
let pendingLoadRevision = 0;

document.addEventListener("DOMContentLoaded", () => {
  loadPending();
  document.getElementById("refresh-btn").addEventListener("click", loadPending);
  document.getElementById("import-btn").addEventListener("click", doImport);
  document
    .getElementById("copy-studio-prompt-btn")
    .addEventListener("click", copyStudioPrompt);
});

async function loadPending() {
  const loadRevision = ++pendingLoadRevision;
  const dot = document.getElementById("zotero-dot");
  const statusText = document.getElementById("zotero-status");
  const emptyState = document.getElementById("empty-state");
  const itemList = document.getElementById("item-list");
  const instructions = document.getElementById("instructions");

  companionCompatible = false;
  stagedJobId = null;
  stagedDestination = null;
  setStudioPrompt(null);
  updateImportBtn();

  try {
    const res = await fetch(`${ZOTERO_BASE}/pending`, {
      headers: ZOTERO_REQUEST_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (loadRevision !== pendingLoadRevision) return;
    const installedVersion = chrome.runtime.getManifest().version;

    const compatibility = classifyChromeCompanionCompatibility(
      data.compatibleChromeExtensionVersions,
      installedVersion,
    );
    if (compatibility !== COMPANION_COMPATIBILITY.COMPATIBLE) {
      showIncompatibleCompanionWarning(compatibility, installedVersion);
      return;
    }

    companionCompatible = true;
    dot.className = "status-dot connected";
    statusText.textContent = `Zotero connected — ${data.count} source${data.count !== 1 ? "s" : ""} staged`;

    stagedItems = data.items || [];
    stagedJobId =
      typeof data.jobId === "string" && data.jobId ? data.jobId : null;
    stagedDestination = stagedJobId ? readDestination(data.destination) : null;
    setStudioPrompt(stagedJobId ? readStudioPrompt(data.studioPrompt) : null);
    selectedIds = new Set(stagedItems.map((i) => i.attachmentId));

    if (stagedItems.length === 0) {
      emptyState.innerHTML =
        "<p><b>No sources staged</b></p><p>Use the Zotero plugin to select and export sources first.</p>";
      emptyState.style.display = "";
      itemList.style.display = "none";
      instructions.style.display = "none";
    } else {
      emptyState.style.display = "none";
      itemList.style.display = "";
      instructions.style.display = "";
      renderItems();
    }
    updateImportBtn();
  } catch {
    if (loadRevision !== pendingLoadRevision) return;
    companionCompatible = false;
    stagedItems = [];
    stagedJobId = null;
    stagedDestination = null;
    setStudioPrompt(null);
    selectedIds.clear();
    dot.className = "status-dot error";
    statusText.textContent = "Cannot reach Zotero — is it running?";
    emptyState.innerHTML =
      "<p><b>Zotero not detected</b></p><p>Make sure Zotero is open and the Gemini Notebook plugin is installed.</p>";
    emptyState.style.display = "";
    itemList.style.display = "none";
    instructions.style.display = "none";
    updateImportBtn();
  }
}

function showIncompatibleCompanionWarning(compatibility, installedVersion) {
  const dot = document.getElementById("zotero-dot");
  const statusText = document.getElementById("zotero-status");
  const emptyState = document.getElementById("empty-state");
  const itemList = document.getElementById("item-list");
  const instructions = document.getElementById("instructions");

  const warning = getCompatibilityWarningCopy(compatibility, installedVersion);

  dot.className = "status-dot error";
  statusText.textContent = warning.status;
  emptyState.replaceChildren();

  const heading = document.createElement("p");
  const strong = document.createElement("b");
  strong.textContent = warning.heading;
  heading.appendChild(strong);

  const guidance = document.createElement("p");
  guidance.textContent = warning.guidance;

  const releaseLink = document.createElement("a");
  releaseLink.href = RELEASES_URL;
  releaseLink.target = "_blank";
  releaseLink.rel = "noopener noreferrer";
  releaseLink.textContent = warning.linkText;

  emptyState.append(heading, guidance, releaseLink);
  emptyState.style.display = "";
  itemList.style.display = "none";
  instructions.style.display = "none";
  companionCompatible = false;
  stagedItems = [];
  stagedJobId = null;
  setStudioPrompt(null);
  selectedIds.clear();
  updateImportBtn();
}

function readStudioPrompt(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    // eslint-disable-next-line no-control-regex -- Reject non-text controls and unpaired surrogates.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(
      value,
    ) ||
    new globalThis.TextEncoder().encode(value).byteLength > 4000
  ) {
    return null;
  }
  return value;
}

function setStudioPrompt(value) {
  studioPrompt = value;
  studioPromptRevision += 1;
  document.getElementById("studio-prompt").hidden = !value;
  document.getElementById("copy-studio-prompt-btn").disabled = !value;
  document.getElementById("studio-prompt-copied").hidden = true;
  document.getElementById("studio-prompt-status").textContent = "";
}

async function copyStudioPrompt() {
  if (!studioPrompt) return;
  const prompt = studioPrompt;
  const revision = studioPromptRevision;
  const button = document.getElementById("copy-studio-prompt-btn");
  const copied = document.getElementById("studio-prompt-copied");
  const status = document.getElementById("studio-prompt-status");

  button.disabled = true;
  copied.hidden = true;
  status.textContent = "";
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== "function") {
      throw new Error("Clipboard unavailable");
    }
    await clipboard.writeText(prompt);
    if (revision !== studioPromptRevision) return;
    copied.hidden = false;
    status.textContent = "Copied — ready to paste.";
  } catch {
    if (revision !== studioPromptRevision) return;
    status.textContent =
      "Could not copy. Keep this popup open and click Copy Studio Prompt to try again.";
  } finally {
    if (revision === studioPromptRevision) button.disabled = false;
  }
}

function renderItems() {
  const list = document.getElementById("item-list");
  list.innerHTML = "";

  for (const item of stagedItems) {
    const row = document.createElement("div");
    row.className = "item-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedIds.has(item.attachmentId);
    cb.style.pointerEvents = "none";

    const info = document.createElement("div");
    info.className = "item-info";
    info.innerHTML = `<div class="item-title" title="${esc(item.title)}">${esc(item.title)}</div>
      <div class="item-meta">${esc(item.creators)} · ${esc(item.year)}</div>`;

    const type = document.createElement("span");
    type.className = "item-type";
    type.textContent = getTypeLabel(item.contentType);

    row.appendChild(cb);
    row.appendChild(info);
    row.appendChild(type);

    row.addEventListener("click", () => {
      if (selectedIds.has(item.attachmentId)) {
        selectedIds.delete(item.attachmentId);
        cb.checked = false;
      } else {
        selectedIds.add(item.attachmentId);
        cb.checked = true;
      }
      updateImportBtn();
    });
    row.style.cursor = "pointer";

    list.appendChild(row);
  }
}

function updateImportBtn() {
  const btn = document.getElementById("import-btn");
  const count = selectedIds.size;
  btn.disabled = count === 0 || !companionCompatible;
  btn.textContent =
    count > 0 ? `Import ${count} source${count !== 1 ? "s" : ""}` : "Import";
}

async function doImport() {
  if (!companionCompatible) return;

  const btn = document.getElementById("import-btn");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");

  const toImport = stagedItems.filter((i) => selectedIds.has(i.attachmentId));
  if (toImport.length === 0) return;
  const jobId = stagedJobId;

  btn.disabled = true;
  btn.textContent = "Importing...";
  progress.classList.add("visible");

  // Check we're on NotebookLM. The content script can create a new notebook
  // from the listing page before uploading.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isNotebookLMPage(tab?.url)) {
    progressText.textContent =
      "Please open Gemini Notebook before importing sources.";
    progressFill.style.width = "0%";
    btn.disabled = false;
    btn.textContent = `Import ${toImport.length} sources`;
    return;
  }

  // Verify content script is loaded
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    if (!isCompatiblePingResponse(ping)) {
      progressText.textContent =
        "The Gemini Notebook tab is using an older connector. Refresh the tab and try again.";
      progressFill.style.width = "0%";
      btn.disabled = false;
      btn.textContent = `Import ${toImport.length} sources`;
      return;
    }
  } catch {
    progressText.textContent =
      "Content script not loaded — please refresh the Gemini Notebook tab and try again.";
    progressFill.style.width = "0%";
    btn.disabled = false;
    btn.textContent = `Import ${toImport.length} sources`;
    return;
  }

  let preparedDestination;
  try {
    preparedDestination = await requestPreparedDestination({
      jobId,
      destination: stagedDestination,
      sendMessage: (message) => chrome.tabs.sendMessage(tab.id, message),
    });
  } catch (error) {
    progressText.textContent =
      error instanceof Error
        ? error.message
        : "Gemini Notebook could not prepare the import destination.";
    progressFill.style.width = "0%";
    if (jobId && stagedDestination === "new") {
      btn.disabled = true;
      btn.textContent = "Open Gemini Notebook home first";
    } else {
      btn.disabled = false;
      btn.textContent = `Import ${toImport.length} sources`;
    }
    return;
  }

  const batchId = globalThis.crypto.randomUUID();
  let batchStarted = false;
  let batchCommitted = false;

  try {
    const beginMessage = {
      action: "uploadBatchBegin",
      batchId,
      jobId,
      attachmentIds: toImport.map((item) => item.attachmentId),
      fileCount: toImport.length,
    };
    if (preparedDestination) {
      beginMessage.createdNewNotebook = preparedDestination.createdNewNotebook;
      beginMessage.destination = preparedDestination.destination;
      beginMessage.notebookPathname = preparedDestination.notebookPathname;
    }
    await sendUploadTransferMessage(tab.id, beginMessage);
    batchStarted = true;

    for (let i = 0; i < toImport.length; i++) {
      const item = toImport[i];
      progressText.textContent = `Fetching from Zotero: ${item.fileName} (${i + 1}/${toImport.length})`;
      progressFill.style.width = `${(i / toImport.length) * 50}%`;

      const fileRequest = createStagedFileRequest(item.attachmentId, jobId);
      const fileRes = await fetch(`${ZOTERO_BASE}/file`, {
        method: "POST",
        headers: ZOTERO_JSON_HEADERS,
        body: JSON.stringify(fileRequest),
      });
      if (!fileRes.ok) throw new Error(`Failed to fetch ${item.fileName}`);
      const fileData = await fileRes.json();
      const chunks = splitBase64IntoChunks(fileData.data);

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        progressText.textContent = `Preparing ${fileData.fileName}: part ${chunkIndex + 1}/${chunks.length}`;
        progressFill.style.width = `${((i + (chunkIndex + 1) / chunks.length) / toImport.length) * 50}%`;
        await sendUploadTransferMessage(tab.id, {
          action: "uploadBatchChunk",
          batchId,
          fileIndex: i,
          chunkIndex,
          chunkCount: chunks.length,
          fileName: fileData.fileName,
          contentType: fileData.contentType,
          data: chunks[chunkIndex],
        });
      }
    }

    progressText.textContent = `Uploading ${toImport.length} files to Gemini Notebook...`;
    progressFill.style.width = "60%";

    await sendUploadTransferMessage(tab.id, {
      action: "uploadBatchCommit",
      batchId,
    });
    batchStarted = false;
    batchCommitted = true;

    // Job-bound batches are claimed by the content script through the
    // extension worker before upload starts. Older Zotero releases have no job
    // ID and retain the legacy popup clear behavior.
    if (shouldUseLegacyPopupClear(jobId)) {
      await clearStagedJob({
        fetchImpl: fetch,
        url: `${ZOTERO_BASE}/clear`,
        headers: ZOTERO_REQUEST_HEADERS,
        jobId,
        attachmentIds: toImport.map((item) => item.attachmentId),
      });
    }

    // Close the popup so NotebookLM regains focus and Angular can run.
    // A small delay lets the sendMessage dispatch first.
    setTimeout(() => window.close(), 200);
  } catch (e) {
    if (batchStarted) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: "uploadBatchAbort",
          batchId,
        });
      } catch {
        // The tab may have navigated or reloaded. Zotero staging stays intact.
      }
    }
    if (batchCommitted) {
      progressText.textContent =
        "Files were handed to Gemini Notebook's uploader, but Zotero could not clear the staged job. Close this popup and check Gemini Notebook before staging or retrying.";
      btn.disabled = true;
      btn.textContent = "Check Gemini Notebook";
    } else if (jobId && preparedDestination?.createdNewNotebook === true) {
      progressText.textContent =
        "The new notebook was created, but Zotero could not confirm whether the one-time staged import started. Check this notebook's Sources panel before restaging. If the files are missing, start the next import from this notebook or Gemini Notebook home.";
      btn.disabled = true;
      btn.textContent = "Check this notebook first";
    } else {
      progressText.textContent = `Error uploading to Gemini Notebook: ${e.message}`;
      btn.disabled = false;
      btn.textContent = `Retry Import`;
    }
  }
}

async function sendUploadTransferMessage(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.success) {
    throw new Error(response?.error || "Chrome could not transfer the upload");
  }
  return response;
}

function getTypeLabel(contentType) {
  if (!contentType) return "?";
  if (contentType.includes("pdf")) return "PDF";
  if (contentType.includes("word")) return "DOCX";
  if (contentType.includes("html")) return "HTML";
  if (contentType.includes("text")) return "TXT";
  return "FILE";
}

function isNotebookLMPage(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ["notebook.google.com", "notebooklm.google.com"].includes(
      parsed.hostname,
    );
  } catch {
    return false;
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
