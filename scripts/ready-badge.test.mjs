import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { initializeReadyBadge } from "../chrome-extension/ready-badge.js";

const STATUS_URL = "http://127.0.0.1:23119/notebooklm/status";
const ALARM_NAME = "ready-files-badge";
const notebookTab = (id = 1) => ({
  id,
  url: "https://notebook.google.com/notebook/example",
  status: "complete",
});

function response(status, overrides = {}) {
  return {
    ok: true,
    redirected: false,
    url: STATUS_URL,
    json: async () => status,
    ...overrides,
  };
}

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

function harness({ existingAlarm } = {}) {
  const state = {
    tabs: [notebookTab()],
    status: { ready: true, count: 3 },
    badges: new Map(),
    requests: [],
    alarmsCreated: [],
  };
  const chromeApi = {
    action: {
      async setBadgeText({ tabId, text }) {
        state.badges.set(tabId, text);
      },
      async setBadgeBackgroundColor() {},
    },
    tabs: {
      async query(query) {
        assert.deepEqual(query, {
          url: [
            "https://notebook.google.com/*",
            "https://notebooklm.google.com/*",
          ],
        });
        return state.tabs.map((tab) => ({ ...tab }));
      },
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    alarms: {
      onAlarm: event(),
      async get(name) {
        assert.equal(name, ALARM_NAME);
        return existingAlarm;
      },
      async create(name, options) {
        state.alarmsCreated.push({ name, ...options });
      },
    },
  };
  state.fetch = async () => response(state.status);
  const badge = initializeReadyBadge({
    chromeApi,
    async fetchImpl(url, options) {
      state.requests.push({ url, options });
      return state.fetch(url, options);
    },
  });
  return { state, chromeApi, badge };
}

test("badges both notebook hosts using only the local status endpoint", async () => {
  const { state, badge } = harness();
  state.tabs.push({ ...notebookTab(2), url: "https://notebooklm.google.com/" });
  await badge.ready;
  assert.equal(state.badges.get(1), "3");
  assert.equal(state.badges.get(2), "3");
  assert.equal(state.badges.get(undefined), "", "no global badge");
  assert.equal(state.requests.length, 1);
  const { url, options } = state.requests[0];
  assert.equal(url, STATUS_URL);
  assert.deepEqual(options, {
    method: "GET",
    headers: { "zotero-allowed-request": "1" },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: options.signal,
  });
  assert.ok(options.signal instanceof globalThis.AbortSignal);
});

test("shows positive counts capped at 9+ and clears invalid or unready counts", async () => {
  const { state, badge } = harness();
  await badge.ready;
  for (const [count, expected] of [
    [1, "1"],
    [9, "9"],
    [10, "9+"],
    [100, "9+"],
    [0, ""],
    [-1, ""],
    [1.5, ""],
    ["3", ""],
    [null, ""],
    [undefined, ""],
    [Infinity, ""],
  ]) {
    state.status = { ready: true, count };
    await badge.refresh();
    assert.equal(state.badges.get(1), expected);
  }
  for (const status of [
    null,
    {},
    { ready: false, count: 3 },
    { ready: "true", count: 3 },
  ]) {
    state.status = status;
    await badge.refresh();
    assert.equal(state.badges.get(1), "");
  }
});

test("clears an existing badge on HTTP, JSON, redirect, or connection failure", async () => {
  const { state, badge } = harness();
  await badge.ready;
  for (const fetch of [
    async () => response(state.status, { ok: false }),
    async () =>
      response(state.status, {
        json: async () => {
          throw new Error("invalid JSON");
        },
      }),
    async () => response(state.status, { redirected: true }),
    async () => response(state.status, { url: "https://example.com/" }),
    async () => {
      throw new Error("Zotero is closed");
    },
  ]) {
    state.badges.set(1, "3");
    state.fetch = fetch;
    await badge.refresh();
    assert.equal(state.badges.get(1), "");
  }
});

test("aborts a stalled status request and clears the badge", async (t) => {
  const { state, badge } = harness();
  await badge.ready;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const pending = badge.refresh();
  await setImmediate();
  t.mock.timers.tick(5000);
  await pending;
  assert.equal(state.badges.get(1), "");
});

test("does not contact Zotero when no notebook tabs are open", async () => {
  const { state, badge, chromeApi } = harness();
  state.tabs = [];
  await badge.ready;
  chromeApi.alarms.onAlarm.emit({ name: ALARM_NAME });
  await setImmediate();
  assert.equal(state.requests.length, 0);
});

test("creates the polling alarm and refreshes on alarms and tab activation", async () => {
  const { state, badge, chromeApi } = harness();
  await badge.ready;
  assert.deepEqual(state.alarmsCreated, [
    { name: ALARM_NAME, periodInMinutes: 0.5 },
  ]);
  state.status.count = 7;
  chromeApi.alarms.onAlarm.emit({ name: "unrelated" });
  await setImmediate();
  assert.equal(state.requests.length, 1);
  chromeApi.alarms.onAlarm.emit({ name: ALARM_NAME });
  await setImmediate();
  assert.equal(state.badges.get(1), "7");
  state.status.count = 2;
  chromeApi.tabs.onActivated.emit({ tabId: 1 });
  await setImmediate();
  assert.equal(state.badges.get(1), "2");
});

test("worker restart refreshes immediately without postponing an existing alarm", async () => {
  const { state, badge } = harness({ existingAlarm: { name: ALARM_NAME } });
  await badge.ready;
  assert.equal(state.alarmsCreated.length, 0);
  assert.equal(state.badges.get(1), "3");
});

test("navigation clears the badge and a late response cannot restore it", async () => {
  const { state, badge, chromeApi } = harness();
  await badge.ready;
  let finish;
  state.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = badge.refresh();
  await setImmediate();
  state.tabs = [];
  chromeApi.tabs.onUpdated.emit(1, {
    url: "https://example.com/",
    status: "loading",
  });
  assert.equal(state.badges.get(1), "");
  finish(response({ ready: true, count: 9 }));
  await pending;
  assert.equal(state.badges.get(1), "");
});

test("a newer count wins over a late status response", async () => {
  const { state, badge } = harness();
  await badge.ready;
  let finish;
  state.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = badge.refresh();
  await setImmediate();
  state.fetch = async () => response({ ready: false, count: 0 });
  await badge.refresh();
  finish(response({ ready: true, count: 9 }));
  await pending;
  assert.equal(state.badges.get(1), "");
});

test("rechecks tab state after fetching and tolerates a closed tab", async () => {
  const { state, badge, chromeApi } = harness();
  await badge.ready;
  state.fetch = async () => {
    state.tabs = [];
    return response({ ready: true, count: 9 });
  };
  state.badges.delete(1);
  await badge.refresh();
  assert.equal(state.badges.has(1), false);
  chromeApi.tabs.onRemoved.emit(1);
  await setImmediate();
  state.tabs = [notebookTab()];
  state.fetch = async () => response(state.status);
  chromeApi.action.setBadgeText = async () => {
    throw new Error("Tab closed");
  };
  await assert.doesNotReject(badge.refresh());
  chromeApi.tabs.onUpdated.emit(1, { status: "complete" });
  await setImmediate();
});

test("loading or unsupported pages never receive a positive badge", async () => {
  const { state, badge, chromeApi } = harness();
  await badge.ready;
  for (const url of [
    "https://notebook.google.com.example.com/",
    "http://notebook.google.com/",
    "https://notebook.google.com:444/",
    "https://example.com/",
    undefined,
  ]) {
    state.tabs = [{ ...notebookTab(), url }];
    chromeApi.tabs.onUpdated.emit(1, { status: "complete" });
    await setImmediate();
    assert.equal(state.badges.get(1), "");
  }
  state.tabs = [{ ...notebookTab(), status: "loading" }];
  await badge.refresh();
  assert.equal(state.badges.get(1), "");
  state.tabs[0].status = "complete";
  chromeApi.tabs.onUpdated.emit(1, { status: "complete" });
  await setImmediate();
  assert.equal(state.badges.get(1), "3");
});
