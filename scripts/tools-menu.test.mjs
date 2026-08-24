import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTOR_TOOLS_MENU_IDS,
  createConnectorToolsMenu,
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
  const menu = createConnectorToolsMenu(document, {
    connectorLabel: "Gemini Notebook Connector",
    exportLabel: "Export to Gemini Notebook...",
    configureMcpLabel: "Configure MCP...",
    onExport: () => {
      exportCalls += 1;
    },
    onConfigureMcp: () => {
      configureMcpCalls += 1;
    },
  });

  return {
    menu,
    getCallCounts: () => ({ exportCalls, configureMcpCalls }),
  };
}

function assertMenuStructure(menu) {
  const [popup] = menu.children;
  const [exportItem, configureMcpItem] = popup.children;
  const elements = [menu, popup, exportItem, configureMcpItem];

  assert.deepEqual(
    elements.map((element) => element.namespaceURI),
    Array(4).fill(XUL_NAMESPACE),
  );
  assert.deepEqual(
    elements.map((element) => element.localName),
    ["menu", "menupopup", "menuitem", "menuitem"],
  );
  assert.deepEqual(
    elements.map((element) => element.getAttribute("id")),
    [
      CONNECTOR_TOOLS_MENU_IDS.menu,
      CONNECTOR_TOOLS_MENU_IDS.popup,
      CONNECTOR_TOOLS_MENU_IDS.exportItem,
      CONNECTOR_TOOLS_MENU_IDS.configureMcpItem,
    ],
  );
  assert.equal(menu.getAttribute("label"), "Gemini Notebook Connector");
  assert.equal(
    exportItem.getAttribute("label"),
    "Export to Gemini Notebook...",
  );
  assert.equal(configureMcpItem.getAttribute("label"), "Configure MCP...");
  assert.equal(popup.children.length, 2);

  return { exportItem, configureMcpItem };
}

test("builds the connector submenu entirely from XUL elements", () => {
  const { menu, getCallCounts } = buildMenu(createDocumentWithXulFactory());
  const { exportItem, configureMcpItem } = assertMenuStructure(menu);

  assert.deepEqual(getCallCounts(), { exportCalls: 0, configureMcpCalls: 0 });
  exportItem.dispatch("command");
  assert.deepEqual(getCallCounts(), { exportCalls: 1, configureMcpCalls: 0 });
  configureMcpItem.dispatch("command");
  assert.deepEqual(getCallCounts(), { exportCalls: 1, configureMcpCalls: 1 });
});

test("uses the exact XUL namespace when createXULElement is unavailable", () => {
  const { menu } = buildMenu(createDocumentWithNamespaceFallback());
  assertMenuStructure(menu);
});
