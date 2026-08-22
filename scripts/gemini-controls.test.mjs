import assert from "node:assert/strict";
import test from "node:test";

import "../chrome-extension/gemini-controls.js";

const { createLocator } = globalThis.ZoteroGeminiControls;

class FakeElement {
  constructor({
    tagName = "button",
    textContent = "",
    attributes = {},
    visible = true,
    disabled = false,
  } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    this.visible = visible;
    this.disabled = disabled;
    this.attributes = new Map(Object.entries(attributes));
    this.queryResults = new Map();
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  mapQuery(selector, elements) {
    this.queryResults.set(selector, elements);
    return this;
  }

  querySelectorAll(selector) {
    return this.queryResults.get(selector) ?? [];
  }
}

function element(options) {
  return new FakeElement(options);
}

function rootWith(entries = {}) {
  const root = new FakeElement({ tagName: "document" });
  for (const [selector, elements] of Object.entries(entries)) {
    root.mapQuery(selector, elements);
  }
  return root;
}

function locator() {
  return createLocator({
    queryAll: (root, selector) => root.querySelectorAll(selector),
    isVisible: (candidate) => candidate.visible,
    isDisabled: (candidate) => candidate.disabled,
  });
}

function uploadButton(icon, options = {}) {
  const button = element({
    textContent: options.textContent,
    visible: options.visible,
    disabled: options.disabled,
    attributes: options.attributes,
  });
  button.mapQuery("mat-icon", [
    element({ tagName: "mat-icon", textContent: icon }),
  ]);
  return button;
}

test("finds the French structural add control ahead of unrelated decoys", () => {
  const expected = element({ textContent: "Ajouter" });
  const decoy = element({ textContent: "Ajouter une note" });
  const root = rootWith({
    "button.add-source-button": [expected],
    '[role="button"].add-source-button': [decoy],
  });

  assert.equal(locator().findAddSourcesControl(root), expected);
});

test("prefers the French structural create button and keeps the card fallback", () => {
  const expectedButton = element({
    textContent: "Créer un notebook",
  });
  const expectedCard = element({
    tagName: "mat-card",
    textContent: "Créer un notebook",
  });
  const root = rootWith({
    "button.create-new-button": [expectedButton],
    "mat-card.create-new-action-button": [expectedCard],
  });

  assert.equal(locator().findCreateNotebookControl(root), expectedButton);

  root.mapQuery("button.create-new-button", []);
  assert.equal(locator().findCreateNotebookControl(root), expectedCard);
});

test("lists the uploader directive ahead of icon-based upload controls", () => {
  const expected = uploadButton("upload", {
    textContent: "Importer des fichiers",
    attributes: { xapscottyuploadertrigger: "" },
  });
  const iconFallback = uploadButton("upload", {
    textContent: "Importer des fichiers",
  });
  const root = rootWith({
    "[xapscottyuploadertrigger]": [expected],
    "button.drop-zone-icon-button": [expected, iconFallback],
  });

  assert.deepEqual(locator().findUploadFileControls(root), [
    expected,
    iconFallback,
  ]);
});

test("uses only the upload-icon fallback among localized dialog siblings", () => {
  const websites = uploadButton("link", { textContent: "Sites Web" });
  const youtube = uploadButton("video_youtube", { textContent: "YouTube" });
  const drive = uploadButton("drive", { textContent: "Drive" });
  const copiedText = uploadButton("content_paste", {
    textContent: "Texte copié",
  });
  const expected = uploadButton("  UPLOAD\n", {
    textContent: "Importer des fichiers",
  });
  const root = rootWith({
    "button.drop-zone-icon-button": [
      websites,
      youtube,
      drive,
      copiedText,
      expected,
    ],
  });

  assert.deepEqual(locator().findUploadFileControls(root), [expected]);
});

test("rejects hidden and disabled structural controls", () => {
  const hiddenCreate = element({
    textContent: "Créer un notebook",
    visible: false,
  });
  const disabledAdd = element({ textContent: "Ajouter", disabled: true });
  const hiddenUploader = element({
    textContent: "Importer des fichiers",
    visible: false,
  });
  const disabledUploadFallback = uploadButton("upload", {
    textContent: "Importer des fichiers",
    disabled: true,
  });
  const root = rootWith({
    "mat-card.create-new-action-button": [hiddenCreate],
    "button.add-source-button": [disabledAdd],
    "[xapscottyuploadertrigger]": [hiddenUploader],
    "button.drop-zone-icon-button": [disabledUploadFallback],
  });
  const controls = locator();

  assert.equal(controls.findCreateNotebookControl(root), null);
  assert.equal(controls.findAddSourcesControl(root), null);
  assert.deepEqual(controls.findUploadFileControls(root), []);
});

test("returns no controls for an unknown Gemini Notebook layout", () => {
  const controls = locator();
  const root = rootWith();

  assert.equal(controls.findCreateNotebookControl(root), null);
  assert.equal(controls.findAddSourcesControl(root), null);
  assert.deepEqual(controls.findUploadFileControls(root), []);
});
