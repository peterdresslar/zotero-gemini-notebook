import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

const attemptSource = await readFile(
  new URL("../chrome-extension/injector-attempt.js", import.meta.url),
  "utf8",
);
const injectorSource = await readFile(
  new URL("../chrome-extension/injector.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new URL("../chrome-extension/content.js", import.meta.url),
  "utf8",
);
const popupSource = await readFile(
  new URL("../chrome-extension/popup.js", import.meta.url),
  "utf8",
);

const ATTEMPT_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_B = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_C = "33333333-3333-4333-8333-333333333333";
const NOTEBOOK_A = "/notebook/notebook-a";
const NOTEBOOK_B = "/notebook/notebook-b";

function loadAttemptApi() {
  const context = vm.createContext({ URL });
  vm.runInContext(attemptSource, context);
  return context.ZoteroInjectorAttempt;
}

test("binds attempts to an exact notebook and normalizes a trailing slash", () => {
  const api = loadAttemptApi();
  let currentUrl = `https://notebook.google.com${NOTEBOOK_A}/?hl=en#sources`;
  const binding = api.createUploadAttempt(NOTEBOOK_A, () => ATTEMPT_A);
  const controller = api.createController({
    getCurrentUrl: () => currentUrl,
  });

  assert.deepEqual(
    { ...binding },
    {
      attemptNonce: ATTEMPT_A,
      notebookPathname: NOTEBOOK_A,
    },
  );
  assert.deepEqual({ ...controller.arm(binding) }, { ...binding });
  assert.deepEqual(
    { ...controller.check(ATTEMPT_A) },
    {
      attemptNonce: ATTEMPT_A,
      currentAttempt: true,
      ok: true,
    },
  );

  currentUrl = `https://notebook.google.com${NOTEBOOK_B}`;
  assert.deepEqual(
    { ...controller.check(ATTEMPT_A) },
    {
      attemptNonce: ATTEMPT_A,
      currentAttempt: true,
      ok: false,
    },
  );

  for (const invalidUrl of [
    `http://notebook.google.com${NOTEBOOK_A}`,
    `https://notebook.google.com.evil.example${NOTEBOOK_A}`,
    `https://notebook.google.com${NOTEBOOK_A}/extra`,
  ]) {
    assert.equal(api.canonicalNotebookPathname(invalidUrl), null);
  }
  assert.throws(
    () => api.createUploadAttempt("/notebook/invalid/path", () => ATTEMPT_A),
    /binding is invalid/u,
  );
  assert.throws(
    () => api.createUploadAttempt(NOTEBOOK_A, () => "not-a-nonce"),
    /nonce is invalid/u,
  );
});

test("a stale nonce or arm cannot replace or satisfy the current attempt", () => {
  const api = loadAttemptApi();
  let currentUrl = `https://notebook.google.com${NOTEBOOK_B}`;
  const controller = api.createController({
    getCurrentUrl: () => currentUrl,
  });
  const current = api.createUploadAttempt(NOTEBOOK_B, () => ATTEMPT_B);
  const stale = api.createUploadAttempt(NOTEBOOK_B, () => ATTEMPT_A);

  assert.ok(controller.arm(current));
  assert.equal(controller.arm(stale), null);
  assert.deepEqual({ ...controller.getBinding() }, { ...current });
  assert.deepEqual(
    { ...controller.check(ATTEMPT_A) },
    {
      attemptNonce: ATTEMPT_A,
      currentAttempt: false,
      ok: false,
    },
  );
  assert.equal(
    api.matchesResponse(current, { attemptNonce: ATTEMPT_A }),
    false,
  );
  assert.equal(api.matchesResponse(current, { attemptNonce: ATTEMPT_B }), true);
  assert.equal(controller.check(ATTEMPT_B).ok, true);

  currentUrl = `https://notebook.google.com${NOTEBOOK_A}`;
  assert.equal(controller.check(ATTEMPT_B).ok, false);
});

test("legacy uploads keep an attempt nonce without a destination pathname", () => {
  const api = loadAttemptApi();
  let currentUrl = "https://notebook.google.com/";
  const binding = api.createUploadAttempt(null, () => ATTEMPT_C);
  const controller = api.createController({
    getCurrentUrl: () => currentUrl,
  });

  assert.deepEqual(
    { ...binding },
    {
      attemptNonce: ATTEMPT_C,
      notebookPathname: null,
    },
  );
  assert.ok(controller.arm(binding));
  currentUrl = `https://notebook.google.com${NOTEBOOK_B}`;
  assert.equal(controller.check(ATTEMPT_C).ok, true);
  assert.equal(controller.check(ATTEMPT_A).ok, false);
});

test("installs the correlated terminal listener before arming", () => {
  const functionStart = contentSource.indexOf(
    "async function uploadFilesIntoCurrentNotebook",
  );
  const functionEnd = contentSource.indexOf(
    "async function ensureNotebookDetailPage",
    functionStart,
  );
  const uploadFunction = contentSource.slice(functionStart, functionEnd);
  const listenerIndex = uploadFunction.indexOf(
    "createInjectorResultWaiter(attempt)",
  );
  const armIndex = uploadFunction.indexOf("await armInjector(files, attempt)");

  assert.ok(functionStart >= 0);
  assert.ok(functionEnd > functionStart);
  assert.ok(listenerIndex >= 0);
  assert.ok(armIndex > listenerIndex);
  assert.match(contentSource, /matchesResponse\(attempt, event\.data\)/u);
  assert.match(uploadFunction, /disarmInjector\(attempt\)/u);
});

test("job-bound terminal copy requires restaging and describes only handoff", () => {
  assert.doesNotMatch(contentSource, /Gemini Notebook received the files/u);
  assert.match(
    contentSource,
    /Chrome handed the files to Gemini Notebook's uploader/u,
  );
  assert.match(
    contentSource,
    /else if \(job && error\.code === UPLOAD_TIMEOUT_ERROR_CODE\)/u,
  );
  assert.match(
    contentSource,
    /Restage the sources in Zotero, then start a new import from this notebook or Gemini Notebook home\./u,
  );
  assert.match(popupSource, /handed to Gemini Notebook's uploader/u);
});

test("job-bound content skips synthetic drop and reaches real-input fallback", async () => {
  const calls = [];
  let existingProbeCount = 0;
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const uploadFiles = loadContentFunction(
    "uploadFilesIntoCurrentNotebook",
    "ensureNotebookDetailPage",
    {
      armInjector: async () => calls.push("arm"),
      clickElement: () => assert.fail("click fallback should not be needed"),
      console: { log() {} },
      createInjectorResultWaiter: () => ({
        cancel: () => calls.push("cancel"),
        promise: terminalPromise,
      }),
      delayedExistingInjection: () => {},
      delayedUploadTrigger: () => {},
      dialogUploadStatus: { hide: () => calls.push("hide-status") },
      disarmInjector: () => calls.push("disarm"),
      ensureAddSourcesDialog: async () => {
        calls.push("dialog");
        return {};
      },
      findUploadFileControls: () => [{}],
      hideAssistedUploadPrompt: () => {},
      injectorAttempt: {
        createUploadAttempt: (pathname, randomUUID) => {
          assert.equal(pathname, NOTEBOOK_A);
          assert.equal(randomUUID(), ATTEMPT_A);
          return { attemptNonce: ATTEMPT_A, notebookPathname: NOTEBOOK_A };
        },
      },
      requestDropInjection: async () => {
        calls.push("drop");
        assert.fail("job-bound content must not request synthetic drop");
      },
      requestExistingInjection: async () => {
        existingProbeCount += 1;
        calls.push(`existing-${existingProbeCount}`);
        if (existingProbeCount === 1) return false;
        resolveTerminal();
        return true;
      },
      requestTriggerActivation: async () => {
        calls.push("trigger");
        return true;
      },
      showAssistedUploadPrompt: () => {},
      sleep: async () => {},
      crypto: { randomUUID: () => ATTEMPT_A },
      DELAYED_UPLOAD_TRIGGER_DELAYS_MS: [],
    },
  );

  await uploadFiles([{ base64Data: "AA==" }], {
    createdNewNotebook: false,
    notebookPathname: NOTEBOOK_A,
  });

  assert.equal(existingProbeCount, 2);
  assert.equal(calls.includes("dialog"), true);
  assert.equal(calls.includes("trigger"), true);
  assert.equal(calls.includes("drop"), false);
  assert.equal(calls.includes("cancel"), false);
  assert.equal(calls.includes("disarm"), false);
  const uploadSource = readContentFunctionSource(
    "uploadFilesIntoCurrentNotebook",
    "ensureNotebookDetailPage",
  );
  assert.doesNotMatch(uploadSource, /requestDropInjection\(/u);
});

test("a new-notebook input timeout becomes unverified and requires restaging", async () => {
  const events = [];
  const messages = [];
  const timeoutError = Object.assign(new Error("fixed timeout"), {
    code: "upload-timeout",
  });
  const uploadBatch = loadContentFunction("uploadBatch", "reportJobLifecycle", {
    console: { warn() {} },
    dialogUploadStatus: {
      hide() {},
      setAdding() {},
      showError: (message) => messages.push(message),
    },
    hideAssistedUploadPrompt: () => {},
    isNotebookDetailPage: () => true,
    JOB_LIFECYCLE_REPORT_WARNING: "fixed report warning",
    reportJobLifecycle: async (_job, event) => {
      events.push(event);
      return true;
    },
    uploadDestination: { isDestinationBoundToUrl: () => true },
    uploadFilesIntoCurrentNotebook: async () => {
      throw timeoutError;
    },
    UPLOAD_TIMEOUT_ERROR_CODE: "upload-timeout",
    window: { location: { href: `https://notebook.google.com${NOTEBOOK_A}` } },
  });

  const job = {
    createdNewNotebook: true,
    destination: "new",
    notebookPathname: NOTEBOOK_A,
  };
  await assert.rejects(
    uploadBatch([{}], job),
    (error) => error === timeoutError,
  );
  assert.deepEqual(events, ["unverified"]);
  assert.equal(events.includes("submitted"), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Check its Sources panel/u);
  assert.match(messages[0], /restage the sources in Zotero/u);
  assert.match(messages[0], /return to Gemini Notebook home/u);
  assert.match(messages[0], /start a new import/u);
});

test("synthetic-drop byte dispatch is absent in both execution worlds", () => {
  const uploadSource = readContentFunctionSource(
    "uploadFilesIntoCurrentNotebook",
    "ensureNotebookDetailPage",
  );
  assert.doesNotMatch(uploadSource, /requestDropInjection\(/u);
  for (const removedPath of [
    "doDrop",
    "dispatchDragEvent",
    "findCandidateDropTarget",
    "collectDropTargets",
    "scoreDropTarget",
  ]) {
    assert.equal(injectorSource.includes(removedPath), false);
  }
  assert.match(injectorSource, /Synthetic drop is disabled/u);
});

test("popup rejects a stale v2 content tab even for a null-job import", () => {
  assert.match(popupSource, /if \(!isCompatiblePingResponse\(ping\)\)/u);
  assert.doesNotMatch(
    popupSource,
    /jobId\s*&&\s*ping\?\.lifecycleProtocolVersion/u,
  );
  assert.match(popupSource, /Refresh the tab and try again\./u);
});

test("main-world valid same-path injection is nonce-tagged", () => {
  const harness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_A}`,
  );
  assert.ok(harness.messageListenerCount() > 0);
  harness.arm(ATTEMPT_A, NOTEBOOK_A);
  assert.deepEqual(harness.lastResponse("armed"), {
    attemptNonce: ATTEMPT_A,
    error: undefined,
    status: "armed",
    success: true,
  });

  harness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "same-path",
  });
  assert.equal(harness.input.files.length, 1);
  assert.deepEqual(harness.input.dispatchedTypes, ["input", "change"]);
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_A);
  assert.equal(harness.lastTerminal().success, true);
});

test("main-world navigation after arm clears bytes and prevents click injection", () => {
  const harness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_A}`,
  );
  harness.arm(ATTEMPT_A, NOTEBOOK_A);
  harness.setUrl(`https://notebook.google.com${NOTEBOOK_B}`);
  harness.input.click();

  assert.equal(harness.input.files.length, 0);
  assert.deepEqual(harness.input.dispatchedTypes, []);
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_A);
  assert.equal(harness.lastTerminal().success, false);
  assert.equal(
    harness.lastTerminal().error,
    harness.api.ATTEMPT_MISMATCH_ERROR,
  );
  harness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "after-navigation",
  });
  assert.equal(harness.input.files.length, 0);
  assert.deepEqual(harness.input.dispatchedTypes, []);
});

