import {
  classifyChromeCompanionCompatibility,
  COMPANION_COMPATIBILITY,
  getCompatibilityWarningCopy,
} from "./compatibility.js";
import {
  createStagedClearRequest,
  createStagedFileRequest,
  STAGED_CLEAR_METHOD,
} from "./bridge-requests.js";

const ZOTERO_BASE = "http://127.0.0.1:23119/notebooklm";
const ZOTERO_REQUEST_HEADERS = { "zotero-allowed-request": "1" };
const RELEASES_URL =
  "https://github.com/peterdresslar/zotero-gemini-notebook/releases";
const ZOTERO_JSON_HEADERS = {
  ...ZOTERO_REQUEST_HEADERS,
  "Content-Type": "application/json",
};
const { splitBase64IntoChunks } = globalThis.ZoteroUploadTransfer;

let stagedItems = [];
let selectedIds = new Set();
let companionCompatible = false;
let stagedJobId = null;

document.addEventListener("DOMContentLoaded", () => {
  loadPending();
  document.getElementById("refresh-btn").addEventListener("click", loadPending);
  document.getElementById("import-btn").addEventListener("click", doImport);
});

async function loadPending() {
  const dot = document.getElementById("zotero-dot");
  const statusText = document.getElementById("zotero-status");
  const emptyState = document.getElementById("empty-state");
  const itemList = document.getElementById("item-list");
  const instructions = document.getElementById("instructions");

  companionCompatible = false;
  stagedJobId = null;
  updateImportBtn();

  try {
    const res = await fetch(`${ZOTERO_BASE}/pending`, {
      headers: ZOTERO_REQUEST_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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
    companionCompatible = false;
    stagedItems = [];
    stagedJobId = null;
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
  selectedIds.clear();
  updateImportBtn();
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
    count > 0
      ? `Import ${count} source${count !== 1 ? "s" : ""} to Gemini Notebook`
      : "Import to Gemini Notebook";
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
    btn.textContent = `Import ${toImport.length} sources to Gemini Notebook`;
    return;
  }

  // Verify content script is loaded
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch {
    progressText.textContent =
      "Content script not loaded — please refresh the Gemini Notebook tab and try again.";
    progressFill.style.width = "0%";
    btn.disabled = false;
    btn.textContent = `Import ${toImport.length} sources to Gemini Notebook`;
    return;
  }

  const batchId = globalThis.crypto.randomUUID();
  let batchStarted = false;
  let batchCommitted = false;

  try {
    await sendUploadTransferMessage(tab.id, {
      action: "uploadBatchBegin",
      batchId,
      fileCount: toImport.length,
    });
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

    // The content script now holds the complete batch. Clear staging only
    // after commit succeeds, then close the popup so Gemini Notebook can run.
    try {
      const clearRequest = createStagedClearRequest(
        jobId,
        toImport.map((item) => item.attachmentId),
      );
      const clearResponse = await fetch(`${ZOTERO_BASE}/clear`, {
        method: STAGED_CLEAR_METHOD,
        headers: ZOTERO_JSON_HEADERS,
        body: JSON.stringify(clearRequest ?? {}),
      });
      if (!clearResponse.ok) {
        throw new Error("Zotero could not finalize the staged job");
      }
    } catch {
      // Non-critical
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
        "Files were handed to Gemini Notebook, but Zotero could not clear the staged job. Close this popup and check Gemini Notebook before staging or retrying.";
      btn.disabled = true;
      btn.textContent = "Check Gemini Notebook";
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
