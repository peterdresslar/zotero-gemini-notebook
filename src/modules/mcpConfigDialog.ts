import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { isWindowAlive } from "../utils/window";
import {
  MCP_CLIENT_PRESETS,
  applyMcpClientPreset,
  normalizePersistedMcpSettings,
  normalizeMcpSettings,
} from "./mcpConfig.js";
import type { McpPathEnvironment, McpSettings } from "./mcpConfig.js";

let dialogWindow: Window | null = null;

export function openMcpConfigDialog(parentWin: Window): void {
  if (isWindowAlive(dialogWindow ?? undefined)) {
    dialogWindow!.focus();
    return;
  }

  const openedWindow = parentWin.openDialog(
    `chrome://${config.addonRef}/content/mcp-config-dialog.xhtml`,
    "notebooklm-mcp-config",
    "chrome,centerscreen,resizable=yes",
  );
  if (!openedWindow) return;

  dialogWindow = openedWindow;
  const win = openedWindow;
  win.addEventListener(
    "load",
    () => {
      initDialog(win);
    },
    { once: true },
  );
  win.addEventListener(
    "unload",
    () => {
      if (dialogWindow === win) dialogWindow = null;
    },
    { once: true },
  );
}

interface DialogElements {
  enabled: HTMLInputElement;
  clientPreset: HTMLSelectElement;
  runtimePath: HTMLInputElement;
  adapterPath: HTMLInputElement;
  clientConfigPath: HTMLInputElement;
  browseRuntime: HTMLButtonElement;
  browseAdapter: HTMLButtonElement;
  applyDefaults: HTMLButtonElement;
  settingsPanel: HTMLElement;
  status: HTMLElement;
  statusTitle: HTMLElement;
  statusDetail: HTMLElement;
  save: Element;
  cancel: Element;
}

interface DialogState {
  win: Window;
  doc: Document;
  elements: DialogElements;
  persistedSettings: McpSettings;
  environment: McpPathEnvironment;
}

function initDialog(win: Window): void {
  try {
    const doc = win.document;
    const elements = getDialogElements(doc);
    populateClientPresets(doc, elements.clientPreset);

    const persistedSettings = readPersistedSettings();
    const state: DialogState = {
      win,
      doc,
      elements,
      persistedSettings,
      environment: getPathEnvironment(),
    };

    writeSettingsToControls(elements, persistedSettings);
    wireControls(state);
    updateDialogState(state);
  } catch {
    showInitializationFailure(win.document);
  }
}

function getDialogElements(doc: Document): DialogElements {
  return {
    enabled: requireElement<HTMLInputElement>(doc, "mcp-enable-checkbox"),
    clientPreset: requireElement<HTMLSelectElement>(doc, "mcp-client-select"),
    runtimePath: requireElement<HTMLInputElement>(doc, "mcp-runtime-path"),
    adapterPath: requireElement<HTMLInputElement>(doc, "mcp-adapter-path"),
    clientConfigPath: requireElement<HTMLInputElement>(
      doc,
      "mcp-client-config-path",
    ),
    browseRuntime: requireElement<HTMLButtonElement>(doc, "mcp-runtime-browse"),
    browseAdapter: requireElement<HTMLButtonElement>(doc, "mcp-adapter-browse"),
    applyDefaults: requireElement<HTMLButtonElement>(doc, "mcp-apply-defaults"),
    settingsPanel: requireElement<HTMLElement>(doc, "mcp-config-settings"),
    status: requireElement<HTMLElement>(doc, "mcp-config-status"),
    statusTitle: requireElement<HTMLElement>(doc, "mcp-status-title"),
    statusDetail: requireElement<HTMLElement>(doc, "mcp-status-detail"),
    save: requireElement(doc, "mcp-save-btn"),
    cancel: requireElement(doc, "mcp-cancel-btn"),
  };
}

function requireElement<T extends Element = Element>(
  doc: Document,
  id: string,
): T {
  const element = doc.getElementById(id);
  if (!element) throw new Error("The MCP configuration dialog is incomplete.");
  return element as T;
}