test("a stale command and stale arm cannot clear the current main-world attempt", () => {
  const harness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_B}`,
  );
  harness.arm(ATTEMPT_B, NOTEBOOK_B);
  harness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "stale-command",
  });
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_A);
  assert.equal(harness.input.files.length, 0);

  harness.arm(ATTEMPT_A, NOTEBOOK_B);
  assert.equal(harness.lastResponse("armed").attemptNonce, ATTEMPT_A);
  assert.equal(harness.lastResponse("armed").success, false);

  harness.command({
    attemptNonce: ATTEMPT_B,
    command: "inject-existing",
    reason: "current-command",
  });
  assert.equal(harness.input.files.length, 1);
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_B);
  assert.equal(harness.lastTerminal().success, true);
});

test("matching disarm clears bytes while a stale disarm does not", () => {
  const staleHarness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_A}`,
  );
  staleHarness.arm(ATTEMPT_A, NOTEBOOK_A);
  staleHarness.command({ attemptNonce: ATTEMPT_B, command: "disarm" });
  staleHarness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "after-stale-disarm",
  });
  assert.equal(staleHarness.input.files.length, 1);

  const matchingHarness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_A}`,
  );
  matchingHarness.arm(ATTEMPT_A, NOTEBOOK_A);
  matchingHarness.command({ attemptNonce: ATTEMPT_A, command: "disarm" });
  assert.equal(matchingHarness.lastResponse("disarmed").success, true);
  matchingHarness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "after-disarm",
  });
  assert.equal(matchingHarness.input.files.length, 0);
  assert.equal(matchingHarness.lastTerminal().success, false);
});

test("main world refuses synthetic drop for a path-bound job attempt", () => {
  const harness = createInjectorHarness(
    `https://notebook.google.com${NOTEBOOK_A}`,
  );
  harness.arm(ATTEMPT_A, NOTEBOOK_A);
  harness.command({
    attemptNonce: ATTEMPT_A,
    command: "drop-files",
    reason: "drop-once",
  });

  assert.deepEqual(harness.dropTarget.dispatchedTypes, []);
  assert.equal(harness.lastResponse("drop-files").attemptNonce, ATTEMPT_A);
  assert.equal(harness.lastRawResponse("drop-files").dispatched, false);
  assert.equal("target" in harness.lastRawResponse("drop-files"), false);
  assert.equal(harness.lastTerminal(), null);

  harness.command({
    attemptNonce: ATTEMPT_A,
    command: "inject-existing",
    reason: "after-refused-drop",
  });
  assert.equal(harness.input.files.length, 1);
  assert.equal(harness.lastTerminal().success, true);
});

