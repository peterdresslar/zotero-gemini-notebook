// Content script (isolated world) for Gemini Notebook's current and legacy hosts.
// Communicates with injector.js (main world) via window.postMessage

const { createBatch } = globalThis.ZoteroUploadTransfer;
const geminiControls = globalThis.ZoteroGeminiControls.createLocator({
  queryAll: querySelectorAllDeep,
  isVisible,
  isDisabled,
});
const dialogUploadStatus = globalThis.ZoteroDialogUploadStatus.createController(
  {
    document,
    MutationObserver,
    showFallback: (message, kind = "info") => showPageNotice(message, kind),
    hideFallback: hidePageNotice,
  },
);
const UPLOAD_BATCH_EXPIRY_MS = 5 * 60 * 1000;
const JOB_CLAIM_ACTION = "claimZoteroJob";
const JOB_LIFECYCLE_ACTION = "reportJobLifecycle";
const JOB_LIFECYCLE_REPORT_WARNING =
  "Gemini Notebook received the files, but Zotero could not update the import status.";
const POPUP_URL = chrome.runtime.getURL("popup.html");
const uploadHandoff = globalThis.ZoteroUploadHandoff.createController({
  createBatch,
  claimJob: claimUploadJob,
  startUpload: startClaimedUpload,
  isAuthorizedSender: isAllowedPopupSender,
  expiryMs: UPLOAD_BATCH_EXPIRY_MS,
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "uploadBatchBegin") {
    try {
      uploadHandoff.begin(msg, sender);
      dialogUploadStatus.hide();
      hideAssistedUploadPrompt();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return;
  }

  if (msg?.action === "uploadBatchChunk") {
    try {
      uploadHandoff.addChunk(msg, sender);
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return;
  }

  if (msg?.action === "uploadBatchAbort") {
    try {
      uploadHandoff.abort(msg.batchId, sender);
      dialogUploadStatus.hide();
      hideAssistedUploadPrompt();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return;
  }

  if (msg?.action === "uploadBatchCommit") {
    void uploadHandoff.commit(msg.batchId, sender).then(
      () => sendResponse({ success: true }),
      (error) => sendResponse({ success: false, error: error.message }),
    );
    return true;
  }

  if (msg?.action === "ping") {
    if (!isAllowedPopupSender(sender)) return;
    sendResponse(globalThis.ZoteroUploadHandoff.createPingResponse());
    return;
  }
});

function isAllowedPopupSender(sender) {
  return globalThis.ZoteroUploadHandoff.isAllowedPopupSender({
    sender,
    extensionId: chrome.runtime.id,
    popupUrl: POPUP_URL,
  });
}

async function claimUploadJob(job) {
  const response = await chrome.runtime.sendMessage({
    action: JOB_CLAIM_ACTION,
    attachmentIds: job.attachmentIds,
    claimId: job.claimId,
    jobId: job.jobId,
  });
  if (!response?.success) {
    throw new Error("Zotero did not accept the upload job");
  }
}

function startClaimedUpload({ files, job, complete }) {
  setTimeout(() => {
    void uploadBatch(files, job)
      .catch(() => {
        console.error("[Zotero content] Upload failed");
      })
      .finally(complete);
  }, 0);
}

const UPLOAD_CONTROL_LABELS = [
  "upload files",
  "upload file",
  "upload sources",
  "choose files",
  "choose file",
  "browse files",
  "browse",
];
const UPLOAD_TRIGGER_MARKER = "data-zotero-upload-trigger";
const PAGE_NOTICE_ID = "zotero-notebooklm-page-notice";
const UPLOAD_TIMEOUT_MS = 120000;
const DELAYED_UPLOAD_TRIGGER_DELAYS_MS = [
  2500, 10000, 30000, 45000, 60000, 90000,
];
const UPLOAD_TIMEOUT_ERROR_CODE = "zotero-upload-timeout";
let assistedClickCleanup = null;

window.addEventListener("pagehide", () => {
  uploadHandoff.dispose();
  hideAssistedUploadPrompt();
  dialogUploadStatus.hide();
});

async function uploadBatch(files, job) {
  if (!files || files.length === 0) {
    throw new Error("No files to upload");
  }

  const startedFromNotebookDetail = isNotebookDetailPage();
  try {
    const createdNotebook = await ensureNotebookDetailPage();
    if (!createdNotebook) {
      dialogUploadStatus.setAdding({ createdNotebook: false });
    }
    await uploadFilesIntoCurrentNotebook(files);
    const reported = await reportJobLifecycle(job, "submitted");
    if (reported) {
      dialogUploadStatus.hide();
    } else {
      dialogUploadStatus.showError(JOB_LIFECYCLE_REPORT_WARNING);
    }
  } catch (error) {
    hideAssistedUploadPrompt();
    let message;
    if (error.code === UPLOAD_TIMEOUT_ERROR_CODE) {
      await reportJobLifecycle(job, "unverified");
      console.warn(
        "[Zotero content] Upload timed out before NotebookLM confirmed file injection",
      );
      message =
        "Zotero did not get a successful response from Gemini Notebook. If the files are still missing, open Add sources and try the import again.";
    } else if (!startedFromNotebookDetail && isNotebookDetailPage()) {
      await reportJobLifecycle(job, "failed");
      message =
        "Created a new notebook in Gemini Notebook, but Zotero had trouble adding files. Try importing again from this notebook page.";
    } else if (!startedFromNotebookDetail) {
      await reportJobLifecycle(job, "failed");
      message =
        "Zotero had trouble creating a new notebook in Gemini Notebook. Open or create a notebook and try importing again.";
    } else {
      await reportJobLifecycle(job, "failed");
      message =
        "Zotero had trouble adding files to Gemini Notebook. Try importing again from this notebook page.";
    }
    dialogUploadStatus.showError(message);
    throw error;
  }
}

async function reportJobLifecycle(job, event) {
  if (!job) return true;
  try {
    const response = await chrome.runtime.sendMessage({
      action: JOB_LIFECYCLE_ACTION,
      claimId: job.claimId,
      event,
      jobId: job.jobId,
    });
    return response?.success === true;
  } catch {
    return false;
  }
}

async function uploadFilesIntoCurrentNotebook(files) {
  // Step 1: Arm the injector with file data before clicking any NotebookLM
  // controls. Current NotebookLM builds may attach upload behavior directly to
  // the Add sources button or to the persistent source-panel dropzone.
  await armInjector(files);

  // Step 2: Set up result listener BEFORE any injection attempt.
  const resultPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      hideAssistedUploadPrompt();
      reject(createUploadTimeoutError());
    }, UPLOAD_TIMEOUT_MS);

    function handler(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== "__zotero_from_injector") return;
      if (e.data.status) return; // ignore non-terminal status messages here
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      if (e.data.success) {
        resolve();
      } else {
        reject(new Error(e.data.error || "Upload failed"));
      }
    }

    window.addEventListener("message", handler);
  });

  let uploadFinished = false;
  resultPromise.then(
    () => {
      uploadFinished = true;
      hideAssistedUploadPrompt();
      dialogUploadStatus.hide();
    },
    () => {
      uploadFinished = true;
      hideAssistedUploadPrompt();
    },
  );

  // Step 4: If NotebookLM already has a hidden file input in the DOM, inject
  // directly and skip the fragile button path entirely.
  const injectedWithoutClick = await requestExistingInjection("before-click");
  if (injectedWithoutClick) {
    console.log(
      "[Zotero content] Injector found an existing file input before click",
    );
    await resultPromise;
    await sleep(3000);
    return;
  }

  // Current NotebookLM pages expose a persistent xapscotty uploader dropzone in
  // the source panel. Prefer that before opening secondary upload UI.
  await requestDropInjection("source-panel-before-dialog");
  await sleep(350);
  if (uploadFinished) {
    await resultPromise;
    await sleep(3000);
    return;
  }

  // Step 5: Open the add-sources UI if the persistent upload paths did not work.
  const dialog = await ensureAddSourcesDialog(() => uploadFinished);
  if (uploadFinished || !dialog) {
    await resultPromise;
    await sleep(3000);
    return;
  }

  // Step 6: Find visible upload controls in the dialog.
  const uploadControls = findUploadFileControls(dialog);
  if (uploadControls.length === 0) {
    throw new Error("Could not find an upload-files control");
  }

  console.log(
    "[Zotero content] Found " +
      uploadControls.length +
      " upload control candidate(s)",
  );

  if (
    await requestTriggerActivation("dialog-upload-trigger", uploadControls[0])
  ) {
    await sleep(350);
    if (uploadFinished) {
      await resultPromise;
      await sleep(3000);
      return;
    }

    if (await requestExistingInjection("after-trigger-activation")) {
      await resultPromise;
      await sleep(3000);
      return;
    }
  }

  // Step 7: Fall back to content-script click events.
  for (let i = 0; i < uploadControls.length; i++) {
    if (uploadFinished) break;
    const control = uploadControls[i];
    const reason = "after-click-" + (i + 1);
    console.log(
      "[Zotero content] Clicking upload control " +
        (i + 1) +
        "/" +
        uploadControls.length +
        ": " +
        describeElement(control),
    );
    clickElement(control);
    await sleep(350);

    if (await requestExistingInjection(reason)) {
      await resultPromise;
      await sleep(3000);
      return;
    }
  }

  await requestDropInjection("after-clicks");
  await sleep(350);
  if (uploadFinished) {
    await resultPromise;
    await sleep(3000);
    return;
  }

  showAssistedUploadPrompt(uploadControls[0], files.length);
  const getAssistedUploadControl = () =>
    uploadControls[0]?.isConnected
      ? uploadControls[0]
      : findUploadFileControls(document)[0] || null;

  // Keep the NotebookLM dialog open. Closing it too early can tear down the
  // Angular uploader before it materializes the real file input.
  console.log(
    "[Zotero content] Waiting for NotebookLM to expose an upload path; if prompted, click the highlighted Upload files button",
  );
  void delayedExistingInjection(
    1000,
    "after-assisted-1s",
    () => uploadFinished,
  );
  void delayedExistingInjection(
    5000,
    "after-assisted-5s",
    () => uploadFinished,
  );
  void delayedExistingInjection(
    15000,
    "after-assisted-15s",
    () => uploadFinished,
  );
  for (const delayMs of DELAYED_UPLOAD_TRIGGER_DELAYS_MS) {
    const seconds = Math.round(delayMs / 1000);
    void delayedUploadTrigger(
      delayMs,
      "delayed-trigger-" + seconds + "s",
      getAssistedUploadControl,
      () => uploadFinished,
    );
  }

  // Step 6: Wait for injector to confirm success.
  await resultPromise;

  // Give NotebookLM time to process
  await sleep(3000);
}

