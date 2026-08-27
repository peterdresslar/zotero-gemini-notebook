// Main-world script injected into Gemini Notebook's current and legacy hosts.
// Intercepts file-input .click() calls so we can inject files programmatically
// instead of opening the native OS file picker.
// Communicates with content script via window.postMessage.

(() => {
  console.log("[Zotero injector] Main-world script loaded");

  const attemptApi = globalThis.ZoteroInjectorAttempt;
  const attemptController = attemptApi.createController({
    getCurrentUrl: () => window.location.href,
  });
  let pendingFiles = null;
  let interceptedInput = null;
  let fileInputObserver = null;
  let fallbackTimer = null;

  // --- Phase 1: Patch HTMLInputElement.prototype.click ---
  // The Angular directive (xapscottyuploadertrigger) creates a hidden
  // <input type="file"> and calls .click() on it.  We intercept that
  // .click() so the native file-picker never opens.

  const originalClick = HTMLInputElement.prototype.click;

  HTMLInputElement.prototype.click = function () {
    if (this.type === "file" && pendingFiles) {
      const current = requireCurrentAttempt(
        attemptController.getBinding()?.attemptNonce,
      );
      if (!current) return;
      console.log("[Zotero injector] Intercepted file-input .click()");
      interceptedInput = this;
      doInject(current.attemptNonce);
      return; // swallow — no native picker
    }
    return originalClick.apply(this, arguments);
  };

  const originalShowPicker = HTMLInputElement.prototype.showPicker;
  if (typeof originalShowPicker === "function") {
    HTMLInputElement.prototype.showPicker = function () {
      if (this.type === "file" && pendingFiles) {
        const current = requireCurrentAttempt(
          attemptController.getBinding()?.attemptNonce,
        );
        if (!current) return;
        console.log("[Zotero injector] Intercepted file-input .showPicker()");
        interceptedInput = this;
        doInject(current.attemptNonce);
        return;
      }
      return originalShowPicker.apply(this, arguments);
    };
  }

  const originalShowOpenFilePicker =
    typeof window.showOpenFilePicker === "function"
      ? window.showOpenFilePicker.bind(window)
      : null;

  if (originalShowOpenFilePicker) {
    window.showOpenFilePicker = async function () {
      if (pendingFiles) {
        const current = requireCurrentAttempt(
          attemptController.getBinding()?.attemptNonce,
        );
        if (!current) {
          throw new Error(attemptApi.ATTEMPT_MISMATCH_ERROR);
        }
        console.log(
          "[Zotero injector] Intercepted window.showOpenFilePicker()",
        );
        try {
          const handles = pendingFiles.map(createFileHandle);
          clearPendingAttempt();
          reply(true, null, current.attemptNonce);
          return handles;
        } catch {
          console.error("[Zotero injector] Could not create file handles");
          clearPendingAttempt();
          reply(false, attemptApi.INJECTOR_FAILURE_ERROR, current.attemptNonce);
          throw new Error(attemptApi.INJECTOR_FAILURE_ERROR);
        }
      }

      return originalShowOpenFilePicker.apply(this, arguments);
    };
  }

  // --- Phase 2: Listen for arm / inject commands from content script ---

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "__zotero_to_injector") return;

    const { attemptNonce, command, files, notebookPathname, reason } = e.data;

    if (command === "arm") {
      if (!Array.isArray(files) || files.length === 0) {
        postStatus(
          "armed",
          { success: false, error: attemptApi.INJECTOR_FAILURE_ERROR },
          attemptApi.readAttemptNonce(attemptNonce),
        );
        return;
      }
      const binding = attemptController.arm({
        attemptNonce,
        notebookPathname,
      });
      if (!binding) {
        postStatus(
          "armed",
          { success: false, error: attemptApi.ATTEMPT_MISMATCH_ERROR },
          attemptApi.readAttemptNonce(attemptNonce),
        );
        return;
      }
      pendingFiles = files;
      interceptedInput = null;
      watchForFileInputs(binding.attemptNonce);
      console.log(
        "[Zotero injector] Armed with " + (files ? files.length : 0) + " files",
      );
      postStatus("armed", { success: true }, binding.attemptNonce);
      return;
    }

    if (command === "disarm") {
      if (attemptController.matches(attemptNonce)) {
        clearPendingAttempt();
        postStatus("disarmed", { success: true }, attemptNonce);
      }
      return;
    }

    if (command === "inject-existing") {
      const current = requireCurrentAttempt(attemptNonce);
      if (!current) return;
      const input = findCandidateFileInput();
      const found = Boolean(input && pendingFiles);
      console.log(
        "[Zotero injector] Existing-input probe (" +
          (reason || "unknown") +
          "): " +
          (found ? "found file input" : "no file input found"),
      );
      postStatus(
        "inject-existing",
        { found, reason: reason || null },
        current.attemptNonce,
      );
      if (found) {
        interceptedInput = input;
        doInject(current.attemptNonce);
      }
      return;
    }

    if (command === "drop-files") {
      const current = requireCurrentAttempt(attemptNonce);
      if (!current) return;
      console.log("[Zotero injector] Synthetic drop is disabled");
      postStatus(
        "drop-files",
        {
          found: false,
          dispatched: false,
          reason: reason || null,
        },
        current.attemptNonce,
      );
      return;
    }
  });

  // --- Phase 3: Inject files into the captured input ---

  function doInject(attemptNonce) {
    const current = requireCurrentAttempt(attemptNonce);
    if (!current) return;
    const input = interceptedInput;
    const files = pendingFiles;

    if (!input || !files || files.length === 0) {
      clearPendingAttempt();
      console.error(
        "[Zotero injector] doInject called but missing input or files",
      );
      reply(false, attemptApi.INJECTOR_FAILURE_ERROR, current.attemptNonce);
      return;
    }

    // Reset state so we don't re-intercept on future clicks
    clearPendingAttempt();

    try {
      const dt = createDataTransfer(files);
      input.files = dt.files;

      // Fire both events so different framework paths notice the new files.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      console.log("[Zotero injector] Injected " + dt.files.length + " file(s)");
      reply(true, null, current.attemptNonce);
    } catch {
      console.error("[Zotero injector] File injection failed");
      reply(false, attemptApi.INJECTOR_FAILURE_ERROR, current.attemptNonce);
    }
  }

  function clearPendingAttempt() {
    stopWatchingForFileInputs();
    pendingFiles = null;
    interceptedInput = null;
    attemptController.clear();
  }

  function requireCurrentAttempt(attemptNonce) {
    const checked = attemptController.check(attemptNonce);
    if (checked.ok) return checked;
    if (checked.currentAttempt) clearPendingAttempt();
    reply(false, attemptApi.ATTEMPT_MISMATCH_ERROR, checked.attemptNonce);
    return null;
  }

  function postStatus(status, fields, attemptNonce) {
    window.postMessage(
      {
        type: "__zotero_from_injector",
        status,
        attemptNonce: attemptNonce ?? null,
        ...fields,
      },
      "*",
    );
  }

  function reply(success, error, attemptNonce) {
    window.postMessage(
      {
        type: "__zotero_from_injector",
        attemptNonce: attemptNonce ?? null,
        success,
        error: error || null,
      },
      "*",
    );
  }

  function watchForFileInputs(attemptNonce) {
    stopWatchingForFileInputs();

    if (!document.documentElement) return;

    fileInputObserver = new MutationObserver((records) => {
      if (!pendingFiles || interceptedInput) return;
      if (!requireCurrentAttempt(attemptNonce)) return;

      for (const record of records) {
        for (const node of record.addedNodes) {
          const input = findFileInput(node);
          if (!input) continue;
          console.log("[Zotero injector] Observed file input in DOM");
          interceptedInput = input;
          queueMicrotask(() => {
            if (pendingFiles && interceptedInput === input) {
              console.log(
                "[Zotero injector] Injecting into observed file input",
              );
              doInject(attemptNonce);
            }
          });
          return;
        }
      }
    });

    fileInputObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Poll every 500ms for up to 120 seconds.  The MutationObserver handles
    // newly added nodes, but Angular may reuse or reveal an existing element
    // that the observer misses.
    let pollCount = 0;
    const maxPolls = 240; // 240 x 500ms = 120s
    fallbackTimer = setInterval(() => {
      pollCount++;
      if (!pendingFiles || interceptedInput || pollCount > maxPolls) {
        stopWatchingForFileInputs();
        return;
      }
      if (!requireCurrentAttempt(attemptNonce)) return;

      const input = findCandidateFileInput();
      if (!input) {
        if (pollCount % 10 === 0) {
          console.log(
            "[Zotero injector] Still polling for file input... (" +
              pollCount +
              "/" +
              maxPolls +
              ")",
          );
        }
        return;
      }

      console.log(
        "[Zotero injector] Poll found file input after " +
          pollCount * 500 +
          "ms",
      );
      interceptedInput = input;
      doInject(attemptNonce);
    }, 500);
  }

  function stopWatchingForFileInputs() {
    if (fileInputObserver) {
      fileInputObserver.disconnect();
      fileInputObserver = null;
    }

    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function findFileInput(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches('input[type="file"]')) return node;
    return node.querySelector('input[type="file"]');
  }

  function findCandidateFileInput() {
    const inputs = collectFileInputs(document);
    return inputs.length ? inputs[inputs.length - 1] : null;
  }

  function collectFileInputs(root) {
    const results = [];
    const visitedShadowRoots = new Set();
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current.querySelectorAll !== "function") continue;

      for (const input of current.querySelectorAll('input[type="file"]')) {
        if (input.isConnected) {
          results.push(input);
        }
      }

      const elements = current.querySelectorAll("*");
      for (const el of elements) {
        if (el.shadowRoot && !visitedShadowRoots.has(el.shadowRoot)) {
          visitedShadowRoots.add(el.shadowRoot);
          stack.push(el.shadowRoot);
        }
      }
    }

    return results;
  }

  function createFileHandle(fileData) {
    const file = decodeFile(fileData);

    return {
      kind: "file",
      name: file.name,
      async getFile() {
        return file;
      },
      async queryPermission() {
        return "granted";
      },
      async requestPermission() {
        return "granted";
      },
      async isSameEntry(other) {
        return Boolean(
          other && other.kind === "file" && other.name === file.name,
        );
      },
    };
  }

  function decodeFile(fileData) {
    const binaryStr = atob(fileData.base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new File([bytes], fileData.fileName, { type: fileData.contentType });
  }

  function createDataTransfer(files) {
    const dt = new DataTransfer();
    for (const f of files) {
      dt.items.add(decodeFile(f));
    }
    return dt;
  }
})();