function populateClientPresets(doc: Document, select: HTMLSelectElement): void {
  select.textContent = "";
  for (const preset of MCP_CLIENT_PRESETS) {
    const option = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option",
    ) as HTMLOptionElement;
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function readPersistedSettings(): McpSettings {
  return normalizePersistedMcpSettings({
    enabled: getPref("mcp.enabled"),
    clientPreset: getPref("mcp.clientPreset"),
    runtimePath: getPref("mcp.runtimePath"),
    adapterPath: getPref("mcp.adapterPath"),
    clientConfigPath: getPref("mcp.clientConfigPath"),
  });
}

function writeSettingsToControls(
  elements: DialogElements,
  settings: McpSettings,
): void {
  elements.enabled.checked = settings.enabled;
  elements.clientPreset.value = settings.clientPreset;
  elements.runtimePath.value = settings.runtimePath;
  elements.adapterPath.value = settings.adapterPath;
  elements.clientConfigPath.value = settings.clientConfigPath;
}

function wireControls(state: DialogState): void {
  const { elements } = state;

  elements.enabled.addEventListener("change", () => updateDialogState(state));
  elements.clientPreset.addEventListener("change", () =>
    updateDialogState(state),
  );
  elements.runtimePath.addEventListener("input", () =>
    updateDialogState(state),
  );
  elements.adapterPath.addEventListener("input", () =>
    updateDialogState(state),
  );
  elements.clientConfigPath.addEventListener("input", () =>
    updateDialogState(state),
  );
  elements.browseRuntime.addEventListener("click", () => {
    void browseForPath(
      state,
      state.elements.runtimePath,
      "Select MCP runtime executable",
    );
  });
  elements.browseAdapter.addEventListener("click", () => {
    void browseForPath(
      state,
      state.elements.adapterPath,
      "Select MCP adapter entrypoint",
    );
  });
  elements.applyDefaults.addEventListener("click", () => {
    applyClientDefaults(state);
  });
  elements.save.addEventListener("command", () => saveSettings(state));
  elements.cancel.addEventListener("command", () => state.win.close());
}

function readDraftSettings(elements: DialogElements): McpSettings {
  return normalizeMcpSettings({
    enabled: elements.enabled.checked,
    clientPreset: elements.clientPreset.value,
    runtimePath: elements.runtimePath.value,
    adapterPath: elements.adapterPath.value,
    clientConfigPath: elements.clientConfigPath.value,
  });
}

function updateDialogState(state: DialogState): void {
  const draft = readDraftSettings(state.elements);
  setSubordinateControlsEnabled(state.elements, draft.enabled);
  updateStatus(
    state.elements,
    draft,
    !settingsEqual(draft, state.persistedSettings),
  );
}

function setSubordinateControlsEnabled(
  elements: DialogElements,
  enabled: boolean,
): void {
  elements.clientPreset.disabled = !enabled;
  elements.runtimePath.disabled = !enabled;
  elements.adapterPath.disabled = !enabled;
  elements.clientConfigPath.disabled = !enabled;
  elements.browseRuntime.disabled = !enabled;
  elements.browseAdapter.disabled = !enabled;
  elements.applyDefaults.disabled = !enabled;
  elements.settingsPanel.classList.toggle("mcp-settings-disabled", !enabled);
  elements.settingsPanel.setAttribute("aria-disabled", String(!enabled));
}

function updateStatus(
  elements: DialogElements,
  settings: McpSettings,
  dirty: boolean,
): void {
  elements.status.classList.toggle("mcp-status-off", !settings.enabled);
  elements.status.classList.toggle("mcp-status-enabled", settings.enabled);
  elements.status.classList.toggle("mcp-status-dirty", dirty);

  if (!settings.enabled) {
    elements.statusTitle.textContent = "Off";
    elements.statusDetail.textContent = dirty
      ? "MCP support will be disabled after you save."
      : "MCP support is disabled.";
    return;
  }

  elements.statusTitle.textContent = dirty
    ? "Changes not saved"
    : "Preferences saved";
  elements.statusDetail.textContent =
    "The external MCP adapter is not connected yet.";
}

async function browseForPath(
  state: DialogState,
  target: HTMLInputElement,
  title: string,
): Promise<void> {
  try {
    const selectedPath = await new ztoolkit.FilePicker(
      title,
      "open",
      [],
      undefined,
      state.win,
      "all",
    ).open();
    if (!selectedPath) return;

    target.value = selectedPath;
    updateDialogState(state);
  } catch {
    showTransientStatus(
      state.elements,
      "Could not open file browser",
      "No MCP settings were changed.",
    );
  }
}

function applyClientDefaults(state: DialogState): void {
  const draft = readDraftSettings(state.elements);
  const defaults = applyMcpClientPreset(
    draft,
    draft.clientPreset,
    state.environment,
  );

  state.elements.runtimePath.value = defaults.runtimePath;
  state.elements.adapterPath.value = defaults.adapterPath;
  state.elements.clientConfigPath.value = defaults.clientConfigPath;
  updateDialogState(state);
}

function saveSettings(state: DialogState): void {
  try {
    const settings = readDraftSettings(state.elements);
    setPref("mcp.enabled", settings.enabled);
    setPref("mcp.clientPreset", settings.clientPreset);
    setPref("mcp.runtimePath", settings.runtimePath);
    setPref("mcp.adapterPath", settings.adapterPath);
    setPref("mcp.clientConfigPath", settings.clientConfigPath);
    state.win.close();
  } catch {
    showTransientStatus(
      state.elements,
      "Could not save configuration",
      "No credentials, endpoints, commands, or client files were changed.",
    );
  }
}

function showTransientStatus(
  elements: DialogElements,
  title: string,
  detail: string,
): void {
  elements.status.classList.remove("mcp-status-off", "mcp-status-enabled");
  elements.status.classList.add("mcp-status-dirty");
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function showInitializationFailure(doc: Document): void {
  const title = doc.getElementById("mcp-status-title");
  const detail = doc.getElementById("mcp-status-detail");
  if (title) title.textContent = "Configuration unavailable";
  if (detail) {
    detail.textContent =
      "The MCP configuration dialog could not be initialized.";
  }
}

function settingsEqual(a: McpSettings, b: McpSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.clientPreset === b.clientPreset &&
    a.runtimePath === b.runtimePath &&
    a.adapterPath === b.adapterPath &&
    a.clientConfigPath === b.clientConfigPath
  );
}

function getPathEnvironment(): McpPathEnvironment {
  return {
    platform: Zotero.isWin ? "win32" : Zotero.isMac ? "darwin" : "linux",
    homeDir: getDirectoryPath("Home"),
    appDataDir: getDirectoryPath("UAppData"),
  };
}

function getDirectoryPath(key: string): string {
  try {
    return Services.dirsvc.get(key, Ci.nsIFile).path;
  } catch {
    return "";
  }
}