test("main world disables synthetic drop for legacy optional-path attempts", () => {
  const harness = createInjectorHarness("https://notebook.google.com/");
  harness.arm(ATTEMPT_C, null);
  harness.command({
    attemptNonce: ATTEMPT_C,
    command: "drop-files",
    reason: "legacy-drop",
  });

  assert.deepEqual(harness.dropTarget.dispatchedTypes, []);
  assert.equal(harness.lastRawResponse("drop-files").dispatched, false);
  assert.equal(harness.lastTerminal(), null);

  harness.command({
    attemptNonce: ATTEMPT_C,
    command: "drop-files",
    reason: "legacy-drop-again",
  });
  assert.deepEqual(harness.dropTarget.dispatchedTypes, []);
  assert.equal(harness.lastRawResponse("drop-files").dispatched, false);
  assert.equal(harness.lastTerminal(), null);

  harness.command({
    attemptNonce: ATTEMPT_C,
    command: "inject-existing",
    reason: "legacy-real-input",
  });
  assert.equal(harness.input.files.length, 1);
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_C);
  assert.equal(harness.lastTerminal().success, true);
});

test("main-world legacy optional-path flow remains nonce-correlated", () => {
  const harness = createInjectorHarness("https://notebook.google.com/");
  harness.arm(ATTEMPT_C, null);
  harness.setUrl(`https://notebook.google.com${NOTEBOOK_B}`);
  harness.command({
    attemptNonce: ATTEMPT_C,
    command: "inject-existing",
    reason: "legacy",
  });

  assert.equal(harness.input.files.length, 1);
  assert.equal(harness.lastTerminal().attemptNonce, ATTEMPT_C);
  assert.equal(harness.lastTerminal().success, true);
});

