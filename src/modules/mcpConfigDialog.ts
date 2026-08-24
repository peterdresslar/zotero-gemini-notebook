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
import {
  ensureMcpLocalAuthorization,
  getMcpLocalAuthorizationStatus,
  resetMcpLocalAuthorization,
} from "./mcpLocalAuth";

type LocalAuthorizationStatus = "checking" | "ready" | "missing" | "invalid";

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
      void initDialog(win);
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
  clientPreset: XULMenuListElement;
  runtimePath: HTMLInputElement;
  adapterPath: HTMLInputElement;
  clientConfigPath: HTMLInputElement;
  browseRuntime: HTMLButtonElement;
  browseAdapter: HTMLButtonElement;
  applyDefaults: HTMLButtonElement;
  localRecovery: HTMLElement;
  resetLocalConnection: HTMLButtonElement;
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
  localAuthorizationStatus: LocalAuthorizationStatus;
  showRepairAfterSaveFailure: boolean;
  saveInProgress: boolean;
  resetInProgress: boolean;
}

async function initDialog(win: Window): Promise<void> {
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
      localAuthorizationStatus: "checking",
      showRepairAfterSaveFailure: false,
      saveInProgress: false,
      resetInProgress: false,
    };

    writeSettingsToControls(elements, persistedSettings);
    wireControls(state);
    updateDialogState(state);
    await refreshLocalAuthorizationStatus(state);
  } catch {
    showInitializationFailure(win.document);
  }
}

