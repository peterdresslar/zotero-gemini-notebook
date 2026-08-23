import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMcpClientPreset,
  DEFAULT_MCP_SETTINGS,
  getMcpClientDefaults,
  MCP_CLIENT_PRESETS,
  normalizeMcpClientPreset,
  normalizePersistedMcpSettings,
  normalizeMcpSettings,
} from "../src/modules/mcpConfig.js";

const MAC_ENVIRONMENT = Object.freeze({
  platform: "darwin",
  homeDir: "/Users/researcher",
  appDataDir: "",
});

const WINDOWS_ENVIRONMENT = Object.freeze({
  platform: "win32",
  homeDir: "C:\\Users\\researcher",
  appDataDir: "C:\\Users\\researcher\\AppData\\Roaming",
});

test("declares the supported MCP client presets", () => {
  assert.deepEqual(MCP_CLIENT_PRESETS, [
    { id: "codex", label: "Codex" },
    { id: "claude-code", label: "Claude Code" },
    { id: "claude-desktop", label: "Claude Desktop" },
    { id: "custom", label: "Custom" },
  ]);
  assert.equal(Object.isFrozen(MCP_CLIENT_PRESETS), true);
  assert.equal(
    MCP_CLIENT_PRESETS.every((preset) => Object.isFrozen(preset)),
    true,
  );
});

test("defaults MCP support to off without storing locations or secrets", () => {
  assert.deepEqual(DEFAULT_MCP_SETTINGS, {
    enabled: false,
    clientPreset: "codex",
    runtimePath: "",
    adapterPath: "",
    clientConfigPath: "",
  });
  assert.equal(Object.isFrozen(DEFAULT_MCP_SETTINGS), true);
  assert.deepEqual(normalizeMcpSettings(), DEFAULT_MCP_SETTINGS);
});

test("normalizes supported MCP client preset identifiers", () => {
  assert.equal(normalizeMcpClientPreset(" CODEX "), "codex");
  assert.equal(normalizeMcpClientPreset("Claude-Code"), "claude-code");
  assert.equal(normalizeMcpClientPreset("CLAUDE-DESKTOP"), "claude-desktop");
  assert.equal(normalizeMcpClientPreset("custom"), "custom");
});

test("rejects missing, unknown, and non-string MCP client presets", () => {
  for (const value of [undefined, null, "", "claude", 1, {}]) {
    assert.throws(() => normalizeMcpClientPreset(value), TypeError);
  }
});

test("normalizes complete and partial MCP settings", () => {
  assert.deepEqual(
    normalizeMcpSettings({
      enabled: true,
      clientPreset: " CLAUDE-CODE ",
      runtimePath: " /opt/homebrew/bin/node ",
      adapterPath: " /opt/zotero-mcp/adapter.py ",
      clientConfigPath: " /Users/researcher/.claude.json ",
    }),
    {
      enabled: true,
      clientPreset: "claude-code",
      runtimePath: "/opt/homebrew/bin/node",
      adapterPath: "/opt/zotero-mcp/adapter.py",
      clientConfigPath: "/Users/researcher/.claude.json",
    },
  );
  assert.deepEqual(normalizeMcpSettings({ enabled: true }), {
    ...DEFAULT_MCP_SETTINGS,
    enabled: true,
  });
  assert.equal(Object.isFrozen(normalizeMcpSettings({})), true);
});

test("rejects malformed settings and fields outside the non-secret model", () => {
  for (const input of [null, [], "settings", new (class Settings {})()]) {
    assert.throws(() => normalizeMcpSettings(input), TypeError);
  }

  for (const input of [
    { enabled: "yes" },
    { enabled: null },
    { clientPreset: "unknown" },
    { clientPreset: null },
    { runtimePath: 1 },
    { adapterPath: 1 },
    { clientConfigPath: false },
    { token: "secret" },
    { apiKey: "secret" },
    { credential: "secret" },
  ]) {
    assert.throws(() => normalizeMcpSettings(input), TypeError);
  }
});

test("recovers persisted settings independently by field", () => {
  const recovered = normalizePersistedMcpSettings({
    enabled: true,
    clientPreset: " CLAUDE-DESKTOP ",
    runtimePath: " /usr/local/bin/node ",
    adapterPath: " /opt/zotero-mcp/adapter.py ",
    clientConfigPath: " /tmp/claude.json ",
  });

  assert.deepEqual(recovered, {
    enabled: true,
    clientPreset: "claude-desktop",
    runtimePath: "/usr/local/bin/node",
    adapterPath: "/opt/zotero-mcp/adapter.py",
    clientConfigPath: "/tmp/claude.json",
  });
  assert.equal(Object.isFrozen(recovered), true);
});

test("falls back per invalid persisted field and drops unknown data", () => {
  const recovered = normalizePersistedMcpSettings({
    enabled: "true",
    clientPreset: "retired-client",
    runtimePath: 42,
    adapterPath: null,
    clientConfigPath: false,
    token: "must-not-survive",
    nested: { arbitrary: "data" },
  });

  assert.deepEqual(recovered, DEFAULT_MCP_SETTINGS);
  assert.deepEqual(Object.keys(recovered), [
    "enabled",
    "clientPreset",
    "runtimePath",
    "adapterPath",
    "clientConfigPath",
  ]);
});