async function ensureNotebookDetailPage() {
  if (isNotebookDetailPage()) return false;

  showPageNotice(
    "Creating a new notebook in Gemini Notebook for Zotero sources...",
  );
  const createControl = findCreateNotebookControl();
  if (!createControl) {
    throw new Error(
      "Could not find Gemini Notebook's create-new-notebook control",
    );
  }

  console.log(
    "[Zotero content] Creating a new notebook: " +
      describeElement(createControl),
  );
  clickElement(createControl);

  if (!(await waitForNotebookDetailPage(20000))) {
    throw new Error("Gemini Notebook did not navigate to a new notebook");
  }

  dialogUploadStatus.setAdding({ createdNotebook: true });
  if (!(await waitForNotebookWorkspace(15000))) {
    throw new Error("New notebook in Gemini Notebook did not finish loading");
  }

  await sleep(750);
  return true;
}

function findCreateNotebookControl() {
  const structuralControl = geminiControls.findCreateNotebookControl(document);
  if (structuralControl) return structuralControl;

  const candidates = [
    ...findClickableByTextAll("create new notebook"),
    ...findClickableByTextAll("create new"),
  ];
  const seen = new Set();
  return candidates
    .filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return true;
    })
    .sort(
      (a, b) => scoreCreateNotebookControl(b) - scoreCreateNotebookControl(a),
    )[0];
}