function getDialogElements(doc: Document): DialogElements {
  return {
    enabled: requireElement<HTMLInputElement>(doc, "mcp-enable-checkbox"),
    clientPreset: requireElement<XULMenuListElement>(doc, "mcp-client-select"),
    runtimePath: requireElement<HTMLInputElement>(doc, "mcp-runtime-path"),
    adapterPath: requireElement<HTMLInputElement>(doc, "mcp-adapter-path"),
    clientConfigPath: requireElement<HTMLInputElement>(
      doc,
      "mcp-client-config-path",
    ),
    browseRuntime: requireElement<HTMLButtonElement>(doc, "mcp-runtime-browse"),
    browseAdapter: requireElement<HTMLButtonElement>(doc, "mcp-adapter-browse"),
    applyDefaults: requireElement<HTMLButtonElement>(doc, "mcp-apply-defaults"),
    localRecovery: requireElement<HTMLElement>(doc, "mcp-local-recovery"),
    resetLocalConnection: requireElement<HTMLButtonElement>(
      doc,
      "mcp-reset-local-connection",
    ),
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

function populateClientPresets(
  doc: Document,
  select: XULMenuListElement,
): void {
  const popup = requireElement<XULMenuPopupElement>(doc, "mcp-client-popup");
  popup.textContent = "";
  for (const preset of MCP_CLIENT_PRESETS) {
    select.appendItem(preset.label, preset.id);
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
  selectClientPreset(elements.clientPreset, settings.clientPreset);
  elements.runtimePath.value = settings.runtimePath;
  elements.adapterPath.value = settings.adapterPath;
  elements.clientConfigPath.value = settings.clientConfigPath;
}

function wireControls(state: DialogState): void {
  const { elements } = state;

  elements.enabled.addEventListener("change", () => updateDialogState(state));
  elements.clientPreset.addEventListener("command", () =>
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
  elements.resetLocalConnection.addEventListener("click", () => {
    void resetLocalConnection(state);
  });
  elements.save.addEventListener("command", () => {
    void saveSettings(state);
  });
  elements.cancel.addEventListener("command", () => state.win.close());
}

function readDraftSettings(elements: DialogElements): McpSettings {
  return normalizeMcpSettings({
    enabled: elements.enabled.checked,
    clientPreset:
      elements.clientPreset.selectedItem?.value ?? elements.clientPreset.value,
    runtimePath: elements.runtimePath.value,
    adapterPath: elements.adapterPath.value,
    clientConfigPath: elements.clientConfigPath.value,
  });
}

function updateDialogState(state: DialogState): void {
  const draft = readDraftSettings(state.elements);
  setSubordinateControlsEnabled(state.elements, draft.enabled);
  const dirty = !settingsEqual(draft, state.persistedSettings);
  updateRecoveryState(state, draft);
  updateStatus(state, draft, dirty);
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
  state: DialogState,
  settings: McpSettings,
  dirty: boolean,
): void {
  const { elements } = state;
  elements.status.classList.toggle("mcp-status-off", !settings.enabled);
  elements.status.classList.toggle("mcp-status-enabled", settings.enabled);
  elements.status.classList.toggle("mcp-status-dirty", dirty);

  if (!settings.enabled) {
    elements.statusTitle.textContent = dirty ? "Preferences not saved" : "Off";
    elements.statusDetail.textContent = dirty
      ? "Save to turn off MCP access."
      : "MCP control access is disabled.";
    return;
  }

  if (state.localAuthorizationStatus === "checking") {
    elements.statusTitle.textContent = "Checking local setup";
    elements.statusDetail.textContent = "Checking Zotero's local MCP setup.";
    return;
  }

  if (localConnectionNeedsRepair(state, settings)) {
    elements.statusTitle.textContent = "Needs repair";
    elements.statusDetail.textContent =
      "Reset the local connection, then save this configuration again.";
    return;
  }

  if (
    state.localAuthorizationStatus === "missing" ||
    state.localAuthorizationStatus === "invalid"
  ) {
    elements.statusTitle.textContent = "Ready to enable";
    elements.statusDetail.textContent =
      "Save to prepare Zotero's local MCP setup automatically.";
    return;
  }

  elements.statusTitle.textContent = dirty ? "Preferences not saved" : "On";
  elements.statusDetail.textContent = dirty
    ? "Save your changed MCP setup preferences."
    : "Zotero's local MCP staging access is enabled. The external stdio adapter and MCP client are configured separately.";
}

function localConnectionNeedsRepair(
  state: DialogState,
  settings: McpSettings,
): boolean {
  if (!settings.enabled) return false;
  const unavailable =
    state.localAuthorizationStatus === "missing" ||
    state.localAuthorizationStatus === "invalid";
  return (
    unavailable &&
    (state.persistedSettings.enabled || state.showRepairAfterSaveFailure)
  );
}

function updateRecoveryState(state: DialogState, settings: McpSettings): void {
  const showRecovery = localConnectionNeedsRepair(state, settings);
  state.elements.localRecovery.hidden = !showRecovery;
  state.elements.resetLocalConnection.disabled =
    !showRecovery || state.saveInProgress || state.resetInProgress;
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

async function saveSettings(state: DialogState): Promise<void> {
  if (state.saveInProgress || state.resetInProgress) return;
  state.saveInProgress = true;
  state.elements.save.setAttribute("disabled", "true");
  state.elements.cancel.setAttribute("disabled", "true");
  updateDialogState(state);

  try {
    const settings = readDraftSettings(state.elements);
    if (settings.enabled) {
      await ensureMcpLocalAuthorization();
      state.localAuthorizationStatus = "ready";
      state.showRepairAfterSaveFailure = false;
      if (!isWindowAlive(state.win)) return;
    }

    // Persist opt-out first so a later preference-write failure cannot leave
    // MCP control active after the user asked to turn it off.
    if (!settings.enabled) setPref("mcp.enabled", false);

    setPref("mcp.clientPreset", settings.clientPreset);
    setPref("mcp.runtimePath", settings.runtimePath);
    setPref("mcp.adapterPath", settings.adapterPath);
    setPref("mcp.clientConfigPath", settings.clientConfigPath);
    // Persist opt-in last so partially written path preferences can never
    // accidentally enable the authenticated control endpoint.
    if (settings.enabled) setPref("mcp.enabled", true);

    if (!settingsEqual(readPersistedSettings(), settings)) {
      throw new Error("MCP preferences were not persisted.");
    }
    state.win.close();
  } catch {
    // Any incomplete save fails closed. Existing local connection state is
    // retained until the user explicitly chooses the recovery action.
    let disabledConfirmed = false;
    try {
      setPref("mcp.enabled", false);
      disabledConfirmed = getPref("mcp.enabled") === false;
      state.persistedSettings = readPersistedSettings();
      state.showRepairAfterSaveFailure = state.elements.enabled.checked;
    } catch {
      // The status message below remains the only user-visible error detail.
    }
    try {
      await refreshLocalAuthorizationStatus(state);
    } catch {
      // Keep the error copy generic and do not expose internal details.
    }
    showTransientStatus(
      state.elements,
      "Could not save configuration",
      disabledConfirmed
        ? "MCP access was disabled because the preferences were not fully saved."
        : "Could not confirm that MCP access was disabled. Reopen Configure MCP and verify the setting.",
    );
  } finally {
    state.saveInProgress = false;
    if (isWindowAlive(state.win)) {
      state.elements.save.removeAttribute("disabled");
      state.elements.cancel.removeAttribute("disabled");
      updateRecoveryState(state, readDraftSettings(state.elements));
    }
  }
}

async function resetLocalConnection(state: DialogState): Promise<void> {
  if (state.saveInProgress || state.resetInProgress) return;
  const settings = readDraftSettings(state.elements);
  if (!localConnectionNeedsRepair(state, settings)) return;

  const confirmed = state.win.confirm(
    "Reset the local MCP connection? You will need to save this configuration again.",
  );
  if (!confirmed) return;

  state.resetInProgress = true;
  state.elements.save.setAttribute("disabled", "true");
  state.elements.cancel.setAttribute("disabled", "true");
  updateDialogState(state);
  showTransientStatus(
    state.elements,
    "Resetting local connection",
    "Preparing a new local connection.",
  );

  let disabledConfirmed = false;
  try {
    // Recovery changes the shared local key. Disable control access first and
    // require an explicit Save before the replacement becomes active.
    setPref("mcp.enabled", false);
    disabledConfirmed = getPref("mcp.enabled") === false;
    if (!disabledConfirmed) {
      throw new Error("MCP access was not disabled before recovery.");
    }
    state.persistedSettings = readPersistedSettings();

    await resetMcpLocalAuthorization();
    await ensureMcpLocalAuthorization();
    if (!isWindowAlive(state.win)) return;

    state.localAuthorizationStatus = "ready";
    state.showRepairAfterSaveFailure = false;
    updateDialogState(state);
  } catch {
    state.showRepairAfterSaveFailure = true;
    try {
      await refreshLocalAuthorizationStatus(state);
    } catch {
      state.localAuthorizationStatus = "invalid";
    }
    if (!isWindowAlive(state.win)) return;
    showTransientStatus(
      state.elements,
      "Could not reset local connection",
      disabledConfirmed
        ? "MCP access remains disabled, and the local setup is still unavailable. Try again or reopen Configure MCP."
        : "Could not confirm that MCP access was disabled. Reopen Configure MCP and verify the setting.",
    );
  } finally {
    state.resetInProgress = false;
    if (isWindowAlive(state.win)) {
      state.elements.save.removeAttribute("disabled");
      state.elements.cancel.removeAttribute("disabled");
      updateRecoveryState(state, readDraftSettings(state.elements));
    }
  }
}

async function refreshLocalAuthorizationStatus(
  state: DialogState,
): Promise<void> {
  const status = await getMcpLocalAuthorizationStatus();
  if (!isWindowAlive(state.win)) return;

  state.localAuthorizationStatus = status.status;
  updateDialogState(state);
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

function selectClientPreset(
  select: XULMenuListElement,
  presetID: string,
): void {
  for (let index = 0; index < select.itemCount; index += 1) {
    const item = select.getItemAtIndex(index);
    if (item.value !== presetID) continue;
    select.selectedItem = item;
    return;
  }
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
