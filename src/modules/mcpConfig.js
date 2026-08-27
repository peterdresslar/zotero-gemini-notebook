const MCP_SETTINGS_KEYS = new Set([
  "enabled",
  "clientPreset",
  "clientExecutablePath",
  "runtimePath",
  "adapterPath",
  "clientConfigPath",
]);

export const MCP_CLIENT_PRESETS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude-code", label: "Claude Code" }),
  Object.freeze({ id: "gemini-cli", label: "Gemini CLI" }),
  Object.freeze({
    id: "claude-desktop",
    label: "Claude Desktop (extension/manual)",
  }),
  Object.freeze({ id: "custom", label: "Custom (manual)" }),
]);

const MCP_CLIENT_PRESET_IDS = new Set(
  MCP_CLIENT_PRESETS.map((preset) => preset.id),
);

export const DEFAULT_MCP_SETTINGS = Object.freeze({
  enabled: false,
  clientPreset: "codex",
  clientExecutablePath: "",
  runtimePath: "",
  adapterPath: "",
  clientConfigPath: "",
});

export const MCP_SERVER_NAME = "zotero-gemini-notebook";

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
    clientExecutablePath: normalizePathSetting(
      input.clientExecutablePath,
      "MCP client executable path",
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
    clientExecutablePath: normalizePersistedPath(input.clientExecutablePath),
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
    case "gemini-cli":
      clientConfigPath = joinPath(
        homeDir,
        platform,
        ".gemini",
        "settings.json",
      );
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
    clientExecutablePath: "",
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
    clientExecutablePath:
      settings.clientExecutablePath || defaults.clientExecutablePath,
    runtimePath: settings.runtimePath || defaults.runtimePath,
    adapterPath: settings.adapterPath || defaults.adapterPath,
  });
}

export function createMcpStdioLaunchSpec(input, platformValue) {
  const settings = normalizeMcpSettings(input);
  const platform = normalizePlatform(platformValue);

  if (!settings.runtimePath || !settings.adapterPath) {
    throw new TypeError(
      "Absolute paths to the MCP runtime and adapter are required.",
    );
  }

  const runtimePath = normalizeLaunchPath(
    settings.runtimePath,
    platform,
    "MCP runtime path",
  );
  const adapterPath = normalizeLaunchPath(
    settings.adapterPath,
    platform,
    "MCP adapter path",
  );
  if (pathBasename(adapterPath, platform) !== "server.py") {
    throw new TypeError("MCP adapter path must point to server.py.");
  }

  const projectPath = pathDirname(adapterPath, platform);
  return Object.freeze({
    serverName: MCP_SERVER_NAME,
    command: runtimePath,
    args: Object.freeze([
      "--no-config",
      "--no-python-downloads",
      "--no-progress",
      "run",
      "--isolated",
      "--locked",
      "--project",
      projectPath,
      "python",
      "-E",
      "-s",
      "-B",
      adapterPath,
    ]),
  });
}

export function formatMcpStdioCommand(input, platformValue) {
  const platform = normalizePlatform(platformValue);
  const launchSpec = createMcpStdioLaunchSpec(input, platform);
  const quote = platform === "win32" ? quoteWindowsToken : quotePosixToken;
  return [launchSpec.command, ...launchSpec.args].map(quote).join(" ");
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

  const platform = normalizePlatform(environment.platform);

  return {
    platform,
    homeDir: normalizePathSetting(environment.homeDir, "Home directory"),
    appDataDir: normalizePathSetting(
      environment.appDataDir,
      "Application data directory",
    ),
  };
}

function normalizePlatform(value) {
  if (typeof value !== "string") {
    throw new TypeError("MCP platform must be a string.");
  }
  const platform = value.trim().toLowerCase();
  if (platform === "") {
    throw new TypeError("MCP platform must not be empty.");
  }
  return platform;
}

function normalizeLaunchPath(value, platform, field) {
  if (hasControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters.`);
  }

  const absolute =
    platform === "win32" ? /^[a-z]:[\\/]/i.test(value) : value.startsWith("/");
  if (!absolute) {
    throw new TypeError(`${field} must be an absolute path.`);
  }
  return value;
}

function pathBasename(value, platform) {
  const separatorPattern = platform === "win32" ? /[\\/]/ : /\//;
  const parts = value.split(separatorPattern);
  return parts.at(-1) ?? "";
}

function pathDirname(value, platform) {
  const separatorPattern = platform === "win32" ? /[\\/]/ : /\//;
  const parts = value.split(separatorPattern);
  parts.pop();
  const separator = platform === "win32" ? "\\" : "/";
  const directory = parts.join(separator);
  if (platform === "win32") {
    return /^[a-z]:$/i.test(directory) ? `${directory}\\` : directory;
  }
  return directory || "/";
}

function quotePosixToken(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteWindowsToken(value) {
  if (!/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
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