function scoreCreateNotebookControl(el) {
  const tag = el.tagName.toLowerCase();
  const role = normalizeText(el.getAttribute("role") || "");
  const text = normalizeText(
    (el.getAttribute("aria-label") || "") + " " + (el.textContent || ""),
  );
  let score = 0;

  if (text.includes("create new notebook")) score += 60;
  if (text.includes("create new")) score += 40;
  if (tag === "button") score += 30;
  if (role === "button") score += 20;
  if (text.includes("notebook")) score += 10;

  return score;
}

async function waitForNotebookDetailPage(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isNotebookDetailPage()) {
      console.log("[Zotero content] Notebook detail page is active");
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForNotebookWorkspace(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      document.querySelector("add-sources-dialog") ||
      document.querySelector(".sources-list-dropzone") ||
      geminiControls.findAddSourcesControl(document) ||
      findClickableByText("add sources")
    ) {
      console.log("[Zotero content] Notebook workspace is ready");
      return true;
    }
    await sleep(250);
  }
  return false;
}

function isNotebookDetailPage(url = window.location.href) {
  try {
    const parsed = new URL(url);
    return (
      ["notebook.google.com", "notebooklm.google.com"].includes(
        parsed.hostname,
      ) && parsed.pathname.startsWith("/notebook/")
    );
  } catch {
    return false;
  }
}

