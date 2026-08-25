import assert from "node:assert/strict";
import test from "node:test";

import "../chrome-extension/dialog-upload-status.js";

const {
  PANEL_ID,
  createController,
  formatAddingMessage,
  formatAssistedMessage,
} = globalThis.ZoteroDialogUploadStatus;

function matchesSimpleSelector(element, selector) {
  const tag = /^[a-z][\w-]*/i.exec(selector)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  for (const match of selector.matchAll(/\.([\w-]+)/g)) {
    const classes = (element.getAttribute("class") || "").split(/\s+/);
    if (!classes.includes(match[1])) return false;
  }

  for (const match of selector.matchAll(
    /\[([\w-]+)(?:=["']([^"']*)["'])?\]/g,
  )) {
    if (!element.hasAttribute(match[1])) return false;
    if (match[2] !== undefined && element.getAttribute(match[1]) !== match[2]) {
      return false;
    }
  }
  return true;
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimpleSelector(element, parts.at(-1))) return false;

  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (
      ancestor instanceof FakeElement &&
      !matchesSimpleSelector(ancestor, parts[index])
    ) {
      ancestor = ancestor.parentNode;
    }
    if (!(ancestor instanceof FakeElement)) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.hidden = false;
    this.animationCount = 0;
    this.animationCancelCount = 0;
    this.ownText = "";
  }

  get id() {
    return this.getAttribute("id") || "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get isConnected() {
    let current = this.parentNode;
    while (current) {
      if (current instanceof FakeDocument) return true;
      current = current.parentNode;
    }
    return false;
  }

  get nextSibling() {
    if (!(this.parentNode instanceof FakeElement)) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get textContent() {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value) {
    this.ownText = String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    if (index === -1) throw new Error("Reference node is not a child");
    child.remove();
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    if (!(this.parentNode instanceof FakeElement)) {
      this.parentNode = null;
      return;
    }
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current instanceof FakeElement) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  animate() {
    this.animationCount += 1;
    return {
      cancel: () => {
        this.animationCancelCount += 1;
      },
    };
  }
}

class FakeDocument {
  constructor({ reducedMotion = false } = {}) {
    this.documentElement = new FakeElement("html");
    this.documentElement.parentNode = this;
    this.body = new FakeElement("body");
    this.documentElement.appendChild(this.body);
    this.defaultView = {
      getComputedStyle: (element) => ({
        display: element.style.display || "block",
        visibility: element.style.visibility || "visible",
      }),
      matchMedia: () => ({ matches: reducedMotion }),
    };
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    return this.querySelectorAll(`[id="${id}"]`)[0] || null;
  }
}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    this.disconnectCount = 0;
    FakeMutationObserver.instances.push(this);
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
    this.disconnectCount += 1;
  }

  static reset() {
    FakeMutationObserver.instances = [];
  }

  static trigger() {
    for (const observer of FakeMutationObserver.instances) {
      if (observer.connected) observer.callback([]);
    }
  }
}

