(() => {
  "use strict";

  const PANEL_ID = "zotero-notebooklm-dialog-upload-status";
  const PANEL_MARKER = "data-zotero-dialog-upload-status";
  const SPINNER_MARKER = "data-zotero-dialog-upload-spinner";
  const DIALOG_SELECTOR = 'mat-dialog-container[role="dialog"]';

  function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
    return value.trim();
  }

  function formatAddingMessage(createdNotebook = false) {
    return createdNotebook
      ? "New notebook created. Adding Zotero sources…"
      : "Adding Zotero sources…";
  }

  function formatAssistedMessage(fileCount, action) {
    if (!Number.isInteger(fileCount) || fileCount <= 0) {
      throw new TypeError("File count must be a positive integer");
    }
    const actionLabel =
      action === "add-sources"
        ? "Add sources"
        : action === "upload-files"
          ? "Upload files"
          : null;
    if (!actionLabel) {
      throw new TypeError(
        "Assisted action must be add-sources or upload-files",
      );
    }
    const noun = fileCount === 1 ? "file is" : "files are";
    const instruction =
      action === "upload-files"
        ? "Now processing files: please don't leave this window. If you are stuck, try pressing the Upload files button."
        : "Click the highlighted Add sources button to open the upload dialog.";
    const message = `${fileCount} ${noun} ready from Zotero. ${instruction}`;
    return action === "upload-files" ? `Zotero Connector: ${message}` : message;
  }

  function isActiveDialog(element, view) {
    if (
      !element ||
      element.isConnected === false ||
      element.hasAttribute("hidden") ||
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }

    if (typeof view?.getComputedStyle === "function") {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
    }
    return true;
  }

  function findPlacement(document) {
    const candidates = Array.from(document.querySelectorAll(DIALOG_SELECTOR));
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const container = candidates[index];
      const dialog = container.querySelector("add-sources-dialog");
      if (
        !isActiveDialog(container, document.defaultView) ||
        !isActiveDialog(dialog, document.defaultView)
      ) {
        continue;
      }

      const content =
        dialog.querySelector("[mat-dialog-content]") ||
        dialog.querySelector(".mat-mdc-dialog-content");
      const dropTarget =
        content?.querySelector("[xapscottyuploaderdropzone]") ||
        content?.querySelector(".xap-uploader-dropzone");
      if (
        !isActiveDialog(content, document.defaultView) ||
        !isActiveDialog(dropTarget, document.defaultView)
      ) {
        continue;
      }

      let anchor = dropTarget;
      while (anchor.parentNode && anchor.parentNode !== content) {
        anchor = anchor.parentNode;
      }
      if (anchor.parentNode === content) {
        return { host: content, before: anchor };
      }
    }
    return null;
  }

  function createController(options = {}) {
    const document = options.document ?? globalThis.document;
    const MutationObserverConstructor =
      options.MutationObserver ?? globalThis.MutationObserver;
    const showFallback = options.showFallback ?? (() => {});
    const hideFallback = options.hideFallback ?? (() => {});

    if (!document || typeof document.createElement !== "function") {
      throw new TypeError("A document with createElement is required");
    }
    if (typeof MutationObserverConstructor !== "function") {
      throw new TypeError("A MutationObserver constructor is required");
    }
    if (
      typeof showFallback !== "function" ||
      typeof hideFallback !== "function"
    ) {
      throw new TypeError("Fallback handlers must be functions");
    }

    let active = false;
    let destroyed = false;
    let fallbackVisible = false;
    let fallbackMessage = "";
    let fallbackKind = "status";
    let message = "";
    let kind = "status";
    let spinnerVisible = false;
    let observer = null;
    let panel = null;
    let spinnerAnimation = null;

    function stopSpinner() {
      spinnerAnimation?.cancel?.();
      spinnerAnimation = null;
    }

    function createPanel() {
      const status = document.createElement("div");
      status.id = PANEL_ID;
      status.setAttribute(PANEL_MARKER, "true");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");
      Object.assign(status.style, {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        margin: "0 0 18px",
        padding: "10px 12px",
        border: "1px solid rgba(26, 115, 232, 0.28)",
        borderRadius: "8px",
        background: "rgba(26, 115, 232, 0.08)",
        color: "inherit",
        font: '500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        pointerEvents: "none",
      });

      const spinner = document.createElement("span");
      spinner.setAttribute(SPINNER_MARKER, "true");
      spinner.setAttribute("aria-hidden", "true");
      Object.assign(spinner.style, {
        boxSizing: "border-box",
        flex: "0 0 auto",
        width: "16px",
        height: "16px",
        border: "2px solid rgba(26, 115, 232, 0.3)",
        borderTopColor: "#1a73e8",
        borderRadius: "50%",
      });

      const text = document.createElement("span");
      text.setAttribute("data-zotero-dialog-upload-message", "true");
      status.appendChild(spinner);
      status.appendChild(text);

      return status;
    }

    function startSpinner(spinner) {
      const reducedMotion =
        document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches === true;
      if (
        !spinnerAnimation &&
        !reducedMotion &&
        typeof spinner?.animate === "function"
      ) {
        spinnerAnimation = spinner.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          { duration: 900, iterations: Infinity },
        );
      }
    }

    function ensurePanel() {
      const connectedPanel = document.getElementById(PANEL_ID);
      if (connectedPanel && connectedPanel !== panel) {
        stopSpinner();
        panel?.remove();
        panel = connectedPanel;
      }
      if (!panel) panel = createPanel();

      panel.setAttribute(PANEL_MARKER, "true");
      panel.setAttribute("role", kind === "error" ? "alert" : "status");
      panel.setAttribute(
        "aria-live",
        kind === "error" ? "assertive" : "polite",
      );
      panel.setAttribute("aria-atomic", "true");
      panel.style.pointerEvents = "none";
      panel.style.border =
        kind === "error"
          ? "1px solid rgba(179, 38, 30, 0.34)"
          : "1px solid rgba(26, 115, 232, 0.28)";
      panel.style.background =
        kind === "error"
          ? "rgba(179, 38, 30, 0.1)"
          : "rgba(26, 115, 232, 0.08)";
      const spinner = panel.querySelector(`[${SPINNER_MARKER}="true"]`);
      if (spinner) {
        spinner.hidden = !spinnerVisible;
        spinner.style.display = spinnerVisible ? "inline-block" : "none";
        if (!spinnerVisible) stopSpinner();
        else startSpinner(spinner);
      }
      const text = panel.querySelector(
        '[data-zotero-dialog-upload-message="true"]',
      );
      if (text && text.textContent !== message) text.textContent = message;
      return panel;
    }

    function setFallbackVisible(nextVisible) {
      if (nextVisible) {
        if (
          !fallbackVisible ||
          fallbackMessage !== message ||
          fallbackKind !== kind
        ) {
          showFallback(message, kind);
          fallbackMessage = message;
          fallbackKind = kind;
        }
        fallbackVisible = true;
      } else if (fallbackVisible) {
        hideFallback();
        fallbackVisible = false;
        fallbackMessage = "";
        fallbackKind = "status";
      }
    }

    function clearFallback() {
      hideFallback();
      fallbackVisible = false;
      fallbackMessage = "";
      fallbackKind = "status";
    }

    function syncPlacement() {
      if (!active || destroyed) return false;
      const placement = findPlacement(document);
      if (!placement) {
        panel?.remove();
        setFallbackVisible(true);
        return false;
      }

      const status = ensurePanel();
      if (placement.before) {
        if (
          status.parentNode !== placement.host ||
          status.nextSibling !== placement.before
        ) {
          placement.host.insertBefore(status, placement.before);
        }
      } else if (status.parentNode !== placement.host) {
        placement.host.appendChild(status);
      }
      setFallbackVisible(false);
      return true;
    }

    function ensureObserver() {
      if (observer || !active || destroyed) return;
      const root = document.body ?? document.documentElement;
      if (!root) return;
      observer = new MutationObserverConstructor(() => {
        syncPlacement();
      });
      observer.observe(root, { childList: true, subtree: true });
    }

    function stopObserver() {
      observer?.disconnect();
      observer = null;
    }

    function show(nextMessage, options = {}) {
      if (destroyed) {
        throw new Error("Dialog upload status controller has been destroyed");
      }
      message = requireNonEmptyString(nextMessage, "Status message");
      kind = options.kind ?? "status";
      if (kind !== "status" && kind !== "error") {
        throw new TypeError("Status kind must be status or error");
      }
      spinnerVisible = options.spinner ?? kind === "status";
      if (typeof spinnerVisible !== "boolean") {
        throw new TypeError("Spinner visibility must be a boolean");
      }
      clearFallback();
      active = true;
      ensurePanel();
      syncPlacement();
      if (kind === "error") stopObserver();
      else ensureObserver();
    }

    function setAdding({ createdNotebook = false } = {}) {
      show(formatAddingMessage(createdNotebook), { spinner: true });
    }

    function setAssisted({ action, fileCount } = {}) {
      show(formatAssistedMessage(fileCount, action), {
        spinner: action === "upload-files",
      });
    }

    function showError(nextMessage) {
      show(nextMessage, { kind: "error" });
    }

    function hide() {
      active = false;
      stopObserver();
      stopSpinner();
      panel?.remove();
      panel = null;
      clearFallback();
    }

    function destroy() {
      if (destroyed) return;
      hide();
      destroyed = true;
    }

    return Object.freeze({
      show,
      setAdding,
      setAssisted,
      showError,
      hide,
      destroy,
    });
  }

  globalThis.ZoteroDialogUploadStatus = Object.freeze({
    PANEL_ID,
    createController,
    formatAddingMessage,
    formatAssistedMessage,
  });
})();