function getUploadTimeoutMessage() {
  const dialog = document.querySelector("add-sources-dialog") || document;
  const controls = findUploadFileControls(dialog);
  const controlSummary = controls.length
    ? controls.map(describeElement).join("; ")
    : "none";
  return (
    "Upload timed out — Gemini Notebook never exposed a file input or accepted a " +
    "synthetic drop. Upload controls seen: " +
    controlSummary
  );
}

function createUploadTimeoutError() {
  const error = new Error(getUploadTimeoutMessage());
  error.code = UPLOAD_TIMEOUT_ERROR_CODE;
  return error;
}

async function delayedExistingInjection(delayMs, reason, isFinished) {
  await sleep(delayMs);
  if (isFinished()) return;
  await requestExistingInjection(reason);
}

async function delayedUploadTrigger(delayMs, reason, getControl, isFinished) {
  await sleep(delayMs);
  if (isFinished()) return;

  const control = getControl();
  if (!control) {
    console.log(
      "[Zotero content] Delayed upload trigger found no control (" +
        reason +
        ")",
    );
    return;
  }
  highlightAssistedUploadControl(control);

  console.log(
    "[Zotero content] Delayed upload trigger attempt (" +
      reason +
      "): " +
      describeElement(control),
  );
  if (await requestTriggerActivation(reason, control)) {
    await sleep(350);
    if (isFinished()) return;
    if (await requestExistingInjection(reason + "-after-trigger")) return;
  }

  if (isFinished()) return;
  clickElement(control);
  await sleep(350);
  if (isFinished()) return;
  await requestExistingInjection(reason + "-after-click");
}

async function armInjector(files) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(
        new Error(
          "Injector did not confirm armed state — is injector.js loaded?",
        ),
      );
    }, 5000);

    function handler(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== "__zotero_from_injector") return;
      if (e.data.status !== "armed") return;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      console.log("[Zotero content] Injector confirmed armed");
      resolve();
    }

    window.addEventListener("message", handler);

    console.log(
      "[Zotero content] Arming injector with " + files.length + " files",
    );
    window.postMessage(
      { type: "__zotero_to_injector", command: "arm", files: files },
      "*",
    );
  });
}

async function requestExistingInjection(reason) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      console.log(
        "[Zotero content] Existing-input probe timed out (" + reason + ")",
      );
      resolve(false);
    }, 1000);

    function handler(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== "__zotero_from_injector") return;
      if (e.data.status !== "inject-existing") return;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      if (e.data.found) {
        console.log(
          "[Zotero content] Existing-input probe found a file input (" +
            reason +
            ")",
        );
      } else {
        console.log(
          "[Zotero content] Existing-input probe found no file input (" +
            reason +
            ")",
        );
      }
      resolve(Boolean(e.data.found));
    }

    window.addEventListener("message", handler);
    window.postMessage(
      { type: "__zotero_to_injector", command: "inject-existing", reason },
      "*",
    );
  });
}

async function requestDropInjection(reason) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      console.log("[Zotero content] Drop probe timed out (" + reason + ")");
      resolve(false);
    }, 1000);

    function handler(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== "__zotero_from_injector") return;
      if (e.data.status !== "drop-files") return;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      if (e.data.found) {
        console.log(
          "[Zotero content] Drop probe dispatched files (" +
            reason +
            "): " +
            (e.data.target || "unknown target"),
        );
      } else {
        console.log(
          "[Zotero content] Drop probe found no target (" + reason + ")",
        );
      }
      resolve(Boolean(e.data.found));
    }

    window.addEventListener("message", handler);
    window.postMessage(
      { type: "__zotero_to_injector", command: "drop-files", reason },
      "*",
    );
  });
}

