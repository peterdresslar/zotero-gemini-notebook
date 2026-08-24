export const XUL_NAMESPACE =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export const CONNECTOR_TOOLS_MENU_IDS = Object.freeze({
  menu: "zotero-notebooklm-menu-connector",
  popup: "zotero-notebooklm-menu-connector-popup",
  exportItem: "zotero-notebooklm-menu-export",
  configureMcpItem: "zotero-notebooklm-menu-configure-mcp",
});

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
