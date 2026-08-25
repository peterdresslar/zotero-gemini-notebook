import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMcpClientPreset,
  createMcpStdioLaunchSpec,
  DEFAULT_MCP_SETTINGS,
  formatMcpStdioCommand,
  getMcpClientDefaults,
  MCP_CLIENT_PRESETS,
  MCP_SERVER_NAME,
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
    { id: "gemini-cli", label: "Gemini CLI" },
    {
      id: "claude-desktop",
      label: "Claude Desktop (extension/manual)",
    },
    { id: "custom", label: "Custom (manual)" },
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
    clientExecutablePath: "",
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
  assert.equal(normalizeMcpClientPreset(" GEMINI-CLI "), "gemini-cli");
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
      clientExecutablePath: " /Users/researcher/.local/bin/claude ",
      runtimePath: " /opt/homebrew/bin/node ",
      adapterPath: " /opt/zotero-mcp/adapter.py ",
      clientConfigPath: " /Users/researcher/.claude.json ",
    }),
    {
      enabled: true,
      clientPreset: "claude-code",
      clientExecutablePath: "/Users/researcher/.local/bin/claude",
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
    { clientExecutablePath: [] },
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
    clientExecutablePath: " /Applications/Claude.app ",
    runtimePath: " /usr/local/bin/node ",
    adapterPath: " /opt/zotero-mcp/adapter.py ",
    clientConfigPath: " /tmp/claude.json ",
  });

  assert.deepEqual(recovered, {
    enabled: true,
    clientPreset: "claude-desktop",
    clientExecutablePath: "/Applications/Claude.app",
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
    clientExecutablePath: false,
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
    "clientExecutablePath",
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
      clientExecutablePath: "",
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

test("migrates persisted settings created before client executable hints", () => {
  assert.deepEqual(
    normalizePersistedMcpSettings({
      enabled: true,
      clientPreset: "claude-code",
      runtimePath: "/opt/homebrew/bin/uv",
      adapterPath: "/opt/zotero-mcp/mcp-adapter/server.py",
      clientConfigPath: "/Users/researcher/.claude.json",
    }),
    {
      enabled: true,
      clientPreset: "claude-code",
      clientExecutablePath: "",
      runtimePath: "/opt/homebrew/bin/uv",
      adapterPath: "/opt/zotero-mcp/mcp-adapter/server.py",
      clientConfigPath: "/Users/researcher/.claude.json",
    },
  );
});

test("computes Codex configuration hints from injected home directories", () => {
  assert.deepEqual(getMcpClientDefaults("codex", MAC_ENVIRONMENT), {
    clientPreset: "codex",
    clientExecutablePath: "",
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

test("computes Gemini CLI configuration hints without assuming a binary path", () => {
  assert.deepEqual(getMcpClientDefaults("gemini-cli", MAC_ENVIRONMENT), {
    clientPreset: "gemini-cli",
    clientExecutablePath: "",
    runtimePath: "",
    adapterPath: "",
    clientConfigPath: "/Users/researcher/.gemini/settings.json",
  });
  assert.equal(
    getMcpClientDefaults("gemini-cli", WINDOWS_ENVIRONMENT).clientConfigPath,
    "C:\\Users\\researcher\\.gemini\\settings.json",
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
    clientExecutablePath: "",
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
      clientExecutablePath: " /Users/researcher/.local/bin/codex ",
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
    clientExecutablePath: "/Users/researcher/.local/bin/codex",
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
        clientExecutablePath: " /usr/local/bin/custom-client ",
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
      clientExecutablePath: "/usr/local/bin/custom-client",
      runtimePath: "/usr/bin/node",
      adapterPath: "",
      clientConfigPath: "",
    },
  );
});

test("builds a fixed, non-secret stdio launch specification", () => {
  const settings = {
    enabled: true,
    clientPreset: "codex",
    clientExecutablePath: "/Users/researcher/.local/bin/codex",
    runtimePath: "/opt/homebrew/bin/uv",
    adapterPath: "/Users/researcher/zotero-notebooklm/mcp-adapter/server.py",
    clientConfigPath: "/Users/researcher/.codex/config.toml",
  };

  assert.equal(MCP_SERVER_NAME, "zotero-gemini-notebook");
  assert.deepEqual(createMcpStdioLaunchSpec(settings, "darwin"), {
    serverName: "zotero-gemini-notebook",
    command: "/opt/homebrew/bin/uv",
    args: [
      "--no-config",
      "--no-python-downloads",
      "--no-progress",
      "run",
      "--isolated",
      "--locked",
      "--project",
      "/Users/researcher/zotero-notebooklm/mcp-adapter",
      "python",
      "-E",
      "-s",
      "-B",
      "/Users/researcher/zotero-notebooklm/mcp-adapter/server.py",
    ],
  });
  assert.equal(
    formatMcpStdioCommand(settings, "darwin"),
    "/opt/homebrew/bin/uv --no-config --no-python-downloads --no-progress run --isolated --locked --project /Users/researcher/zotero-notebooklm/mcp-adapter python -E -s -B /Users/researcher/zotero-notebooklm/mcp-adapter/server.py",
  );
  assert.equal(
    JSON.stringify(createMcpStdioLaunchSpec(settings, "darwin")).includes(
      ".codex/config.toml",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(createMcpStdioLaunchSpec(settings, "darwin")).includes(
      ".local/bin/codex",
    ),
    false,
  );
});

test("quotes POSIX setup paths without changing the launch arguments", () => {
  const settings = {
    enabled: false,
    clientPreset: "codex",
    runtimePath: "/Users/researcher's Tools/uv",
    adapterPath: "/Users/researcher's Tools/Zotero MCP/mcp-adapter/server.py",
    clientConfigPath: "",
  };

  assert.equal(
    formatMcpStdioCommand(settings, "darwin"),
    "'/Users/researcher'\"'\"'s Tools/uv' --no-config --no-python-downloads --no-progress run --isolated --locked --project '/Users/researcher'\"'\"'s Tools/Zotero MCP/mcp-adapter' python -E -s -B '/Users/researcher'\"'\"'s Tools/Zotero MCP/mcp-adapter/server.py'",
  );
});

test("formats Windows setup paths using command-line argument quoting", () => {
  const settings = {
    enabled: true,
    clientPreset: "codex",
    runtimePath: "C:\\Program Files\\uv\\uv.exe",
    adapterPath: "C:\\Users\\researcher\\Zotero MCP\\mcp-adapter\\server.py",
    clientConfigPath: "",
  };

  assert.deepEqual(createMcpStdioLaunchSpec(settings, "win32").args, [
    "--no-config",
    "--no-python-downloads",
    "--no-progress",
    "run",
    "--isolated",
    "--locked",
    "--project",
    "C:\\Users\\researcher\\Zotero MCP\\mcp-adapter",
    "python",
    "-E",
    "-s",
    "-B",
    "C:\\Users\\researcher\\Zotero MCP\\mcp-adapter\\server.py",
  ]);
  assert.equal(
    formatMcpStdioCommand(settings, "win32"),
    '"C:\\Program Files\\uv\\uv.exe" --no-config --no-python-downloads --no-progress run --isolated --locked --project "C:\\Users\\researcher\\Zotero MCP\\mcp-adapter" python -E -s -B "C:\\Users\\researcher\\Zotero MCP\\mcp-adapter\\server.py"',
  );
});

test("rejects incomplete, relative, malformed, and unexpected adapter paths", () => {
  const base = {
    enabled: true,
    clientPreset: "codex",
    runtimePath: "/opt/homebrew/bin/uv",
    adapterPath: "/opt/zotero-mcp/mcp-adapter/server.py",
    clientConfigPath: "",
  };

  for (const input of [
    { ...base, runtimePath: "" },
    { ...base, adapterPath: "" },
    { ...base, runtimePath: "uv" },
    { ...base, adapterPath: "mcp-adapter/server.py" },
    { ...base, adapterPath: "/opt/zotero-mcp/mcp-adapter/other.py" },
    { ...base, runtimePath: "/opt/homebrew/bin/uv\n--unsafe" },
    { ...base, adapterPath: "/opt/zotero-mcp/server.py\u0000suffix" },
  ]) {
    assert.throws(() => createMcpStdioLaunchSpec(input, "darwin"), TypeError);
  }

  assert.throws(() => createMcpStdioLaunchSpec(base, ""), TypeError);
  assert.throws(() => createMcpStdioLaunchSpec(base, null), TypeError);
});