async function requestTriggerActivation(reason, target = null) {
  const marker = target
    ? "zotero-" + Date.now() + "-" + Math.random().toString(36).slice(2)
    : null;
  const selector = marker
    ? "[" + UPLOAD_TRIGGER_MARKER + '="' + marker + '"]'
    : null;
  if (target && marker) {
    target.setAttribute(UPLOAD_TRIGGER_MARKER, marker);
  }

  return new Promise((resolve) => {
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      if (target && marker) {
        target.removeAttribute(UPLOAD_TRIGGER_MARKER);
      }
      resolve(value);
    }

    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      console.log(
        "[Zotero content] Upload-trigger activation timed out (" + reason + ")",
      );
      finish(false);
    }, 1000);

    function handler(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== "__zotero_from_injector") return;
      if (e.data.status !== "activate-trigger") return;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      if (e.data.found) {
        console.log(
          "[Zotero content] Activated upload trigger (" +
            reason +
            "): " +
            (e.data.target || "unknown target") +
            ", listeners=" +
            e.data.listeners,
        );
      } else {
        console.log(
          "[Zotero content] Upload-trigger activation found no target (" +
            reason +
            ")",
        );
      }
      finish(Boolean(e.data.found));
    }

    window.addEventListener("message", handler);
    window.postMessage(
      {
        type: "__zotero_to_injector",
        command: "activate-trigger",
        reason,
        selector,
      },
      "*",
    );
  });
}

async function ensureAddSourcesDialog(isFinished) {
  const existing = document.querySelector("add-sources-dialog");
  if (existing) return existing;

  const addBtn =
    geminiControls.findAddSourcesControl(document) ||
    document.querySelector('[aria-label*="Add source" i]') ||
    findClickableByText("add sources");

  if (addBtn) {
    clickElement(addBtn);
    if (isFinished()) return null;
    const dialog = await waitForElement("add-sources-dialog", 3000);
    if (isFinished()) return null;
    if (!dialog) {
      throw new Error("Could not open the add sources dialog");
    }
    await sleep(500);
    return dialog;
  }

  throw new Error("Could not find the add sources button");
}

function findUploadFileControls(root = document) {
  const structuralControls = geminiControls.findUploadFileControls(root);
  const fallbackControls = [];
  const seen = new Set(structuralControls);

  for (const label of UPLOAD_CONTROL_LABELS) {
    for (const el of findClickableByTextAll(label, root)) {
      if (seen.has(el)) continue;
      seen.add(el);
      fallbackControls.push(el);
    }
  }

  fallbackControls.sort(
    (a, b) => scoreUploadControl(b) - scoreUploadControl(a),
  );
  return [...structuralControls, ...fallbackControls];
}

function findClickableByText(text, root = document) {
  return findClickableByTextAll(text, root)[0] || null;
}

function findClickableByTextAll(text, root = document) {
  const target = normalizeText(text);
  const clickables = querySelectorAllDeep(
    root,
    'button, [role="button"], [aria-label], [tabindex]:not([tabindex="-1"])',
  );
  const matches = [];

  for (const el of clickables) {
    if (!isVisible(el) || isDisabled(el)) continue;
    const label = normalizeText(el.getAttribute("aria-label") || "");
    const content = normalizeText(el.textContent || "");
    if (label.includes(target) || content.includes(target)) {
      matches.push(el);
    }
  }

  return matches;
}

function querySelectorAllDeep(root, selector) {
  const results = [];
  const visitedShadowRoots = new Set();
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current.querySelectorAll !== "function") continue;

    results.push(...current.querySelectorAll(selector));

    for (const el of current.querySelectorAll("*")) {
      if (el.shadowRoot && !visitedShadowRoots.has(el.shadowRoot)) {
        visitedShadowRoots.add(el.shadowRoot);
        stack.push(el.shadowRoot);
      }
    }
  }

  return results;
}

