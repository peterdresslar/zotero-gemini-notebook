import { MCP_SERVER_NAME } from "./mcpConfig.js";

const MAX_PATH_LENGTH = 4096;
const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const PLAN_INPUT_KEYS = new Set([
  "clientId",
  "clientExecutable",
  "launchSpec",
  "mode",
]);
const LAUNCH_SPEC_KEYS = new Set(["args", "command"]);
const RECEIPT_INPUT_KEYS = new Set(["clientId", "launchSpec"]);
const RECEIPT_KEYS = new Set([
  "clientId",
  "launchSpec",
  "serverName",
  "version",
]);
const REGISTRATION_INPUT_KEYS = new Set([
  "currentLaunchSpec",
  "desiredLaunchSpec",
]);
const RESET_INPUT_KEYS = new Set(["clientId", "currentLaunchSpec", "receipt"]);

export const MCP_AUTO_CONFIG_RECEIPT_VERSION = 1;
export const MCP_AUTO_CONFIG_CLIENT_IDS = Object.freeze([
  "codex",
  "claude-code",
  "gemini-cli",
]);
export const MCP_AUTO_CONFIG_MODES = Object.freeze(["add", "reset"]);

const CLIENT_IDS = new Set(MCP_AUTO_CONFIG_CLIENT_IDS);
const MODES = new Set(MCP_AUTO_CONFIG_MODES);

export function createMcpClientAutoConfigPlan(input) {
  assertPlainObjectWithKeys(
    input,
    PLAN_INPUT_KEYS,
    "MCP client auto-configuration plan",
  );

  const clientId = normalizeClientId(input.clientId);
  const mode = normalizeMode(input.mode);
  const executable = normalizeAbsolutePath(
    input.clientExecutable,
    "MCP client executable",
  );
  const launchSpec = normalizeMcpClientAutoConfigLaunchSpec(input.launchSpec);
  const argv = createClientArgv(clientId, mode, launchSpec);

  return Object.freeze({
    clientId,
    mode,
    serverName: MCP_SERVER_NAME,
    executable,
    argv: Object.freeze(argv),
    launchSpec,
  });
}

export function normalizeMcpClientAutoConfigLaunchSpec(input) {
  assertPlainObjectWithKeys(
    input,
    LAUNCH_SPEC_KEYS,
    "MCP launch specification",
  );

  const command = normalizeAbsolutePath(input.command, "MCP launch command");
  if (!Array.isArray(input.args)) {
    throw new TypeError("MCP launch arguments must be an array.");
  }
  if (input.args.length > MAX_ARGUMENT_COUNT) {
    throw new TypeError(
      `MCP launch arguments must not exceed ${MAX_ARGUMENT_COUNT} entries.`,
    );
  }

  const args = input.args.map((argument) => normalizeArgument(argument));
  return Object.freeze({ command, args: Object.freeze(args) });
}

export function classifyMcpClientAutoConfigRegistration(input) {
  assertPlainObjectWithKeys(
    input,
    REGISTRATION_INPUT_KEYS,
    "MCP client registration comparison",
  );

  const desiredLaunchSpec = normalizeMcpClientAutoConfigLaunchSpec(
    input.desiredLaunchSpec,
  );
  if (input.currentLaunchSpec === null) {
    return Object.freeze({ status: "absent" });
  }

  const currentLaunchSpec = normalizeMcpClientAutoConfigLaunchSpec(
    input.currentLaunchSpec,
  );
  return Object.freeze({
    status: launchSpecsEqual(desiredLaunchSpec, currentLaunchSpec)
      ? "exact-match"
      : "conflict",
  });
}

export function createMcpClientAutoConfigReceipt(input) {
  assertPlainObjectWithKeys(
    input,
    RECEIPT_INPUT_KEYS,
    "MCP client auto-configuration receipt",
  );

  return Object.freeze({
    version: MCP_AUTO_CONFIG_RECEIPT_VERSION,
    clientId: normalizeClientId(input.clientId),
    serverName: MCP_SERVER_NAME,
    launchSpec: normalizeMcpClientAutoConfigLaunchSpec(input.launchSpec),
  });
}

