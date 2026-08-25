const INPUT_KEYS = new Set([
  "clientExecutablePath",
  "clientId",
  "homeDir",
  "platform",
  "runtimePath",
]);
const DEPENDENCY_KEYS = new Set(["isExecutableFile", "pathSearch"]);
const CLIENT_COMMANDS = Object.freeze({
  codex: "codex",
  "claude-code": "claude",
  "gemini-cli": "gemini",
});
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const MAX_PATH_LENGTH = 4096;

export class McpExecutableDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpExecutableDiscoveryError";
    this.code = code;
  }
}

export async function discoverMcpAutoConfigExecutables(input, dependencies) {
  assertPlainObjectWithExactKeys(
    input,
    INPUT_KEYS,
    "MCP executable discovery input",
  );
  assertPlainObjectWithExactKeys(
    dependencies,
    DEPENDENCY_KEYS,
    "MCP executable discovery dependencies",
  );
  if (
    typeof dependencies.isExecutableFile !== "function" ||
    typeof dependencies.pathSearch !== "function"
  ) {
    throw new TypeError("MCP executable discovery dependencies are invalid.");
  }

  const clientId = normalizeClientId(input.clientId);
  const platform = normalizePlatform(input.platform);
  const homeDir = normalizeAbsolutePath(input.homeDir, "Home directory");
  const clientExecutablePath = await resolveExecutable(
    {
      explicitPath: normalizeOptionalPath(
        input.clientExecutablePath,
        "MCP client executable",
      ),
      command: CLIENT_COMMANDS[clientId],
      homeDir,
      platform,
      errorCode: "MCP_CLIENT_EXECUTABLE_NOT_FOUND",
      errorMessage:
        "The selected MCP client executable could not be found. Choose it under Advanced.",
    },
    dependencies,
  );
  const runtimePath = await resolveExecutable(
    {
      explicitPath: normalizeOptionalPath(input.runtimePath, "uv executable"),
      command: "uv",
      homeDir,
      platform,
      errorCode: "MCP_RUNTIME_EXECUTABLE_NOT_FOUND",
      errorMessage:
        "The uv executable could not be found. Install uv or choose it under Advanced.",
    },
    dependencies,
  );

  return Object.freeze({ clientExecutablePath, runtimePath });
}

async function resolveExecutable(options, dependencies) {
  if (options.explicitPath !== "") {
    if (
      await safeExecutableFile(
        options.explicitPath,
        options.platform,
        dependencies.isExecutableFile,
      )
    ) {
      return options.explicitPath;
    }
    throw discoveryError(options.errorCode, options.errorMessage);
  }

  let searchedPath;
  try {
    searchedPath = await dependencies.pathSearch(options.command);
  } catch {
    searchedPath = null;
  }
  if (
    typeof searchedPath === "string" &&
    searchedPath.length > 0 &&
    isAbsoluteLocalPath(searchedPath) &&
    (await safeExecutableFile(
      searchedPath,
      options.platform,
      dependencies.isExecutableFile,
    ))
  ) {
    return searchedPath;
  }

  for (const candidate of executableCandidates(options)) {
    if (
      await safeExecutableFile(
        candidate,
        options.platform,
        dependencies.isExecutableFile,
      )
    ) {
      return candidate;
    }
  }
  throw discoveryError(options.errorCode, options.errorMessage);
}

function executableCandidates({ command, homeDir, platform }) {
  if (platform === "win32") {
    return Object.freeze([
      joinPath(homeDir, platform, ".local", "bin", `${command}.exe`),
    ]);
  }

  const candidates = [
    joinPath(homeDir, platform, ".local", "bin", command),
    joinPath(homeDir, platform, ".cargo", "bin", command),
  ];
  if (platform === "darwin") {
    candidates.push(`/opt/homebrew/bin/${command}`);
  }
  candidates.push(`/usr/local/bin/${command}`, `/usr/bin/${command}`);
  return Object.freeze(candidates);
}

async function safeExecutableFile(path, platform, isExecutableFile) {
  if (platform === "win32" && !path.toLowerCase().endsWith(".exe")) {
    return false;
  }
  try {
    return (await isExecutableFile(path)) === true;
  } catch {
    return false;
  }
}

function normalizeClientId(value) {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(CLIENT_COMMANDS, value)
  ) {
    throw new TypeError(`Unsupported MCP auto-configuration client: ${value}.`);
  }
  return value;
}

function normalizePlatform(value) {
  if (typeof value !== "string" || !SUPPORTED_PLATFORMS.has(value)) {
    throw new TypeError(`Unsupported MCP executable platform: ${value}.`);
  }
  return value;
}

function normalizeOptionalPath(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }
  const path = value.trim();
  if (path === "") return "";
  return normalizeAbsolutePath(path, field);
}

function normalizeAbsolutePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    hasControlCharacter(value) ||
    !isAbsoluteLocalPath(value)
  ) {
    throw new TypeError(`${field} must be an absolute local path.`);
  }
  return value;
}

function isAbsoluteLocalPath(value) {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  return /^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith("\\\\");
}

function joinPath(base, platform, ...parts) {
  const separator = platform === "win32" ? "\\" : "/";
  return [base.replace(/[\\/]$/u, ""), ...parts].join(separator);
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function discoveryError(code, message) {
  return new McpExecutableDiscoveryError(code, message);
}

function assertPlainObjectWithExactKeys(input, keys, name) {
  if (!isPlainObject(input)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const actualKeys = Object.keys(input);
  if (
    actualKeys.length !== keys.size ||
    actualKeys.some((key) => !keys.has(key))
  ) {
    throw new TypeError(`${name} has invalid fields.`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