function scoreUploadControl(el) {
  const tag = el.tagName.toLowerCase();
  const role = normalizeText(el.getAttribute("role") || "");
  const label = normalizeText(el.getAttribute("aria-label") || "");
  const content = normalizeText(el.textContent || "");
  let score = 0;

  if (tag === "button") score += 30;
  if (role === "button") score += 20;
  if (label.includes("upload files")) score += 25;
  if (content.includes("upload files")) score += 20;
  if (label.includes("browse") || content.includes("browse")) score += 10;
  if (el.closest("add-sources-dialog")) score += 10;

  return score;
}

function clickElement(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  };
  if (typeof PointerEvent === "function") {
    el.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  }
  el.dispatchEvent(
    new MouseEvent("mousedown", {
      ...eventInit,
    }),
  );
  if (typeof PointerEvent === "function") {
    el.dispatchEvent(new PointerEvent("pointerup", eventInit));
  }
  el.dispatchEvent(
    new MouseEvent("mouseup", {
      ...eventInit,
    }),
  );
  el.click();
}

function showAssistedUploadPrompt(uploadControl, fileCount) {
  hideAssistedUploadPrompt();
  if (!uploadControl || !document.body) return;

  highlightAssistedUploadControl(uploadControl);
  dialogUploadStatus.setAssisted({ fileCount });
}

function highlightAssistedUploadControl(uploadControl) {
  if (!uploadControl || !document.body) return;
  if (
    assistedClickCleanup &&
    uploadControl.hasAttribute("data-zotero-assisted-upload")
  ) {
    return;
  }
  if (assistedClickCleanup) assistedClickCleanup();

  console.log(
    "[Zotero content] Highlighting the upload control for a trusted NotebookLM click",
  );
  const previousOutline = uploadControl.style.outline;
  const previousOutlineOffset = uploadControl.style.outlineOffset;
  uploadControl.setAttribute("data-zotero-assisted-upload", "true");
  uploadControl.style.outline = "3px solid #1a73e8";
  uploadControl.style.outlineOffset = "3px";
  uploadControl.scrollIntoView({ block: "center", inline: "center" });

  const clickLogger = (event) => {
    console.log(
      "[Zotero content] Highlighted upload control clicked; trusted=" +
        event.isTrusted,
    );
  };
  uploadControl.addEventListener("click", clickLogger, {
    capture: true,
  });
  assistedClickCleanup = () => {
    uploadControl.removeEventListener("click", clickLogger, {
      capture: true,
    });
    uploadControl.style.outline = previousOutline;
    uploadControl.style.outlineOffset = previousOutlineOffset;
    uploadControl.removeAttribute("data-zotero-assisted-upload");
    assistedClickCleanup = null;
  };
}

function hideAssistedUploadPrompt() {
  if (assistedClickCleanup) assistedClickCleanup();
  for (const el of document.querySelectorAll("[data-zotero-assisted-upload]")) {
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.removeAttribute("data-zotero-assisted-upload");
  }
}

function showPageNotice(message, kind = "info") {
  hidePageNotice();
  if (!document.body) return;

  const notice = document.createElement("div");
  notice.id = PAGE_NOTICE_ID;
  notice.setAttribute("role", kind === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  notice.setAttribute("aria-atomic", "true");
  Object.assign(notice.style, {
    position: "fixed",
    top: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    maxWidth: "460px",
    padding: "12px 16px",
    borderRadius: "8px",
    background: kind === "error" ? "#b3261e" : "#202124",
    color: "#fff",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)",
    font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textAlign: "center",
  });
  notice.textContent = message;
  document.body.appendChild(notice);
}

function hidePageNotice() {
  document.getElementById(PAGE_NOTICE_ID)?.remove();
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  return el.getClientRects().length > 0;
}

function isDisabled(el) {
  return (
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    el.closest("[aria-hidden='true']")
  );
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const classes =
    typeof el.className === "string" && el.className
      ? "." + el.className.trim().replace(/\s+/g, ".")
      : "";
  const role = el.getAttribute("role")
    ? '[role="' + el.getAttribute("role") + '"]'
    : "";
  const label = el.getAttribute("aria-label")
    ? '[aria-label="' + el.getAttribute("aria-label") + '"]'
    : "";
  const text = normalizeText(el.textContent || "").slice(0, 80);
  return (
    tag + id + classes + role + label + (text ? ' text="' + text + '"' : "")
  );
}

function waitForElement(selector, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
