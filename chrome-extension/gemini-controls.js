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
  const SOURCE_PANEL_SELECTORS = [".source-panel-content", "source-picker"];
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
      const structural = findFirst(root, ADD_SOURCES_SELECTORS);
      if (structural) return structural;
      for (const panelSelector of SOURCE_PANEL_SELECTORS) {
        for (const panel of query(root, panelSelector)) {
          const matched = query(panel, "button.mat-tonal-button").find(
            (element) => eligible(element) && hasAddIcon(element),
          );
          if (matched) return matched;
        }
      }
      return null;
    }

    function hasAddIcon(element) {
      return query(element, "mat-icon").some((icon) => {
        const text = normalizeText(icon.textContent);
        return text === "add" || text === "add_2";
      });
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
