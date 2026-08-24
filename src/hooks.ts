import { initLocale, getString } from "./utils/locale";
import { getPref } from "./utils/prefs";
import { registerEndpoints } from "./modules/server";
import {
  registerMcpControlEndpoints,
  unregisterMcpControlEndpoints,
} from "./modules/mcpControlServer";
import { openExportDialog } from "./modules/dialog";
import { openMcpConfigDialog } from "./modules/mcpConfigDialog";
import { ensureMcpLocalAuthorization } from "./modules/mcpLocalAuth";
import { resetStaging } from "./modules/staging";
import {
  createConnectorToolsMenu,
  registerConnectorToolsMenuWithManager,
} from "./modules/toolsMenu.js";
import {
  showStagingFailure,
  stageSelectedZoteroItems,
} from "./modules/stagingAction";

const windowUICleanups = new Map<Window, () => void>();
const stagingActionsInProgress = new Set<Window>();
let cleanupManagedToolsMenu: (() => void) | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  cleanupManagedToolsMenu?.();
  try {
    cleanupManagedToolsMenu = registerConnectorToolsMenuWithManager(
      Zotero.MenuManager,
      {
        pluginID: addon.data.config.addonID,
        connectorLabel: getString("menu-connector-label"),
        exportLabel: getString("menuitem-export-label"),
        configureMcpLabel: getString("menuitem-configure-mcp-label"),
        onExport: openExportDialog,
        onConfigureMcp: openMcpConfigDialog,
      },
    );
  } catch {
    cleanupManagedToolsMenu = null;
    Zotero.debug(
      "[NotebookLM] Native Tools menu registration failed; using the per-window fallback",
    );
  }

  // Register browser-facing endpoints for Chrome extension communication.
  registerEndpoints();

  if (getPref("mcp.enabled") === true) {
    try {
      await ensureMcpLocalAuthorization();
    } catch {
      Zotero.debug("[NotebookLM] Local MCP authorization is unavailable");
    }
  }

  // Keep authenticated MCP control endpoints on their separate loopback boundary.
  registerMcpControlEndpoints();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  windowUICleanups.get(win)?.();
  windowUICleanups.delete(win);

  const cleanupToolsMenu = registerToolsMenu(win);
  const cleanupItemContextMenu = registerItemContextMenu(win);
  windowUICleanups.set(win, () => {
    cleanupToolsMenu();
    cleanupItemContextMenu();
  });
}

function registerToolsMenu(win: _ZoteroTypes.MainWindow): () => void {
  // Zotero.MenuManager starts in Zotero 8, while this add-on still supports
  // Zotero 7. Use the supported manager when available and retain the direct
  // per-window XUL path only as the Zotero 7 fallback.
  if (cleanupManagedToolsMenu) return () => {};

  const toolsPopup = win.document.getElementById("menu_ToolsPopup");
  if (!toolsPopup) return () => {};

  const connectorMenu = createConnectorToolsMenu(win.document, {
    connectorLabel: getString("menu-connector-label"),
    exportLabel: getString("menuitem-export-label"),
    configureMcpLabel: getString("menuitem-configure-mcp-label"),
    onExport: () => openExportDialog(win),
    onConfigureMcp: () => openMcpConfigDialog(win),
  });
  toolsPopup.appendChild(connectorMenu);

  return () => connectorMenu.remove();
}

function registerItemContextMenu(win: _ZoteroTypes.MainWindow): () => void {
  // Zotero.MenuManager starts in Zotero 8, while this add-on still supports
  // Zotero 7. Use the same per-window UI pattern as the Tools menu so the
  // shortcut remains available across the declared compatibility range.
  const itemMenu = win.document.getElementById("zotero-itemmenu");
  if (!itemMenu) return () => {};

  const menuItem = ztoolkit.UI.createElement(win.document, "menuitem", {
    tag: "menuitem",
    id: "zotero-notebooklm-menu-export-selected",
    attributes: {
      label: getString("menuitem-export-selected-label"),
      hidden: "true",
    },
    listeners: [
      {
        type: "command",
        listener: () => {
          if (stagingActionsInProgress.has(win)) return;
          const selectedItems = win.ZoteroPane.getSelectedItems();
          stagingActionsInProgress.add(win);
          void stageSelectedZoteroItems(selectedItems)
            .catch(() => {
              Zotero.debug("[NotebookLM] Context-menu staging failed");
              showStagingFailure(
                "Zotero could not stage the selected items. Please try again or use Tools → Export to Gemini Notebook.",
              );
            })
            .finally(() => stagingActionsInProgress.delete(win));
        },
      },
    ],
  });

  const updateVisibility = () => {
    const hasRegularSelection = win.ZoteroPane.getSelectedItems().some((item) =>
      item.isRegularItem(),
    );
    menuItem.hidden = !hasRegularSelection;
    menuItem.disabled = stagingActionsInProgress.has(win);
  };

  itemMenu.addEventListener("popupshowing", updateVisibility);
  itemMenu.appendChild(menuItem);
  return () => {
    itemMenu.removeEventListener("popupshowing", updateVisibility);
    menuItem.remove();
  };
}

async function onMainWindowUnload(win: Window): Promise<void> {
  stagingActionsInProgress.delete(win);
  windowUICleanups.get(win)?.();
  windowUICleanups.delete(win);
}

function onShutdown(): void {
  unregisterMcpControlEndpoints();
  stagingActionsInProgress.clear();
  cleanupManagedToolsMenu?.();
  cleanupManagedToolsMenu = null;
  for (const cleanup of windowUICleanups.values()) cleanup();
  windowUICleanups.clear();
  ztoolkit.unregisterAll();
  resetStaging();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
