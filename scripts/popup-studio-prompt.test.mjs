import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import * as compatibility from "../chrome-extension/compatibility.js";
import * as bridgeRequests from "../chrome-extension/bridge-requests.js";

const popupSource = await readFile(
  new globalThis.URL("../chrome-extension/popup.js", import.meta.url),
  "utf8",
);
const popupHTML = await readFile(
  new globalThis.URL("../chrome-extension/popup.html", import.meta.url),
  "utf8",
);
const executableSource = popupSource
  .replace(/^import \{[\s\S]*?\} from "[^"]+";\n/gmu, "")
  .replace(/^import "[^"]+";\n/gmu, "");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function pending(overrides = {}) {
  return {
    count: 1,
    compatibleChromeExtensionVersions: ["0.4.1"],
    jobId: "job-one",
    destination: "active-or-new",
    items: [
      {
        attachmentId: 1,
        fileName: "source.pdf",
        title: "Source",
        contentType: "application/pdf",
      },
    ],
    ...overrides,
  };
}

function element() {
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    style: {},
    listeners: new Map(),
    classList: { add() {} },
    addEventListener(event, listener) {
      this.listeners.set(event, listener);
    },
    appendChild() {},
    append() {},
    replaceChildren() {},
  };
}

function harness({ data = pending(), clipboard } = {}) {
  const elements = new Map(
    [...popupHTML.matchAll(/id="([^"]+)"/gu)].map((match) => [
      match[1],
      element(),
    ]),
  );
  const copiedText = [];
  const messages = [];
  const timeouts = [];
  let nextPending = data;
  let onReady;
  let closeCount = 0;
  const navigator = {
    clipboard: clipboard || {
      writeText: async (text) => copiedText.push(text),
    },
  };
  const context = vm.createContext({
    ...compatibility,
    ...bridgeRequests,
    TextEncoder: globalThis.TextEncoder,
    URL: globalThis.URL,
    crypto: { randomUUID: () => "batch-one" },
    navigator,
    document: {
      addEventListener: (_event, listener) => {
        onReady = listener;
      },
      getElementById: (id) => {
        assert.ok(elements.has(id), `Missing popup element ${id}`);
        return elements.get(id);
      },
      createElement: element,
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "0.4.1" }) },
      tabs: {
        query: async () => [
          { id: 1, url: "https://notebook.google.com/notebook/current" },
        ],
        sendMessage: async (_tabId, message) => {
          messages.push(message);
          return { success: true };
        },
      },
    },
    fetch: async (url) => {
      const body = url.endsWith("/pending")
        ? await nextPending
        : {
            fileName: "source.pdf",
            contentType: "application/pdf",
            data: "YQ==",
          };
      return { ok: true, json: async () => body };
    },
    ZoteroUploadTransfer: { splitBase64IntoChunks: (data) => [data] },
    ZoteroUploadDestination: {
      readDestination: (value) => value,
      requestPreparedDestination: async () => null,
    },
    ZoteroUploadHandoff: { isCompatiblePingResponse: () => true },
    setTimeout: (callback) => timeouts.push(callback),
    window: {
      close: () => {
        closeCount += 1;
      },
    },
  });
  vm.runInContext(executableSource, context, { filename: "popup.js" });
  return {
    context,
    copiedText,
    messages,
    navigator,
    elements,
    get: (id) => elements.get(id),
    click: (id) => elements.get(id).listeners.get("click")(),
    setPending: (value) => {
      nextPending = value;
    },
    ready: async () => {
      onReady();
      await new Promise((resolve) => globalThis.setImmediate(resolve));
    },
    refresh: () => context.loadPending(),
    runTimeouts: () => timeouts.forEach((callback) => callback()),
    getCloseCount: () => closeCount,
  };
}

