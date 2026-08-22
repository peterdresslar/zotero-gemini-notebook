(() => {
  "use strict";

  const CREATE_NOTEBOOK_SELECTORS = [
    "button.create-new-button",
    "mat-card.create-new-action-button",
    '[role="button"].create-new-action-button',
    "nb-button.create-notebook-button button",
  ];
  const ADD_SOURCES_SELECTORS = [
    "button.add-source-button",
    '[role="button"].add-source-button',
  ];
  const UPLOAD_TRIGGER_SELECTOR = "[xapscottyuploadertrigger]";
  const UPLOAD_ICON_BUTTON_SELECTOR = "button.drop-zone-icon-button";

  function requireFunction(value, label) {
    if (typeof value !== "function") {
      throw new TypeError(`${label} must be a function`);
    }
    return value;
  }

  function normalizeText(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function createLocator(options = {}) {
    const queryAll = requireFunction(options.queryAll, "queryAll");
    const isVisible = requireFunction(options.isVisible, "isVisible");
    const isDisabled = requireFunction(options.isDisabled, "isDisabled");

    function eligible(element) {
      return Boolean(element && isVisible(element) && !isDisabled(element));
    }

    function query(root, selector) {
      return Array.from(queryAll(root, selector) ?? []);
    }

    function findFirst(root, selectors) {
      for (const selector of selectors) {
        const match = query(root, selector).find(eligible);
        if (match) return match;
      }
      return null;
    }

    function findCreateNotebookControl(root) {
      return findFirst(root, CREATE_NOTEBOOK_SELECTORS);
    }

    function findAddSourcesControl(root) {
      return findFirst(root, ADD_SOURCES_SELECTORS);
    }

    function hasUploadIcon(element) {
      return query(element, "mat-icon").some(
        (icon) => normalizeText(icon.textContent) === "upload",
      );
    }

    function findUploadFileControls(root) {
      const matches = [];
      const seen = new Set();

      function add(element) {
        if (!eligible(element) || seen.has(element)) return;
        seen.add(element);
        matches.push(element);
      }

      for (const element of query(root, UPLOAD_TRIGGER_SELECTOR)) add(element);
      for (const element of query(root, UPLOAD_ICON_BUTTON_SELECTOR)) {
        if (hasUploadIcon(element)) add(element);
      }

      return matches;
    }

    return Object.freeze({
      findCreateNotebookControl,
      findAddSourcesControl,
      findUploadFileControls,
    });
  }

  globalThis.ZoteroGeminiControls = Object.freeze({ createLocator });
})();
