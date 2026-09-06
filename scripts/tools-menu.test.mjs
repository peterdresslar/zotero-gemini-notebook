import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTOR_TOOLS_MENU_IDS,
  createConnectorToolsMenu,
  registerConnectorToolsMenuWithManager,
} from "../src/modules/toolsMenu.js";

const XUL_NAMESPACE =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

class FakeXulElement {
  constructor(localName, namespaceURI) {
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, target: this });
    }
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

function createDocumentWithXulFactory() {
  return {
    createXULElement(localName) {
      return new FakeXulElement(localName, XUL_NAMESPACE);
    },
  };
}

function createDocumentWithNamespaceFallback() {
  return {
    createElementNS(namespaceURI, localName) {
      return new FakeXulElement(localName, namespaceURI);
    },
  };
}

function buildMenu(document) {
  let exportCalls = 0;
  let configureMcpCalls = 0;
  let installChromeExtensionCalls = 0;
  const menu = createConnectorToolsMenu(document, {
    connectorLabel: "Gemini Notebook Connector",
    exportLabel: "Export to Gemini Notebook...",
    configureMcpLabel: "Configure MCP...",
    installChromeExtensionLabel: "Install Chrome Extension",
    onExport: () => {
      exportCalls += 1;
    },
    onConfigureMcp: () => {
      configureMcpCalls += 1;
    },
    onInstallChromeExtension: () => {
      installChromeExtensionCalls += 1;
    },
  });

  return {
    menu,
    getCallCounts: () => ({
      exportCalls,
      configureMcpCalls,
      installChromeExtensionCalls,
    }),
  };
}

function assertMenuStructure(menu) {
  const [popup] = menu.children;
  const [exportItem, configureMcpItem, installChromeExtensionItem] =
    popup.children;
  const elements = [
    menu,
    popup,
    exportItem,
    configureMcpItem,
    installChromeExtensionItem,
  ];

  assert.deepEqual(
    elements.map((element) => element.namespaceURI),
    Array(5).fill(XUL_NAMESPACE),
  );
  assert.deepEqual(
    elements.map((element) => element.localName),
    ["menu", "menupopup", "menuitem", "menuitem", "menuitem"],
  );
  assert.deepEqual(
    elements.map((element) => element.getAttribute("id")),
    [
      CONNECTOR_TOOLS_MENU_IDS.menu,
      CONNECTOR_TOOLS_MENU_IDS.popup,
      CONNECTOR_TOOLS_MENU_IDS.exportItem,
      CONNECTOR_TOOLS_MENU_IDS.configureMcpItem,
      CONNECTOR_TOOLS_MENU_IDS.installChromeExtensionItem,
    ],
  );
  assert.equal(menu.getAttribute("label"), "Gemini Notebook Connector");
  assert.equal(
    exportItem.getAttribute("label"),
    "Export to Gemini Notebook...",
  );
  assert.equal(configureMcpItem.getAttribute("label"), "Configure MCP...");
  assert.equal(
    installChromeExtensionItem.getAttribute("label"),
    "Install Chrome Extension",
  );
  assert.equal(popup.children.length, 3);

  return { exportItem, configureMcpItem, installChromeExtensionItem };
}

test("builds the connector submenu entirely from XUL elements", () => {
  const { menu, getCallCounts } = buildMenu(createDocumentWithXulFactory());
  const { exportItem, configureMcpItem, installChromeExtensionItem } =
    assertMenuStructure(menu);

  assert.deepEqual(getCallCounts(), {
    exportCalls: 0,
    configureMcpCalls: 0,
    installChromeExtensionCalls: 0,
  });
  exportItem.dispatch("command");
  assert.deepEqual(getCallCounts(), {
    exportCalls: 1,
    configureMcpCalls: 0,
    installChromeExtensionCalls: 0,
  });
  configureMcpItem.dispatch("command");
  assert.deepEqual(getCallCounts(), {
    exportCalls: 1,
    configureMcpCalls: 1,
    installChromeExtensionCalls: 0,
  });
  installChromeExtensionItem.dispatch("command");
  assert.deepEqual(getCallCounts(), {
    exportCalls: 1,
    configureMcpCalls: 1,
    installChromeExtensionCalls: 1,
  });
});