function createInjectorHarness(initialUrl) {
  class FakeEventTarget {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    }

    dispatchEvent(event) {
      for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent.call(listener, event);
      }
      return true;
    }
  }

  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  }

  class FakeElement extends FakeEventTarget {
    constructor(tagName = "div") {
      super();
      this.attributes = new Map();
      this.classList = { contains: () => false };
      this.className = "";
      this.dispatchedTypes = [];
      this.id = "";
      this.isConnected = true;
      this.parentNode = null;
      this.shadowRoot = null;
      this.tagName = tagName.toUpperCase();
      this.textContent = "";
    }

    closest() {
      return null;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    getClientRects() {
      return [{}];
    }

    dispatchEvent(event) {
      this.dispatchedTypes.push(event.type);
      return super.dispatchEvent(event);
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    matches(selector) {
      return selector === 'input[type="file"]' && this.type === "file";
    }

    querySelector() {
      return null;
    }

    querySelectorAll() {
      return [];
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  class FakeInput extends FakeElement {
    constructor() {
      super("input");
      this.files = [];
      this.nativeClicks = 0;
      this.type = "file";
    }

    click() {
      this.nativeClicks += 1;
    }
  }

  class FakeDataTransfer {
    constructor() {
      this.files = [];
      this.items = { add: (file) => this.files.push(file) };
    }
  }

  class FakeFile {
    constructor(parts, name, options = {}) {
      this.name = name;
      this.parts = parts;
      this.type = options.type ?? "";
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    disconnect() {}
    observe() {}
  }

  const input = new FakeInput();
  const dropTarget = new FakeElement("div");
  dropTarget.setAttribute("xapscottyuploaderdropzone", "");
  const documentElement = new FakeElement("html");
  const document = new FakeEventTarget();
  document.documentElement = documentElement;
  document.querySelector = () => null;
  document.querySelectorAll = (selector) => {
    if (selector === 'input[type="file"]') return [input];
    if (selector === "*") return [input, dropTarget];
    if (selector.includes("xapscottyuploaderdropzone")) return [dropTarget];
    return [];
  };

  const responses = [];
  const window = new FakeEventTarget();
  let context;
  window.location = { href: initialUrl };
  window.document = document;
  window.window = window;
  window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  window.__recordResponse = (data) => responses.push(data);

  let timerId = 0;
  Object.assign(window, {
    DataTransfer: FakeDataTransfer,
    DragEvent: FakeEvent,
    Element: FakeElement,
    Event: FakeEvent,
    EventTarget: FakeEventTarget,
    File: FakeFile,
    HTMLInputElement: FakeInput,
    MouseEvent: FakeEvent,
    MutationObserver: FakeMutationObserver,
    URL,
    Uint8Array,
    atob: globalThis.atob,
    clearInterval: () => {},
    console: { error() {}, log() {}, warn() {} },
    queueMicrotask: (callback) => Promise.resolve().then(callback),
    setInterval: () => ++timerId,
  });

  context = vm.createContext(window);
  vm.runInContext(
    `window.postMessage = function (data) {
      if (data?.type === "__zotero_from_injector") {
        globalThis.__recordResponse(data);
      }
      window.dispatchEvent({ data, source: window, type: "message" });
    };`,
    context,
  );
  vm.runInContext(attemptSource, context);
  vm.runInContext(injectorSource, context);

  function command(fields) {
    context.__commandFields = fields;
    vm.runInContext(
      `window.postMessage({
        type: "__zotero_to_injector",
        ...globalThis.__commandFields,
      }, "*");`,
      context,
    );
    delete context.__commandFields;
  }

  function arm(attemptNonce, notebookPathname) {
    command({
      attemptNonce,
      command: "arm",
      files: [
        {
          base64Data: "AA==",
          contentType: "application/pdf",
          fileName: "source.pdf",
        },
      ],
      notebookPathname,
    });
  }

  function lastResponse(status) {
    const response = [...responses]
      .reverse()
      .find((candidate) => candidate.status === status);
    if (!response) return null;
    return {
      attemptNonce: response.attemptNonce,
      error: response.error,
      status: response.status,
      success: response.success,
    };
  }

  return {
    api: context.ZoteroInjectorAttempt,
    arm,
    command,
    dropTarget,
    input,
    lastResponse,
    lastRawResponse: (status) =>
      [...responses]
        .reverse()
        .find((candidate) => candidate.status === status) ?? null,
    lastTerminal: () =>
      [...responses].reverse().find((candidate) => !candidate.status) ?? null,
    messageListenerCount: () => window.listeners.get("message")?.length ?? 0,
    responses,
    setUrl: (url) => {
      window.location.href = url;
    },
  };
}

function loadContentFunction(name, nextName, context) {
  return vm.runInNewContext(
    `(${readContentFunctionSource(name, nextName)})`,
    context,
  );
}

function readContentFunctionSource(name, nextName) {
  const start = contentSource.indexOf(`async function ${name}`);
  const end = contentSource.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0, `missing content function ${name}`);
  assert.ok(end > start, `missing content function boundary ${nextName}`);
  return contentSource.slice(start, end);
}