function element(tagName, attributes = {}) {
  const node = new FakeElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

function addDialog(document, { hidden = false, withContent = true } = {}) {
  const container = element("mat-dialog-container", { role: "dialog" });
  if (hidden) container.setAttribute("aria-hidden", "true");
  const dialog = element("add-sources-dialog");
  container.appendChild(dialog);
  document.body.appendChild(container);

  let content = null;
  let dropZone = null;
  let dropTarget = null;
  if (withContent) {
    content = element("div", { "mat-dialog-content": "" });
    dropZone = element("div", { class: "drop-zone-container" });
    dropTarget = element("div", {
      class: "xap-uploader-dropzone",
      xapscottyuploaderdropzone: "",
    });
    dialog.appendChild(content);
    content.appendChild(dropZone);
    dropZone.appendChild(dropTarget);
  }
  return { container, dialog, content, dropZone, dropTarget };
}

function controllerFor(document, fallbackEvents = []) {
  return createController({
    document,
    MutationObserver: FakeMutationObserver,
    showFallback: (message, kind) =>
      fallbackEvents.push(["show", message, kind]),
    hideFallback: () => fallbackEvents.push(["hide"]),
  });
}

test.beforeEach(() => FakeMutationObserver.reset());

test("formats distinct explicit Add sources and Upload files actions", () => {
  assert.equal(formatAddingMessage(false), "Adding Zotero sources…");
  assert.equal(
    formatAddingMessage(true),
    "New notebook created. Adding Zotero sources…",
  );
  assert.equal(
    formatAssistedMessage(1, "add-sources"),
    "1 file is ready from Zotero. Click the highlighted Add sources button to open the upload dialog.",
  );
  assert.equal(
    formatAssistedMessage(2, "upload-files"),
    "2 files are ready from Zotero. Chrome requires one click on the highlighted Upload files button to continue.",
  );
  assert.throws(
    () => formatAssistedMessage(0, "upload-files"),
    /positive integer/,
  );
  assert.throws(
    () => formatAssistedMessage(1, "unknown"),
    /add-sources or upload-files/,
  );
});

test("places one accessible status immediately before the dialog drop zone", () => {
  const document = new FakeDocument();
  const { content, dropZone } = addDialog(document);
  const controller = controllerFor(document);

  controller.setAdding({ createdNotebook: true });
  const panel = document.getElementById(PANEL_ID);
  assert.ok(panel);
  assert.equal(panel.parentNode, content);
  assert.equal(panel.nextSibling, dropZone);
  assert.equal(panel.getAttribute("data-zotero-dialog-upload-status"), "true");
  assert.equal(panel.getAttribute("role"), "status");
  assert.equal(panel.getAttribute("aria-live"), "polite");
  assert.equal(panel.getAttribute("aria-atomic"), "true");
  assert.equal(panel.style.pointerEvents, "none");
  assert.equal(panel.textContent, formatAddingMessage(true));

  const spinner = panel.querySelector(
    '[data-zotero-dialog-upload-spinner="true"]',
  );
  assert.equal(spinner.getAttribute("aria-hidden"), "true");
  assert.equal(spinner.animationCount, 1);

  controller.setAssisted({ action: "add-sources", fileCount: 2 });
  assert.equal(document.getElementById(PANEL_ID), panel);
  assert.equal(
    document.querySelectorAll("[data-zotero-dialog-upload-status]").length,
    1,
  );
  assert.equal(panel.textContent, formatAssistedMessage(2, "add-sources"));
  assert.equal(spinner.hidden, true);
  assert.equal(spinner.style.display, "none");
  assert.equal(spinner.animationCount, 1);
  assert.equal(spinner.animationCancelCount, 1);

  controller.setAssisted({ action: "upload-files", fileCount: 2 });
  assert.equal(panel.textContent, formatAssistedMessage(2, "upload-files"));
  assert.equal(spinner.hidden, true);
  assert.equal(spinner.style.display, "none");
  assert.equal(spinner.animationCount, 1);
  assert.equal(spinner.animationCancelCount, 1);

  controller.setAdding({ createdNotebook: true });
  assert.equal(panel.textContent, formatAddingMessage(true));
  assert.equal(spinner.hidden, false);
  assert.equal(spinner.style.display, "inline-block");
  assert.equal(spinner.animationCount, 2);
  assert.equal(spinner.animationCancelCount, 1);

  controller.hide();
  assert.equal(spinner.animationCancelCount, 2);
});

test("skips newer hidden dialogs and uses the active uploader", () => {
  const document = new FakeDocument();
  const active = addDialog(document);
  const hidden = addDialog(document);
  hidden.container.setAttribute("hidden", "");
  const inert = addDialog(document);
  inert.container.setAttribute("inert", "");
  const displayNone = addDialog(document);
  displayNone.container.style.display = "none";
  const controller = controllerFor(document);

  controller.setAdding();

  const panel = document.getElementById(PANEL_ID);
  assert.equal(panel.parentNode, active.content);
});

test("ignores decoys and rehomes across late and replaced generated dialogs", () => {
  const document = new FakeDocument();
  const fallbackEvents = [];
  const decoy = element("add-sources-dialog");
  document.body.appendChild(decoy);
  addDialog(document, { hidden: true });
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding();
  const panel = document.getElementById(PANEL_ID);
  assert.equal(panel, null);
  assert.deepEqual(fallbackEvents, [
    ["hide"],
    ["show", formatAddingMessage(false), "status"],
  ]);

  const first = addDialog(document);
  FakeMutationObserver.trigger();
  const placedPanel = document.getElementById(PANEL_ID);
  assert.equal(placedPanel.parentNode, first.content);
  assert.deepEqual(fallbackEvents.at(-1), ["hide"]);

  first.container.remove();
  const replacement = addDialog(document);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), placedPanel);
  assert.equal(placedPanel.parentNode, replacement.content);
  assert.equal(
    document.querySelectorAll("[data-zotero-dialog-upload-status]").length,
    1,
  );
});