test("recovers valid persisted fields when neighboring fields are stale", () => {
  assert.deepEqual(
    normalizePersistedMcpSettings({
      enabled: true,
      clientPreset: "no-longer-supported",
      runtimePath: "/usr/bin/node",
      adapterPath: [],
      clientConfigPath: "/home/researcher/.codex/config.toml",
      unknownFutureField: true,
    }),
    {
      enabled: true,
      clientPreset: "codex",
      runtimePath: "/usr/bin/node",
      adapterPath: "",
      clientConfigPath: "/home/researcher/.codex/config.toml",
    },
  );

  for (const input of [undefined, null, [], "settings", 1]) {
    assert.deepEqual(
      normalizePersistedMcpSettings(input),
      DEFAULT_MCP_SETTINGS,
    );
  }
});

test("computes Codex configuration hints from injected home directories", () => {
  assert.deepEqual(getMcpClientDefaults("codex", MAC_ENVIRONMENT), {
    clientPreset: "codex",
    runtimePath: "",
    adapterPath: "",
    clientConfigPath: "/Users/researcher/.codex/config.toml",
  });
  assert.equal(
    getMcpClientDefaults("codex", WINDOWS_ENVIRONMENT).clientConfigPath,
    "C:\\Users\\researcher\\.codex\\config.toml",
  );
  assert.equal(
    getMcpClientDefaults("codex", {
      platform: "linux",
      homeDir: "/home/researcher/",
    }).clientConfigPath,
    "/home/researcher/.codex/config.toml",
  );
});

test("computes Claude Code configuration hints from injected home directories", () => {
  assert.equal(
    getMcpClientDefaults("claude-code", MAC_ENVIRONMENT).clientConfigPath,
    "/Users/researcher/.claude.json",
  );
  assert.equal(
    getMcpClientDefaults("claude-code", WINDOWS_ENVIRONMENT).clientConfigPath,
    "C:\\Users\\researcher\\.claude.json",
  );
  assert.equal(
    getMcpClientDefaults("claude-code", {
      platform: "linux",
      homeDir: "/home/researcher",
    }).clientConfigPath,
    "/home/researcher/.claude.json",
  );
});

test("computes only documented Claude Desktop location hints", () => {
  assert.equal(
    getMcpClientDefaults("claude-desktop", MAC_ENVIRONMENT).clientConfigPath,
    "/Users/researcher/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    getMcpClientDefaults("claude-desktop", WINDOWS_ENVIRONMENT)
      .clientConfigPath,
    "C:\\Users\\researcher\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(
    getMcpClientDefaults("claude-desktop", {
      platform: "linux",
      homeDir: "/home/researcher",
    }).clientConfigPath,
    "",
  );
  assert.equal(
    getMcpClientDefaults("claude-desktop", {
      platform: "freebsd",
      homeDir: "/home/researcher",
    }).clientConfigPath,
    "",
  );
});

test("leaves custom and unavailable client configuration locations blank", () => {
  assert.deepEqual(getMcpClientDefaults("custom", MAC_ENVIRONMENT), {
    clientPreset: "custom",
    runtimePath: "",
    adapterPath: "",
    clientConfigPath: "",
  });
  assert.equal(
    getMcpClientDefaults("codex", {
      platform: "darwin",
      homeDir: "",
    }).clientConfigPath,
    "",
  );
  assert.equal(
    getMcpClientDefaults("claude-desktop", {
      platform: "win32",
      homeDir: "C:\\Users\\researcher",
    }).clientConfigPath,
    "",
  );
});

test("validates only injected path environment values", () => {
  for (const environment of [
    undefined,
    null,
    [],
    {},
    { platform: "" },
    { platform: 1 },
    { platform: "darwin", homeDir: 1 },
    { platform: "win32", appDataDir: false },
  ]) {
    assert.throws(() => getMcpClientDefaults("codex", environment), TypeError);
  }
});

test("applies preset defaults while preserving runtime and adapter overrides", () => {
  const applied = applyMcpClientPreset(
    {
      enabled: true,
      clientPreset: "custom",
      runtimePath: " /opt/homebrew/bin/node ",
      adapterPath: " /opt/zotero-mcp/custom-adapter.py ",
      clientConfigPath: "/tmp/old-config.json",
    },
    "codex",
    MAC_ENVIRONMENT,
  );

  assert.deepEqual(applied, {
    enabled: true,
    clientPreset: "codex",
    runtimePath: "/opt/homebrew/bin/node",
    adapterPath: "/opt/zotero-mcp/custom-adapter.py",
    clientConfigPath: "/Users/researcher/.codex/config.toml",
  });
  assert.equal(Object.isFrozen(applied), true);
});

test("applying custom defaults clears only the client configuration hint", () => {
  assert.deepEqual(
    applyMcpClientPreset(
      {
        enabled: false,
        clientPreset: "codex",
        runtimePath: " /usr/bin/node ",
        adapterPath: "   ",
        clientConfigPath: "/Users/researcher/.codex/config.toml",
      },
      "custom",
      MAC_ENVIRONMENT,
    ),
    {
      enabled: false,
      clientPreset: "custom",
      runtimePath: "/usr/bin/node",
      adapterPath: "",
      clientConfigPath: "",
    },
  );
});
