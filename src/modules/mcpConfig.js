const MCP_SETTINGS_KEYS = new Set([
  "enabled",
  "clientPreset",
  "runtimePath",
  "adapterPath",
  "clientConfigPath",
]);

export const MCP_CLIENT_PRESETS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude-code", label: "Claude Code" }),
  Object.freeze({ id: "claude-desktop", label: "Claude Desktop" }),
  Object.freeze({ id: "custom", label: "Custom" }),
]);

const MCP_CLIENT_PRESET_IDS = new Set(
  MCP_CLIENT_PRESETS.map((preset) => preset.id),
);

export const DEFAULT_MCP_SETTINGS = Object.freeze({
  enabled: false,
  clientPreset: "codex",
  runtimePath: "",
  adapterPath: "",
  clientConfigPath: "",
});

export function normalizeMcpClientPreset(value) {
  if (typeof value !== "string") {
    throw new TypeError("MCP client preset must be a string.");
  }

  const preset = value.trim().toLowerCase();
  if (!MCP_CLIENT_PRESET_IDS.has(preset)) {
    throw new TypeError(`Unsupported MCP client preset: ${value}.`);
  }
  return preset;
}

export function normalizeMcpSettings(input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError("MCP settings must be a plain object.");
  }

  for (const key of Object.keys(input)) {
    if (!MCP_SETTINGS_KEYS.has(key)) {
      throw new TypeError(`MCP settings do not accept the field ${key}.`);
    }
  }

  const enabled =
    input.enabled === undefined ? DEFAULT_MCP_SETTINGS.enabled : input.enabled;
  if (typeof enabled !== "boolean") {
    throw new TypeError("MCP enabled must be a boolean.");
  }

  return Object.freeze({
    enabled,
    clientPreset: normalizeMcpClientPreset(
      input.clientPreset === undefined
        ? DEFAULT_MCP_SETTINGS.clientPreset
        : input.clientPreset,
    ),
    runtimePath: normalizePathSetting(input.runtimePath, "MCP runtime path"),
    adapterPath: normalizePathSetting(input.adapterPath, "MCP adapter path"),
    clientConfigPath: normalizePathSetting(
      input.clientConfigPath,
      "MCP client configuration path",
    ),
  });
}

export function normalizePersistedMcpSettings(input) {
  if (!isPlainObject(input)) return DEFAULT_MCP_SETTINGS;

  return Object.freeze({
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : DEFAULT_MCP_SETTINGS.enabled,
    clientPreset: normalizePersistedClientPreset(input.clientPreset),
    runtimePath: normalizePersistedPath(input.runtimePath),
    adapterPath: normalizePersistedPath(input.adapterPath),
    clientConfigPath: normalizePersistedPath(input.clientConfigPath),
  });
}

export function getMcpClientDefaults(presetValue, environment) {
  const clientPreset = normalizeMcpClientPreset(presetValue);
  const { platform, homeDir, appDataDir } =
    normalizePathEnvironment(environment);

  let clientConfigPath = "";
  switch (clientPreset) {
    case "codex":
      clientConfigPath = joinPath(homeDir, platform, ".codex", "config.toml");
      break;
    case "claude-code":
      clientConfigPath = joinPath(homeDir, platform, ".claude.json");
      break;
    case "claude-desktop":
      if (platform === "darwin") {
        clientConfigPath = joinPath(
          homeDir,
          platform,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      } else if (platform === "win32") {
        clientConfigPath = joinPath(
          appDataDir,
          platform,
          "Claude",
          "claude_desktop_config.json",
        );
      }
      break;
    case "custom":
      break;
  }

  return Object.freeze({
    clientPreset,
    runtimePath: "",
    adapterPath: "",
    clientConfigPath,
  });
}

export function applyMcpClientPreset(input, presetValue, environment) {
  const settings = normalizeMcpSettings(input);
  const defaults = getMcpClientDefaults(presetValue, environment);

  return Object.freeze({
    ...settings,
    ...defaults,
    runtimePath: settings.runtimePath || defaults.runtimePath,
    adapterPath: settings.adapterPath || defaults.adapterPath,
  });
}

function normalizePersistedClientPreset(value) {
  if (typeof value !== "string") return DEFAULT_MCP_SETTINGS.clientPreset;

  const preset = value.trim().toLowerCase();
  return MCP_CLIENT_PRESET_IDS.has(preset)
    ? preset
    : DEFAULT_MCP_SETTINGS.clientPreset;
}

function normalizePersistedPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePathSetting(value, field) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }
  return value.trim();
}

function normalizePathEnvironment(environment) {
  if (!isPlainObject(environment)) {
    throw new TypeError("MCP path environment must be a plain object.");
  }
  if (typeof environment.platform !== "string") {
    throw new TypeError("MCP path environment platform must be a string.");
  }

  const platform = environment.platform.trim().toLowerCase();
  if (platform === "") {
    throw new TypeError("MCP path environment platform must not be empty.");
  }

  return {
    platform,
    homeDir: normalizePathSetting(environment.homeDir, "Home directory"),
    appDataDir: normalizePathSetting(
      environment.appDataDir,
      "Application data directory",
    ),
  };
}

function joinPath(base, platform, ...parts) {
  if (!base) return "";

  const separator = platform === "win32" ? "\\" : "/";
  const normalizedBase = base.replace(/[\\/]+$/, "");
  const prefix = normalizedBase || separator;
  return `${prefix}${prefix.endsWith(separator) ? "" : separator}${parts.join(separator)}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
