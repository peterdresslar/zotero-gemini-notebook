import { initLocale, getString } from "./utils/locale";
import { registerEndpoints } from "./modules/server";
import { openExportDialog } from "./modules/dialog";
import { openMcpConfigDialog } from "./modules/mcpConfigDialog";
import { resetStaging } from "./modules/staging";
import { createConnectorToolsMenu } from "./modules/toolsMenu.js";
import {
  showStagingFailure,
  stageSelectedZoteroItems,
} from "./modules/stagingAction";

const windowUICleanups = new Map<Window, () => void>();
const stagingActionsInProgress = new Set<Window>();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register HTTP endpoints for Chrome extension communication
  registerEndpoints();

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
  // Zotero 7. Inject the submenu into each main window and remove it with that
  // window's cleanup callback.
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
  stagingActionsInProgress.clear();
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
