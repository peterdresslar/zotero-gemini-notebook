import { createMcpStdioLaunchSpec, normalizeMcpSettings } from "./mcpConfig.js";
import type {
  McpPathEnvironment,
  McpSettings,
  McpStdioLaunchSpec,
} from "./mcpConfig.js";
import { createMcpClientAutoConfigPlan } from "./mcpClientAutoConfig.js";
import type {
  McpAutoConfigClientId,
  McpClientAutoConfigPlan,
} from "./mcpClientAutoConfig.js";
import {
  MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES,
  createGeckoMcpClientProcessRunner,
  createMcpClientProcessOrchestrator,
} from "./mcpClientProcess.js";
import type {
  McpClientProcessResult,
  McpClientProcessRunnerRequest,
} from "./mcpClientProcess.js";
import { installBundledMcpAdapter } from "./mcpAdapterInstaller";
import {
  discoverMcpAutoConfigExecutables,
  McpExecutableDiscoveryError,
} from "./mcpExecutableDiscovery.js";
import type { McpDiscoveredExecutables } from "./mcpExecutableDiscovery.js";
import type { McpExecutableDiscoveryInput } from "./mcpExecutableDiscovery.js";
import { ensureMcpLocalAuthorization } from "./mcpLocalAuth";

const SUBPROCESS_MODULE = "resource://gre/modules/Subprocess.sys.mjs";
const ADAPTER_PREFLIGHT_TIMEOUT_MS = 120_000;
const ADAPTER_PREFLIGHT_CODE =
  "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='zgn_preflight')";
const AUTO_CONFIG_INPUT_KEYS = new Set([
  "clientExecutablePath",
  "clientId",
  "homeDir",
  "platform",
  "replaceExisting",
  "runtimePath",
]);

export type McpAutoConfigureErrorCode =
  | "MCP_AUTO_CONFIG_INVALID"
  | "MCP_CLIENT_EXECUTABLE_NOT_FOUND"
  | "MCP_RUNTIME_EXECUTABLE_NOT_FOUND"
  | "MCP_ADAPTER_INSTALL_FAILED"
  | "MCP_ADAPTER_PREFLIGHT_FAILED"
  | "MCP_CLIENT_CHANGE_NOT_CONFIRMED"
  | "MCP_CLIENT_CONFIGURATION_FAILED"
  | "MCP_CLIENT_CONFIGURATION_UNCERTAIN"
  | "MCP_CLIENT_REPLACEMENT_INCOMPLETE"
  | "MCP_LOCAL_AUTHORIZATION_FAILED";

export class McpAutoConfigureError extends Error {
  readonly code: McpAutoConfigureErrorCode;

  constructor(code: McpAutoConfigureErrorCode, message: string) {
    super(message);
    this.name = "McpAutoConfigureError";
    this.code = code;
  }
}

export interface McpAutoConfigureInput {
  clientExecutablePath: string;
  clientId: McpAutoConfigClientId;
  homeDir: string;
  platform: "darwin" | "linux" | "win32";
  replaceExisting: boolean;
  runtimePath: string;
}

export interface McpAutoConfigureDependencies {
  discoverExecutables?(
    input: McpAutoConfigureInput,
  ): Promise<McpDiscoveredExecutables>;
  ensureLocalAuthorization?(): Promise<void>;
  executePlan?(plan: McpClientAutoConfigPlan): Promise<McpClientProcessResult>;
  installAdapter?(): Promise<{
    projectPath: string;
    serverPath: string;
  }>;
  preflightAdapter?(launchSpec: McpStdioLaunchSpec): Promise<void>;
}

export interface McpAutoConfigureResult {
  readonly adapterPath: string;
  readonly clientExecutablePath: string;
  readonly clientId: McpAutoConfigClientId;
  readonly launchSpec: McpStdioLaunchSpec;
  readonly runtimePath: string;
}