test("moves to one fallback while Angular replaces only the drop zone", () => {
  const document = new FakeDocument();
  const fallbackEvents = [];
  const first = addDialog(document);
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding();
  const panel = document.getElementById(PANEL_ID);
  assert.ok(panel);

  first.dropZone.remove();
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), null);
  assert.deepEqual(fallbackEvents.at(-1), [
    "show",
    formatAddingMessage(false),
    "status",
  ]);

  const replacementDropZone = element("div", {
    class: "drop-zone-container",
  });
  replacementDropZone.appendChild(
    element("div", {
      class: "xap-uploader-dropzone",
      xapscottyuploaderdropzone: "",
    }),
  );
  first.content.appendChild(replacementDropZone);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), panel);
  assert.equal(panel.nextSibling, replacementDropZone);
  assert.deepEqual(fallbackEvents.at(-1), ["hide"]);
  assert.equal(
    document.querySelectorAll("[data-zotero-dialog-upload-status]").length,
    1,
  );
});

test("keeps the fallback until Angular adds the native drop target", () => {
  const document = new FakeDocument();
  const fallbackEvents = [];
  const generated = addDialog(document, { withContent: false });
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding();
  assert.equal(document.getElementById(PANEL_ID), null);

  const content = element("div", { "mat-dialog-content": "" });
  generated.dialog.appendChild(content);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), null);

  const dropZone = element("div", { class: "drop-zone-container" });
  content.appendChild(dropZone);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), null);

  const dropTarget = element("div", {
    class: "xap-uploader-dropzone",
    xapscottyuploaderdropzone: "",
  });
  dropZone.appendChild(dropTarget);
  FakeMutationObserver.trigger();
  const panel = document.getElementById(PANEL_ID);
  assert.equal(panel.parentNode, content);
  assert.equal(panel.nextSibling, dropZone);
  assert.deepEqual(fallbackEvents.at(-1), ["hide"]);
});

test("replaces a pre-existing page notice when the dialog is already ready", () => {
  const document = new FakeDocument();
  const fallbackEvents = [];
  addDialog(document);
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding({ createdNotebook: true });

  assert.ok(document.getElementById(PANEL_ID));
  assert.deepEqual(fallbackEvents, [["hide"]]);
});

test("renders terminal errors without a spinner and stops observing", () => {
  const document = new FakeDocument();
  const first = addDialog(document);
  const fallbackEvents = [];
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding();
  const observer = FakeMutationObserver.instances[0];
  assert.equal(observer.connected, true);

  controller.showError("Gemini Notebook did not accept the Zotero sources.");
  const panel = document.getElementById(PANEL_ID);
  const spinner = panel.querySelector(
    '[data-zotero-dialog-upload-spinner="true"]',
  );
  assert.equal(panel.getAttribute("role"), "alert");
  assert.equal(panel.getAttribute("aria-live"), "assertive");
  assert.equal(spinner.hidden, true);
  assert.equal(spinner.style.display, "none");
  assert.equal(observer.connected, false);

  first.container.remove();
  const replacement = addDialog(document);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), null);
  assert.equal(
    replacement.content.querySelector("[data-zotero-dialog-upload-status]"),
    null,
  );
});

test("renders one page-level alert when a terminal error has no dialog", () => {
  const document = new FakeDocument();
  const fallbackEvents = [];
  const controller = controllerFor(document, fallbackEvents);

  controller.setAdding();
  const observer = FakeMutationObserver.instances[0];
  controller.showError("Gemini Notebook did not accept the Zotero sources.");

  assert.equal(observer.connected, false);
  assert.equal(document.getElementById(PANEL_ID), null);
  assert.deepEqual(fallbackEvents.slice(-2), [
    ["hide"],
    ["show", "Gemini Notebook did not accept the Zotero sources.", "error"],
  ]);
});

test("honors reduced motion and cleans up without recreating the panel", () => {
  const document = new FakeDocument({ reducedMotion: true });
  addDialog(document);
  const controller = controllerFor(document);

  controller.setAdding();
  const panel = document.getElementById(PANEL_ID);
  const spinner = panel.querySelector(
    '[data-zotero-dialog-upload-spinner="true"]',
  );
  const observer = FakeMutationObserver.instances[0];
  assert.equal(spinner.animationCount, 0);

  controller.hide();
  assert.equal(document.getElementById(PANEL_ID), null);
  assert.equal(observer.connected, false);
  FakeMutationObserver.trigger();
  assert.equal(document.getElementById(PANEL_ID), null);

  controller.setAdding();
  assert.ok(document.getElementById(PANEL_ID));
  controller.destroy();
  assert.equal(document.getElementById(PANEL_ID), null);
  assert.throws(() => controller.setAdding(), /destroyed/);
});