test("keeps the optional prompt controls hidden without safe job-bound text", async () => {
  const h = harness();
  await h.ready();
  for (const studioPrompt of [
    undefined,
    null,
    false,
    1,
    {},
    [],
    "",
    " \t\r\n ",
    "a".repeat(4001),
    "é".repeat(2001),
    "bad\u0000text",
    "bad\u000btext",
    "bad\u001ftext",
    "bad\u007ftext",
    "bad\ud800text",
    "bad\udffftext",
  ]) {
    h.setPending(pending({ studioPrompt }));
    await h.refresh();
    assert.equal(h.get("studio-prompt").hidden, true);
    assert.equal(h.get("copy-studio-prompt-btn").disabled, true);
    await h.click("copy-studio-prompt-btn");
  }
  h.setPending(pending({ jobId: null, studioPrompt: "Prompt without a job" }));
  await h.refresh();
  assert.equal(h.get("studio-prompt").hidden, true);
  assert.deepEqual(h.copiedText, []);
});

test("copies exact Unicode, whitespace, and markup as plain clipboard text", async () => {
  const studioPrompt =
    " \tCompare evidence.\r\nFocus on 🐝 and <b>uncertainty</b>.  ";
  const h = harness({ data: pending({ studioPrompt }) });
  await h.ready();
  assert.equal(h.get("studio-prompt").hidden, false);
  assert.equal(h.get("studio-prompt-copied").hidden, true);
  await h.click("copy-studio-prompt-btn");
  assert.deepEqual(h.copiedText, [studioPrompt]);
  assert.equal(h.get("studio-prompt-copied").hidden, false);
  assert.equal(
    h.get("studio-prompt-status").textContent,
    "Copied — ready to paste.",
  );
  assert.ok(
    [...h.elements.values()].every(
      (node) => !node.innerHTML.includes(studioPrompt),
    ),
  );

  h.setPending(pending({ studioPrompt: "🐝".repeat(1000) }));
  await h.refresh();
  assert.equal(h.get("studio-prompt").hidden, false);
  await h.click("copy-studio-prompt-btn");
  assert.equal(h.copiedText.at(-1), "🐝".repeat(1000));
});

test("acknowledges copy only after clipboard success and permits retry", async () => {
  const write = deferred();
  const h = harness({
    data: pending({ studioPrompt: "Create an Audio Overview." }),
    clipboard: { writeText: () => write.promise },
  });
  await h.ready();
  const copying = h.click("copy-studio-prompt-btn");
  assert.equal(h.get("copy-studio-prompt-btn").disabled, true);
  assert.equal(h.get("studio-prompt-copied").hidden, true);
  assert.equal(h.get("studio-prompt-status").textContent, "");
  write.reject(new Error("Private clipboard diagnostic"));
  await copying;
  assert.equal(h.get("studio-prompt-copied").hidden, true);
  assert.equal(h.get("copy-studio-prompt-btn").disabled, false);
  assert.match(
    h.get("studio-prompt-status").textContent,
    /Could not copy.*try again/u,
  );
  assert.doesNotMatch(h.get("studio-prompt-status").textContent, /Private/u);

  h.navigator.clipboard = { writeText: async () => {} };
  await h.click("copy-studio-prompt-btn");
  assert.equal(h.get("studio-prompt-copied").hidden, false);
  assert.equal(h.get("copy-studio-prompt-btn").disabled, false);
});

test("reports unavailable clipboard support without claiming success", async () => {
  const h = harness({ data: pending({ studioPrompt: "Prompt" }) });
  await h.ready();
  h.navigator.clipboard = undefined;
  await h.click("copy-studio-prompt-btn");
  assert.equal(h.get("studio-prompt-copied").hidden, true);
  assert.equal(h.get("copy-studio-prompt-btn").disabled, false);
  assert.match(h.get("studio-prompt-status").textContent, /Could not copy/u);
});

