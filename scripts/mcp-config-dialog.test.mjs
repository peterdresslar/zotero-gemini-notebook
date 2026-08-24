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
  const globalSkinIndex = xhtml.indexOf(
    '<?xml-stylesheet href="chrome://global/skin/" type="text/css"?>',
  );
  const addonSkinIndex = xhtml.indexOf(
    'href="chrome://zoteroNotebookLM/content/notebooklm-dialog.css"',
  );

  assert.ok(globalSkinIndex > 0);
  assert.ok(addonSkinIndex > globalSkinIndex);
  assert.doesNotMatch(xhtml, /<html:select\b/);
  assert.match(
    xhtml,
    /<menulist\s+id="mcp-client-select"\s+native="true"\s+aria-labelledby="mcp-client-label"/,
  );
  assert.match(xhtml, /<menupopup id="mcp-client-popup"\s*\/>/);
  assert.match(dialogModule, /clientPreset: XULMenuListElement/);
  assert.match(dialogModule, /clientPreset\.addEventListener\("command"/);
});

test("places enablement before status in a taller dialog", () => {
  assert.match(xhtml, /height="800"/);
  assert.ok(
    xhtml.indexOf('class="mcp-enable-row"') <
      xhtml.indexOf('id="mcp-config-status"'),
  );
});

test("labels the v0.4.0 MCP staging surface as beta", () => {
  assert.match(xhtml, /Beta · v0\.4\.0/);
  assert.match(xhtml, /MCP support enters beta in v0\.4\.0\./);
  assert.match(xhtml, /standard local stdio\s+adapter/);
  assert.match(
    xhtml,
    /read-only\s+status tool and an authenticated staging tool/,
  );
  assert.match(xhtml, /cannot create notebooks or upload sources on its own/);
  assert.match(xhtml, /Enable MCP support \(Beta\)/);
  assert.match(dialogModule, /ensureMcpLocalAuthorization\(\)/);
  assert.match(dialogModule, /Persist opt-in last/);
  assert.match(dialogModule, /readPersistedSettings\(\), settings/);
  assert.match(css, /font: message-box/);
});

test("keeps local authorization automatic and out of the main UI", () => {
  assert.doesNotMatch(xhtml, /pairing|credential|private key|cryptograph/i);
  assert.doesNotMatch(
    dialogModule,
    /pairing|credential|private key|cryptograph/i,
  );
  assert.doesNotMatch(xhtml, /mcp-pairing-credential-path/);
  assert.doesNotMatch(dialogModule, /Local connection ready/);
  assert.match(dialogModule, /"On"/);
  assert.match(dialogModule, /local MCP staging access is enabled/);
  assert.match(dialogModule, /"Needs repair"/);
  assert.match(dialogModule, /"Ready to enable"/);
});

test("prepares local authorization before opt-in and fails incomplete saves closed", () => {
  const ensureIndex = dialogModule.indexOf("ensureMcpLocalAuthorization()");
  const enableIndex = dialogModule.indexOf('setPref("mcp.enabled", true)');

  assert.ok(ensureIndex > 0);
  assert.ok(enableIndex > ensureIndex);
  assert.match(dialogModule, /catch \{[\s\S]*setPref\("mcp\.enabled", false\)/);
  assert.match(dialogModule, /disabledConfirmed = getPref\("mcp\.enabled"\)/);
  assert.match(dialogModule, /Could not confirm that MCP access was disabled/);
  assert.match(dialogModule, /if \(!isWindowAlive\(state\.win\)\) return/);
});

test("shows a narrow, confirmed recovery action only when repair is needed", () => {
  assert.match(
    xhtml,
    /id="mcp-local-recovery"[\s\S]*hidden="hidden"[\s\S]*id="mcp-reset-local-connection"/,
  );
  assert.match(xhtml, /Reset local connection/);
  assert.match(css, /\.mcp-recovery-row\[hidden\]/);
  assert.match(
    dialogModule,
    /state\.elements\.localRecovery\.hidden = !showRecovery/,
  );
  assert.match(
    dialogModule,
    /state\.persistedSettings\.enabled \|\| state\.showRepairAfterSaveFailure/,
  );
  assert.match(dialogModule, /state\.win\.confirm\(/);
  assert.match(
    dialogModule,
    /await resetMcpLocalAuthorization\(\);\s*await ensureMcpLocalAuthorization\(\);/,
  );
  const resetStart = dialogModule.indexOf(
    "async function resetLocalConnection",
  );
  const resetBody = dialogModule.slice(resetStart);
  assert.ok(
    resetBody.indexOf('setPref("mcp.enabled", false)') <
      resetBody.indexOf("resetMcpLocalAuthorization()"),
  );
  assert.match(resetBody, /disabledConfirmed/);
});
