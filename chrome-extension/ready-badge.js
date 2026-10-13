import { isGeminiNotebookUrl } from "./job-lifecycle.js";

const ALARM_NAME = "ready-files-badge";
const STATUS_URL = "http://127.0.0.1:23119/notebooklm/status";
const NOTEBOOK_TABS = {
  url: ["https://notebook.google.com/*", "https://notebooklm.google.com/*"],
};

function badgeText(status) {
  if (
    status?.ready !== true ||
    !Number.isSafeInteger(status.count) ||
    status.count <= 0
  ) {
    return "";
  }
  return status.count > 9 ? "9+" : String(status.count);
}

export function initializeReadyBadge({ chromeApi, fetchImpl }) {
  let revision = 0;
  let pendingRequest;

  async function readBadgeText(controller) {
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(STATUS_URL, {
        method: "GET",
        headers: { "zotero-allowed-request": "1" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected || response.url !== STATUS_URL) {
        return "";
      }
      return badgeText(await response.json());
    } catch {
      return "";
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh() {
    const currentRevision = ++revision;
    pendingRequest?.abort();
    try {
      const tabs = await chromeApi.tabs.query(NOTEBOOK_TABS);
      if (currentRevision !== revision || tabs.length === 0) return;

      const controller = new globalThis.AbortController();
      pendingRequest = controller;
      const text = await readBadgeText(controller);
      if (currentRevision !== revision) return;

      // Recheck after the request: a tab may have navigated or closed meanwhile.
      const currentTabs = await chromeApi.tabs.query(NOTEBOOK_TABS);
      if (currentRevision !== revision) return;
      await Promise.allSettled(
        currentTabs.map((tab) =>
          chromeApi.action.setBadgeText({
            tabId: tab.id,
            text:
              tab.status !== "loading" && isGeminiNotebookUrl(tab.url)
                ? text
                : "",
          }),
        ),
      );
    } catch {
      // Chrome can discard a tab or extension context during a refresh.
    }
  }

  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void refresh();
  });
  chromeApi.tabs.onActivated.addListener(() => void refresh());
  chromeApi.tabs.onRemoved.addListener(() => void refresh());
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url && !changeInfo.status) return;
    // A tab-specific badge survives navigation. Clear it before checking again.
    void chromeApi.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    void refresh();
  });

  async function start() {
    await Promise.allSettled([
      chromeApi.action.setBadgeText({ text: "" }),
      chromeApi.action.setBadgeBackgroundColor({ color: "#2563eb" }),
      (async () => {
        // Recreate missing alarms after a browser restart, without postponing
        // an existing alarm every time the service worker wakes up.
        if (!(await chromeApi.alarms.get(ALARM_NAME))) {
          await chromeApi.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
        }
      })(),
    ]);
    await refresh();
  }

  return { refresh, ready: start() };
}