export async function autoConfigureMcpClient(
  input: McpAutoConfigureInput,
  dependencies: McpAutoConfigureDependencies = {},
): Promise<McpAutoConfigureResult> {
  const normalized = normalizeInput(input);
  const discover = dependencies.discoverExecutables ?? defaultDiscover;
  const install = dependencies.installAdapter ?? installBundledMcpAdapter;
  const execute = dependencies.executePlan ?? defaultExecutePlan;
  const preflight = dependencies.preflightAdapter ?? defaultPreflightAdapter;
  const ensureAuthorization =
    dependencies.ensureLocalAuthorization ?? ensureMcpLocalAuthorization;

  let executables: McpDiscoveredExecutables;
  try {
    executables = await discover(normalized);
  } catch (error) {
    if (error instanceof McpExecutableDiscoveryError) {
      throw autoConfigureError(error.code, error.message);
    }
    throw autoConfigureError(
      "MCP_CLIENT_CONFIGURATION_FAILED",
      "The MCP client prerequisites could not be checked.",
    );
  }

  let adapterPath: string;
  try {
    adapterPath = (await install()).serverPath;
  } catch {
    throw autoConfigureError(
      "MCP_ADAPTER_INSTALL_FAILED",
      "Zotero could not install or validate its bundled MCP adapter.",
    );
  }

  let launchSpec: McpStdioLaunchSpec;
  try {
    launchSpec = createMcpStdioLaunchSpec(
      {
        enabled: true,
        clientPreset: normalized.clientId,
        clientExecutablePath: executables.clientExecutablePath,
        runtimePath: executables.runtimePath,
        adapterPath,
        clientConfigPath: "",
      },
      normalized.platform,
    );
  } catch {
    throw autoConfigureError(
      "MCP_AUTO_CONFIG_INVALID",
      "The MCP adapter settings are invalid. Review Advanced settings.",
    );
  }

  try {
    await preflight(launchSpec);
  } catch {
    throw autoConfigureError(
      "MCP_ADAPTER_PREFLIGHT_FAILED",
      "The local MCP adapter could not start. Check uv, Python, and network access under Advanced.",
    );
  }

  try {
    await ensureAuthorization();
  } catch {
    throw autoConfigureError(
      "MCP_LOCAL_AUTHORIZATION_FAILED",
      "Zotero could not prepare local MCP access, so the client was not changed.",
    );
  }

  const launchPlanInput = {
    clientId: normalized.clientId,
    clientExecutable: executables.clientExecutablePath,
    launchSpec: {
      command: launchSpec.command,
      args: launchSpec.args,
    },
  } as const;
  const addPlan = createMcpClientAutoConfigPlan({
    ...launchPlanInput,
    mode: "add",
  });
  let result: McpClientProcessResult;

  if (normalized.clientId === "claude-code") {
    // Claude Code's add command refuses an existing same-scope name but does
    // not expose a secret-safe structured duplicate status. The user's fixed-
    // name replacement confirmation authorizes this deterministic reset. An
    // absent-name or failed remove is harmless; the following add can still
    // create the registration without deleting any other entry.
    const resetPlan = createMcpClientAutoConfigPlan({
      ...launchPlanInput,
      mode: "reset",
    });
    await safeExecute(execute, resetPlan);
    result = await safeExecute(execute, addPlan);
    if (result.outcome !== "success") {
      throw autoConfigureError(
        "MCP_CLIENT_REPLACEMENT_INCOMPLETE",
        "Zotero could not confirm a usable replacement for the fixed Claude Code registration; the prior registration may have been removed. Run Auto-configure again or use Advanced setup.",
      );
    }
  } else {
    // Codex and Gemini CLI implement same-name add as a user-scoped upsert.
    result = await safeExecute(execute, addPlan);
  }

  if (result.outcome !== "success") {
    if (isUncertain(result)) throw uncertainClientConfiguration();
    throw autoConfigureError(
      "MCP_CLIENT_CONFIGURATION_FAILED",
      "The selected MCP client did not accept the Zotero registration.",
    );
  }

  return Object.freeze({
    adapterPath,
    clientExecutablePath: executables.clientExecutablePath,
    clientId: normalized.clientId,
    launchSpec,
    runtimePath: executables.runtimePath,
  });
}

function normalizeInput(input: McpAutoConfigureInput): McpAutoConfigureInput {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== AUTO_CONFIG_INPUT_KEYS.size ||
    Object.keys(input).some((key) => !AUTO_CONFIG_INPUT_KEYS.has(key))
  ) {
    throw autoConfigureError(
      "MCP_AUTO_CONFIG_INVALID",
      "The MCP automatic setup request is invalid.",
    );
  }
  if (input.replaceExisting !== true) {
    throw autoConfigureError(
      "MCP_CLIENT_CHANGE_NOT_CONFIRMED",
      "Confirm adding or replacing the Zotero MCP client registration.",
    );
  }
  try {
    const settings = normalizeMcpSettings({
      enabled: true,
      clientPreset: input.clientId,
      clientExecutablePath: input.clientExecutablePath,
      runtimePath: input.runtimePath,
      adapterPath: "",
      clientConfigPath: "",
    });
    if (
      settings.clientPreset === "claude-desktop" ||
      settings.clientPreset === "custom" ||
      typeof input.homeDir !== "string" ||
      !["darwin", "linux", "win32"].includes(input.platform)
    ) {
      throw new Error("Unsupported input");
    }
    return Object.freeze({
      clientExecutablePath: settings.clientExecutablePath,
      clientId: settings.clientPreset,
      homeDir: input.homeDir,
      platform: input.platform,
      replaceExisting: input.replaceExisting,
      runtimePath: settings.runtimePath,
    }) as McpAutoConfigureInput;
  } catch {
    throw autoConfigureError(
      "MCP_AUTO_CONFIG_INVALID",
      "The MCP automatic setup request is invalid.",
    );
  }
}