test("refresh clears copy feedback immediately and hides failed or incompatible responses", async () => {
  const data = pending({ studioPrompt: "Prompt" });
  const h = harness({ data });
  await h.ready();
  await h.click("copy-studio-prompt-btn");
  const refreshed = deferred();
  h.setPending(refreshed.promise);
  const refresh = h.refresh();
  assert.equal(h.get("studio-prompt").hidden, true);
  assert.equal(h.get("studio-prompt-copied").hidden, true);
  assert.equal(h.get("studio-prompt-status").textContent, "");
  refreshed.resolve(data);
  await refresh;
  assert.equal(h.get("studio-prompt").hidden, false);
  assert.equal(h.get("studio-prompt-copied").hidden, true);

  h.setPending(
    pending({ studioPrompt: "Prompt", compatibleChromeExtensionVersions: [] }),
  );
  await h.refresh();
  assert.equal(h.get("studio-prompt").hidden, true);

  h.setPending(Promise.reject(new Error("Zotero is unavailable")));
  await h.refresh();
  assert.equal(h.get("studio-prompt").hidden, true);
});

test("does not apply an old copy result to a refreshed prompt or job", async () => {
  for (const replacement of [
    pending({ studioPrompt: "Different prompt" }),
    pending({ jobId: "job-two", studioPrompt: "Original prompt" }),
    pending({ studioPrompt: "Original prompt" }),
  ]) {
    const write = deferred();
    const h = harness({
      data: pending({ studioPrompt: "Original prompt" }),
      clipboard: { writeText: () => write.promise },
    });
    await h.ready();
    const copying = h.click("copy-studio-prompt-btn");
    h.setPending(replacement);
    await h.refresh();
    write.resolve();
    await copying;
    assert.equal(h.get("studio-prompt-copied").hidden, true);
    assert.equal(h.get("studio-prompt-status").textContent, "");
    assert.equal(h.get("copy-studio-prompt-btn").disabled, false);
  }
});

test("ignores old pending responses arriving after a newer refresh", async () => {
  const h = harness();
  await h.ready();
  const older = deferred();
  h.setPending(older.promise);
  const oldRefresh = h.refresh();
  h.setPending(pending({ jobId: "job-two", studioPrompt: "Current prompt" }));
  await h.refresh();
  older.resolve(pending({ studioPrompt: "Old prompt" }));
  await oldRefresh;
  await h.click("copy-studio-prompt-btn");
  assert.deepEqual(h.copiedText, ["Current prompt"]);
});

test("keeps prompt copying separate from upload and preserves normal popup closing", async () => {
  const h = harness({
    data: pending({ studioPrompt: "Studio-only instructions" }),
  });
  await h.ready();
  await h.click("copy-studio-prompt-btn");
  await h.click("import-btn");
  assert.ok(
    h.messages.some((message) => message.action === "uploadBatchCommit"),
  );
  assert.ok(
    h.messages.every(
      (message) =>
        !JSON.stringify(message).includes("Studio-only instructions"),
    ),
  );
  assert.equal(h.get("studio-prompt").hidden, false);
  assert.equal(h.get("studio-prompt-copied").hidden, false);
  assert.equal(h.getCloseCount(), 0);
  h.runTimeouts();
  assert.equal(h.getCloseCount(), 1);
});

test("provides the requested label and accessible copy feedback with manual Studio guidance", () => {
  assert.match(popupHTML, /id="studio-prompt" class="studio-prompt" hidden/u);
  assert.match(
    popupHTML,
    /id="copy-studio-prompt-btn"[^>]*>\s*Copy Studio Prompt\s*<\/button>/u,
  );
  assert.match(
    popupHTML,
    /id="studio-prompt-copied"[^>]*aria-hidden="true"[^>]*hidden[^>]*>✓/u,
  );
  assert.match(
    popupHTML,
    /id="studio-prompt-status" role="status" aria-live="polite"/u,
  );
  assert.match(
    popupHTML,
    /Copy before importing, then paste into Studio instructions\./u,
  );
});