export function evaluateMcpClientAutoConfigReset(input) {
  assertPlainObjectWithKeys(
    input,
    RESET_INPUT_KEYS,
    "MCP client reset evaluation",
  );

  const clientId = normalizeClientId(input.clientId);
  if (input.receipt === null) {
    return resetDecision(false, "missing-receipt");
  }

  const receipt = readReceipt(input.receipt);
  if (receipt === null) {
    return resetDecision(false, "invalid-receipt");
  }
  if (receipt.clientId !== clientId) {
    return resetDecision(false, "client-mismatch");
  }
  if (input.currentLaunchSpec === null) {
    return resetDecision(false, "registration-missing");
  }

  let currentLaunchSpec;
  try {
    currentLaunchSpec = normalizeMcpClientAutoConfigLaunchSpec(
      input.currentLaunchSpec,
    );
  } catch {
    return resetDecision(false, "registration-changed");
  }

  if (!launchSpecsEqual(receipt.launchSpec, currentLaunchSpec)) {
    return resetDecision(false, "registration-changed");
  }
  return resetDecision(true, "managed-exact-match");
}

function createClientArgv(clientId, mode, launchSpec) {
  if (mode === "reset") {
    switch (clientId) {
      case "codex":
        return ["mcp", "remove", MCP_SERVER_NAME];
      case "claude-code":
        return ["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"];
      case "gemini-cli":
        return ["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"];
    }
  }

  switch (clientId) {
    case "codex":
      return [
        "mcp",
        "add",
        MCP_SERVER_NAME,
        "--",
        launchSpec.command,
        ...launchSpec.args,
      ];
    case "claude-code":
      return [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        MCP_SERVER_NAME,
        "--",
        launchSpec.command,
        ...launchSpec.args,
      ];
    case "gemini-cli":
      return [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        MCP_SERVER_NAME,
        launchSpec.command,
        "--",
        ...launchSpec.args,
      ];
  }
}

function readReceipt(input) {
  try {
    assertPlainObjectWithKeys(
      input,
      RECEIPT_KEYS,
      "MCP client auto-configuration receipt",
    );
    if (
      input.version !== MCP_AUTO_CONFIG_RECEIPT_VERSION ||
      input.serverName !== MCP_SERVER_NAME
    ) {
      return null;
    }
    return Object.freeze({
      version: MCP_AUTO_CONFIG_RECEIPT_VERSION,
      clientId: normalizeClientId(input.clientId),
      serverName: MCP_SERVER_NAME,
      launchSpec: normalizeMcpClientAutoConfigLaunchSpec(input.launchSpec),
    });
  } catch {
    return null;
  }
}

function launchSpecsEqual(left, right) {
  if (
    left.command !== right.command ||
    left.args.length !== right.args.length
  ) {
    return false;
  }
  return left.args.every((argument, index) => argument === right.args[index]);
}

function resetDecision(allowed, reason) {
  return Object.freeze({ allowed, reason });
}

function normalizeClientId(value) {
  if (typeof value !== "string" || !CLIENT_IDS.has(value)) {
    throw new TypeError(`Unsupported MCP auto-configuration client: ${value}.`);
  }
  return value;
}

function normalizeMode(value) {
  if (typeof value !== "string" || !MODES.has(value)) {
    throw new TypeError(`Unsupported MCP auto-configuration mode: ${value}.`);
  }
  return value;
}

function normalizeAbsolutePath(value, field) {
  const path = normalizeBoundedString(value, field, MAX_PATH_LENGTH);
  if (!isAbsoluteLocalPath(path)) {
    throw new TypeError(`${field} must be an absolute local path.`);
  }
  return path;
}

function normalizeArgument(value) {
  return normalizeBoundedString(
    value,
    "MCP launch argument",
    MAX_ARGUMENT_LENGTH,
  );
}

function normalizeBoundedString(value, field, maxLength) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new TypeError(`${field} must not exceed ${maxLength} characters.`);
  }
  if (hasControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters.`);
  }
  return value;
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAbsoluteLocalPath(value) {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  return false;
}

function assertPlainObjectWithKeys(input, allowedKeys, name) {
  if (!isPlainObject(input)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${name} does not accept the field ${key}.`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw new TypeError(`${name} requires the field ${key}.`);
    }
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
