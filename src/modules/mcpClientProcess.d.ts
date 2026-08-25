import type {
  McpAutoConfigClientId,
  McpAutoConfigMode,
  McpAutoConfigRegistrationStatus,
  McpClientAutoConfigLaunchSpec,
  McpClientAutoConfigPlan,
} from "./mcpClientAutoConfig.js";

export type McpClientProcessOutcome =
  | "success"
  | "process-error"
  | "nonzero-exit"
  | "timeout"
  | "output-truncated"
  | "classification-error";

export type McpClientProcessErrorCode =
  | "CLIENT_PROCESS_ERROR"
  | "CLIENT_PROCESS_NONZERO_EXIT"
  | "CLIENT_PROCESS_TIMEOUT"
  | "CLIENT_PROCESS_OUTPUT_TRUNCATED"
  | "CLIENT_PROCESS_CLASSIFICATION_ERROR"
  | null;

export interface McpClientProcessRunnerRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface McpClientProcessRunnerResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface McpClientProcessRunner {
  run(
    request: McpClientProcessRunnerRequest,
  ): Promise<McpClientProcessRunnerResult>;
}

export interface McpClientProcessClassifierInput {
  readonly clientId: McpAutoConfigClientId;
  readonly mode: McpAutoConfigMode;
  readonly serverName: "zotero-gemini-notebook";
  readonly desiredLaunchSpec: McpClientAutoConfigLaunchSpec;
  readonly stdout: string;
  readonly stderr: string;
}

export type McpClientProcessClassifier = (
  input: McpClientProcessClassifierInput,
) =>
  | Readonly<{ status: McpAutoConfigRegistrationStatus }>
  | Promise<Readonly<{ status: McpAutoConfigRegistrationStatus }>>;

export interface McpClientProcessOrchestratorOptions {
  runner: McpClientProcessRunner;
  classifier?: McpClientProcessClassifier | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface McpClientProcessResult {
  readonly outcome: McpClientProcessOutcome;
  readonly errorCode: McpClientProcessErrorCode;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly registrationStatus: McpAutoConfigRegistrationStatus | null;
}

export interface McpClientProcessOrchestrator {
  execute(plan: McpClientAutoConfigPlan): Promise<McpClientProcessResult>;
}

export const MCP_CLIENT_PROCESS_DEFAULT_TIMEOUT_MS: 30000;
export const MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES: 16384;
export const MCP_CLIENT_PROCESS_KILL_GRACE_MS: 300;

export function createMcpClientProcessOrchestrator(
  options: McpClientProcessOrchestratorOptions,
): McpClientProcessOrchestrator;
export function createGeckoMcpClientProcessRunner(): McpClientProcessRunner;
