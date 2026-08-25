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
  assert.match(
    dialogModule,
    /function clientPresetChanged[\s\S]*clientExecutablePath\.value = ""[\s\S]*applyClientDefaults/,
  );
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
    /read-only\s+status tool, authenticated staging, and read-only job status/,
  );
  assert.match(
    xhtml,
    /does not create\s+notebooks or upload sources by itself/,
  );
  assert.match(xhtml, /Enable MCP support \(Beta\)/);
  assert.match(dialogModule, /ensureMcpLocalAuthorization\(\)/);
  assert.match(dialogModule, /Persist opt-out first, then opt-in last/);
  assert.match(dialogModule, /readPersistedSettings\(\), settings/);
  assert.match(css, /font: message-box/);
});

test("runs guided Auto-configure only from the explicit confirmed action", () => {
  assert.match(xhtml, /id="mcp-auto-configure-panel"/);
  assert.match(xhtml, /id="mcp-auto-configure"/);
  assert.match(
    xhtml,
    /id="mcp-auto-configure-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/,
  );
  assert.match(xhtml, /uv must already be installed/);
  assert.match(xhtml, /adapter bundled in this XPI/);
  assert.match(xhtml, /only when you press its button/);
  assert.match(xhtml, /adds or replaces\s+only the client registration named/);
  assert.match(xhtml, /zotero-gemini-notebook/);
  assert.match(xhtml, /does not install\s+the MCP client, Python, or uv/);
  assert.match(xhtml, /does not[\s\S]*use a shell/);
  assert.match(xhtml, /uv may download pinned dependencies/);
  assert.match(xhtml, /will not download Python/);
  assert.ok(
    xhtml.indexOf('id="mcp-auto-configure-panel"') <
      xhtml.indexOf('id="mcp-advanced-settings"'),
  );

  assert.match(
    dialogModule,
    /clientPreset === "codex"[\s\S]*clientPreset === "claude-code"[\s\S]*clientPreset === "gemini-cli"/,
  );
  assert.match(dialogModule, /Claude Desktop uses a Desktop Extension install/);
  assert.match(dialogModule, /Custom clients use manual configuration/);
  assert.match(dialogModule, /void requestAutoConfigure\(state\)/);
  assert.match(dialogModule, /await autoConfigureMcpClient\(/);
  assert.match(dialogModule, /state\.win\.confirm\(/);
  assert.match(dialogModule, /replaceExisting: true/);
  assert.match(dialogModule, /add or replace only the MCP server named/);
  assert.match(dialogModule, /enable Zotero's authenticated local MCP access/);
  assert.doesNotMatch(
    dialogModule,
    /autoConfigureMcpClient\(\{[\s\S]{0,300}adapterPath:/,
  );
  assert.match(dialogModule, /persistMcpSettings\(configuredSettings\)/);
  assert.match(dialogModule, /writeSettingsToControls/);
  assert.match(dialogModule, /Restart or reopen/);
  assert.match(
    dialogModule,
    /elements\.autoConfigure\.disabled = busy \|\| !guided/,
  );
  assert.doesNotMatch(
    dialogModule,
    /elements\.autoConfigure\.disabled = [^;]*settings\.enabled/,
  );
  assert.doesNotMatch(
    dialogModule,
    /nsIProcess|Subprocess|execFile|spawn\(|writeUTF8|writeAtomic|openExternal/,
  );
});

test("keeps path hints and the copy-only STDIO fallback under Advanced", () => {
  assert.match(
    xhtml,
    /<html:details id="mcp-advanced-settings"[\s\S]*<html:summary>Advanced<\/html:summary>/,
  );
  const advancedStart = xhtml.indexOf('id="mcp-advanced-settings"');
  for (const id of [
    "mcp-client-executable-path",
    "mcp-runtime-path",
    "mcp-adapter-path",
    "mcp-client-config-path",
    "mcp-client-setup",
  ]) {
    assert.ok(xhtml.indexOf(`id="${id}"`) > advancedStart);
  }
  assert.match(xhtml, /id="mcp-server-name">zotero-gemini-notebook/);
  assert.match(xhtml, /id="mcp-setup-command"[\s\S]*readonly="readonly"/);
  assert.match(xhtml, /Manual STDIO fallback/);
  assert.match(
    xhtml,
    /Manual STDIO fallback only:[\s\S]*Auto-configure always installs\s+and validates the adapter bundled in this XPI/,
  );
  assert.match(xhtml, /Copy STDIO command/);
  assert.match(
    xhtml,
    /does not parse the client\s+configuration file directly/,
  );
  assert.match(dialogModule, /formatMcpStdioCommand\(/);
  assert.match(dialogModule, /@mozilla\.org\/widget\/clipboardhelper;1/);
  assert.match(dialogModule, /copySetupCommand\.addEventListener\("click"/);
  assert.match(dialogModule, /Could not copy automatically/);
  assert.match(dialogModule, /No client configuration has been changed/);
  const setupStart = dialogModule.indexOf("function updateClientSetup");
  const setupEnd = dialogModule.indexOf("function copySetupCommand");
  const setupBody = dialogModule.slice(setupStart, setupEnd);
  assert.doesNotMatch(setupBody, /clientConfigPath/);
});

test("persists the optional client executable hint without launching it", () => {
  assert.match(xhtml, /id="mcp-client-executable-path"/);
  assert.match(xhtml, /id="mcp-client-executable-browse"/);
  assert.match(dialogModule, /getPref\("mcp\.clientExecutablePath"\)/);
  assert.match(dialogModule, /setPref\("mcp\.clientExecutablePath"/);
  assert.match(dialogModule, /clientExecutablePath\.addEventListener\("input"/);
  assert.match(dialogModule, /Select MCP client executable/);
  assert.match(
    dialogModule,
    /async function browseForPath[\s\S]*target\.value = selectedPath;\s*draftChanged\(state\)/,
  );
});

test("clears stale automatic-setup state when switching to a manual client", () => {
  const manualState = dialogModule.slice(
    dialogModule.indexOf('if (settings.clientPreset === "claude-desktop")'),
    dialogModule.indexOf("async function requestAutoConfigure"),
  );
  assert.equal(
    (manualState.match(/setAttribute\("data-status", "idle"\)/g) ?? []).length,
    2,
  );
});

test("prepares setup while Zotero access is off and persists opt-in only after success", () => {
  assert.match(
    xhtml,
    /Auto-configure is a\s+separate explicit action and enables this access after client setup\s+succeeds/,
  );
  assert.match(
    dialogModule,
    /function setSetupControlsEnabled[\s\S]*const busy =[\s\S]*elements\.clientPreset\.disabled = busy/,
  );
  assert.doesNotMatch(dialogModule, /mcp-settings-disabled/);
  assert.doesNotMatch(
    dialogModule,
    /function copySetupCommand[\s\S]{0,200}if \(!settings\.enabled\)/,
  );

  const autoStart = dialogModule.indexOf("async function requestAutoConfigure");
  const autoEnd = dialogModule.indexOf("function isGuidedClient", autoStart);
  const autoBody = dialogModule.slice(autoStart, autoEnd);
  assert.ok(autoBody.indexOf("await autoConfigureMcpClient") > 0);
  assert.ok(
    autoBody.indexOf("persistMcpSettings(configuredSettings)") >
      autoBody.indexOf("await autoConfigureMcpClient"),
  );
  assert.ok(
    autoBody.indexOf("writeSettingsToControls") >
      autoBody.indexOf("persistMcpSettings(configuredSettings)"),
  );
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

test("keeps all client process and filesystem mutation behind reviewed services", () => {
  assert.match(dialogModule, /from "\.\/mcpAutoConfigure"/);
  assert.doesNotMatch(
    dialogModule,
    /Subprocess|nsIProcess|execFile|spawn\(|writeUTF8|writeAtomic|openExternal/,
  );
  assert.doesNotMatch(dialogModule, /mcp get|mcp list|\.codex\/config\.toml/);
  assert.match(
    dialogModule,
    /Automatic setup could not be completed[\s\S]*selected client's MCP registration/,
  );
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