test("uses the exact XUL namespace when createXULElement is unavailable", () => {
  const { menu } = buildMenu(createDocumentWithNamespaceFallback());
  assertMenuStructure(menu);
});

test("registers the native Tools submenu through Zotero MenuManager", () => {
  const registeredMenuID = "plugin@example.com-zotero-notebooklm-tools";
  const registrations = [];
  const unregistrations = [];
  const menuManager = {
    registerMenu(options) {
      registrations.push(options);
      return registeredMenuID;
    },
    unregisterMenu(menuID) {
      unregistrations.push(menuID);
      return true;
    },
  };
  const ownerWindow = { name: "main-window" };
  const labels = [];
  const context = {
    menuElem: {
      ownerGlobal: ownerWindow,
      setAttribute(name, value) {
        labels.push([name, value]);
      },
    },
  };
  const exportWindows = [];
  const configureMcpWindows = [];
  let installChromeExtensionCalls = 0;

  const cleanup = registerConnectorToolsMenuWithManager(menuManager, {
    pluginID: "plugin@example.com",
    connectorLabel: "Gemini Notebook Connector",
    exportLabel: "Export to Gemini Notebook...",
    configureMcpLabel: "Configure MCP...",
    installChromeExtensionLabel: "Install Chrome Extension",
    onExport: (win) => exportWindows.push(win),
    onConfigureMcp: (win) => configureMcpWindows.push(win),
    onInstallChromeExtension: () => {
      installChromeExtensionCalls += 1;
    },
  });

  assert.equal(typeof cleanup, "function");
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.equal(registration.menuID, CONNECTOR_TOOLS_MENU_IDS.registration);
  assert.equal(registration.pluginID, "plugin@example.com");
  assert.equal(registration.target, "main/menubar/tools");

  const [submenu] = registration.menus;
  const [exportItem, configureMcpItem, installChromeExtensionItem] =
    submenu.menus;
  assert.equal(submenu.menus.length, 3);
  assert.deepEqual(
    [
      submenu.menuType,
      exportItem.menuType,
      configureMcpItem.menuType,
      installChromeExtensionItem.menuType,
    ],
    ["submenu", "menuitem", "menuitem", "menuitem"],
  );

  submenu.onShowing({}, context);
  exportItem.onShowing({}, context);
  configureMcpItem.onShowing({}, context);
  installChromeExtensionItem.onShowing({}, context);
  assert.deepEqual(labels, [
    ["label", "Gemini Notebook Connector"],
    ["label", "Export to Gemini Notebook..."],
    ["label", "Configure MCP..."],
    ["label", "Install Chrome Extension"],
  ]);

  exportItem.onCommand({}, context);
  configureMcpItem.onCommand({}, context);
  assert.deepEqual(exportWindows, [ownerWindow]);
  assert.deepEqual(configureMcpWindows, [ownerWindow]);
  assert.equal(installChromeExtensionCalls, 0);
  installChromeExtensionItem.onCommand();
  assert.equal(installChromeExtensionCalls, 1);

  cleanup();
  cleanup();
  assert.deepEqual(unregistrations, [registeredMenuID]);
});

test("falls back when Zotero MenuManager is unavailable or rejects registration", () => {
  const options = {
    pluginID: "plugin@example.com",
    connectorLabel: "Gemini Notebook Connector",
    exportLabel: "Export to Gemini Notebook...",
    configureMcpLabel: "Configure MCP...",
    installChromeExtensionLabel: "Install Chrome Extension",
    onExport: () => {},
    onConfigureMcp: () => {},
    onInstallChromeExtension: () => {},
  };

  assert.equal(registerConnectorToolsMenuWithManager(undefined, options), null);
  assert.equal(
    registerConnectorToolsMenuWithManager(
      {
        registerMenu: () => false,
        unregisterMenu: () => true,
      },
      options,
    ),
    null,
  );
});
