import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const xhtml = readFileSync(
  new URL("../addon/content/mcp-config-dialog.xhtml", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../addon/content/mcp-config-dialog.css", import.meta.url),
  "utf8",
);
const dialogModule = readFileSync(
  new URL("../src/modules/mcpConfigDialog.ts", import.meta.url),
  "utf8",
);

test("uses Zotero's native XUL picker for MCP client presets", () => {
  assert.doesNotMatch(xhtml, /<html:select\b/);
  assert.match(
    xhtml,
    /<menulist\s+id="mcp-client-select"\s+native="true"\s+aria-labelledby="mcp-client-label"/,
  );
  assert.match(xhtml, /<menupopup id="mcp-client-popup"\s*\/>/);
  assert.match(dialogModule, /clientPreset: XULMenuListElement/);
  assert.match(dialogModule, /clientPreset\.addEventListener\("command"/);
});

test("labels the v0.4.0 MCP setup as a beta foundation", () => {
  assert.match(xhtml, /Beta · v0\.4\.0/);
  assert.match(xhtml, /MCP support enters beta in v0\.4\.0\./);
  assert.match(xhtml, /external adapter is not connected yet/);
  assert.match(xhtml, /Enable MCP setup \(Beta\)/);
  assert.match(css, /font: message-box/);
});
