export const XUL_NAMESPACE =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export const CONNECTOR_TOOLS_MENU_IDS = Object.freeze({
  registration: "zotero-notebooklm-tools",
  menu: "zotero-notebooklm-menu-connector",
  popup: "zotero-notebooklm-menu-connector-popup",
  exportItem: "zotero-notebooklm-menu-export",
  configureMcpItem: "zotero-notebooklm-menu-configure-mcp",
});

export function registerConnectorToolsMenuWithManager(
  menuManager,
  {
    pluginID,
    connectorLabel,
    exportLabel,
    configureMcpLabel,
    onExport,
    onConfigureMcp,
  },
) {
  if (
    !menuManager ||
    typeof menuManager.registerMenu !== "function" ||
    typeof menuManager.unregisterMenu !== "function"
  ) {
    return null;
  }

  const registeredMenuID = menuManager.registerMenu({
    menuID: CONNECTOR_TOOLS_MENU_IDS.registration,
    pluginID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "submenu",
        onShowing: (_event, context) => {
          setManagedMenuLabel(context, connectorLabel);
        },
        menus: [
          {
            menuType: "menuitem",
            onShowing: (_event, context) => {
              setManagedMenuLabel(context, exportLabel);
            },
            onCommand: (event, context) => {
              const ownerWindow = getManagedMenuWindow(event, context);
              if (ownerWindow) onExport(ownerWindow);
            },
          },
          {
            menuType: "menuitem",
            onShowing: (_event, context) => {
              setManagedMenuLabel(context, configureMcpLabel);
            },
            onCommand: (event, context) => {
              const ownerWindow = getManagedMenuWindow(event, context);
              if (ownerWindow) onConfigureMcp(ownerWindow);
            },
          },
        ],
      },
    ],
  });

  if (!registeredMenuID) return null;

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    menuManager.unregisterMenu(registeredMenuID);
  };
}

export function createConnectorToolsMenu(
  document,
  { connectorLabel, exportLabel, configureMcpLabel, onExport, onConfigureMcp },
) {
  const connectorMenu = createXulElement(document, "menu");
  setMenuAttributes(
    connectorMenu,
    CONNECTOR_TOOLS_MENU_IDS.menu,
    connectorLabel,
  );

  const connectorPopup = createXulElement(document, "menupopup");
  connectorPopup.setAttribute("id", CONNECTOR_TOOLS_MENU_IDS.popup);

  const exportMenuItem = createXulElement(document, "menuitem");
  setMenuAttributes(
    exportMenuItem,
    CONNECTOR_TOOLS_MENU_IDS.exportItem,
    exportLabel,
  );
  exportMenuItem.addEventListener("command", onExport);

  const configureMcpMenuItem = createXulElement(document, "menuitem");
  setMenuAttributes(
    configureMcpMenuItem,
    CONNECTOR_TOOLS_MENU_IDS.configureMcpItem,
    configureMcpLabel,
  );
  configureMcpMenuItem.addEventListener("command", onConfigureMcp);

  connectorPopup.append(exportMenuItem, configureMcpMenuItem);
  connectorMenu.appendChild(connectorPopup);
  return connectorMenu;
}

function createXulElement(document, tagName) {
  if (typeof document.createXULElement === "function") {
    return document.createXULElement(tagName);
  }
  return document.createElementNS(XUL_NAMESPACE, tagName);
}

function setMenuAttributes(element, id, label) {
  element.setAttribute("id", id);
  element.setAttribute("label", label);
}

function setManagedMenuLabel(context, label) {
  context?.menuElem?.setAttribute("label", label);
}

function getManagedMenuWindow(event, context) {
  return (
    context?.menuElem?.ownerGlobal ??
    context?.menuElem?.ownerDocument?.defaultView ??
    event?.currentTarget?.ownerGlobal ??
    event?.currentTarget?.ownerDocument?.defaultView ??
    event?.target?.ownerGlobal ??
    event?.target?.ownerDocument?.defaultView ??
    null
  );
}