async function defaultDiscover(
  input: McpAutoConfigureInput,
): Promise<McpDiscoveredExecutables> {
  return discoverMcpAutoConfigExecutables(
    createMcpExecutableDiscoveryInput(input),
    {
      isExecutableFile: async (path) => {
        try {
          const file = await IOUtils.getFile(path);
          return file.isFile() && (Zotero.isWin || file.isExecutable());
        } catch {
          return false;
        }
      },
      pathSearch: async (command) => {
        const chromeUtils = globalThis.ChromeUtils;
        if (!chromeUtils || typeof chromeUtils.importESModule !== "function") {
          throw new Error("Executable search unavailable");
        }
        const imported = chromeUtils.importESModule(SUBPROCESS_MODULE) as {
          Subprocess?: { pathSearch?: (value: string) => Promise<string> };
        };
        if (typeof imported.Subprocess?.pathSearch !== "function") {
          throw new Error("Executable search unavailable");
        }
        return imported.Subprocess.pathSearch(command);
      },
    },
  );
}

export function createMcpExecutableDiscoveryInput(
  input: McpAutoConfigureInput,
): McpExecutableDiscoveryInput {
  return Object.freeze({
    clientExecutablePath: input.clientExecutablePath,
    clientId: input.clientId,
    homeDir: input.homeDir,
    platform: input.platform,
    runtimePath: input.runtimePath,
  });
}

async function defaultExecutePlan(
  plan: McpClientAutoConfigPlan,
): Promise<McpClientProcessResult> {
  return createMcpClientProcessOrchestrator({
    runner: createGeckoMcpClientProcessRunner(),
  }).execute(plan);
}

async function defaultPreflightAdapter(
  launchSpec: McpStdioLaunchSpec,
): Promise<void> {
  const runner = createGeckoMcpClientProcessRunner();
  const result = await runner.run(createMcpAdapterPreflightRequest(launchSpec));
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdoutTruncated === true ||
    result.stderrTruncated === true
  ) {
    throw new Error("Adapter preflight failed.");
  }
}

export function createMcpAdapterPreflightRequest(
  launchSpec: McpStdioLaunchSpec,
): McpClientProcessRunnerRequest {
  const expectedPrefix = [
    "--no-config",
    "--no-python-downloads",
    "--no-progress",
    "run",
    "--isolated",
    "--locked",
    "--project",
  ];
  if (
    launchSpec.args.length !== 13 ||
    !expectedPrefix.every((value, index) => launchSpec.args[index] === value) ||
    launchSpec.args[8] !== "python" ||
    launchSpec.args[9] !== "-E" ||
    launchSpec.args[10] !== "-s" ||
    launchSpec.args[11] !== "-B"
  ) {
    throw new Error("Invalid adapter launch specification.");
  }

  const projectPath = launchSpec.args[7];
  const serverPath = launchSpec.args[12];
  return Object.freeze({
    executable: launchSpec.command,
    argv: Object.freeze([
      ...launchSpec.args.slice(0, 12),
      "-c",
      ADAPTER_PREFLIGHT_CODE,
      projectPath,
      serverPath,
    ]),
    timeoutMs: ADAPTER_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES,
  });
}

async function safeExecute(
  execute: NonNullable<McpAutoConfigureDependencies["executePlan"]>,
  plan: McpClientAutoConfigPlan,
): Promise<McpClientProcessResult> {
  try {
    return await execute(plan);
  } catch {
    return Object.freeze({
      outcome: "process-error",
      errorCode: "CLIENT_PROCESS_ERROR",
      exitCode: null,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      registrationStatus: null,
    });
  }
}

function isUncertain(result: McpClientProcessResult): boolean {
  return (
    result.outcome === "timeout" ||
    result.outcome === "process-error" ||
    result.outcome === "output-truncated" ||
    result.outcome === "classification-error"
  );
}

function uncertainClientConfiguration(): McpAutoConfigureError {
  return autoConfigureError(
    "MCP_CLIENT_CONFIGURATION_UNCERTAIN",
    "The client setup result is uncertain. Reopen the client before trying again.",
  );
}

function autoConfigureError(
  code: McpAutoConfigureErrorCode,
  message: string,
): McpAutoConfigureError {
  return new McpAutoConfigureError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
