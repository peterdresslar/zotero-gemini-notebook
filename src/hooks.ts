import { initLocale, getString } from "./utils/locale";
import { registerEndpoints } from "./modules/server";
import { openExportDialog } from "./modules/dialog";
import { resetStaging } from "./modules/staging";
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

  // Register Tools menu item
  const menuItem = ztoolkit.UI.createElement(win.document, "menuitem", {
    tag: "menuitem",
    id: "zotero-notebooklm-menu-export",
    attributes: {
      label: getString("menuitem-export-label"),
    },
    listeners: [
      {
        type: "command",
        listener: () => openExportDialog(win),
      },
    ],
  });
  win.document.getElementById("menu_ToolsPopup")?.appendChild(menuItem);

  const cleanupItemContextMenu = registerItemContextMenu(win);
  windowUICleanups.set(win, () => {
    cleanupItemContextMenu();
    menuItem.remove();
  });
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
