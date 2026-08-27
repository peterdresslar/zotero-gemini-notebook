export type McpAutoConfigClientId = "codex" | "claude-code" | "gemini-cli";
export type McpAutoConfigMode = "add" | "reset";
export type McpAutoConfigRegistrationStatus =
  | "absent"
  | "exact-match"
  | "conflict";
export type McpAutoConfigResetReason =
  | "managed-exact-match"
  | "missing-receipt"
  | "invalid-receipt"
  | "client-mismatch"
  | "registration-missing"
  | "registration-changed";

export interface McpClientAutoConfigLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export interface McpClientAutoConfigPlanInput {
  clientId: McpAutoConfigClientId;
  clientExecutable: string;
  mode: McpAutoConfigMode;
  launchSpec: McpClientAutoConfigLaunchSpec;
}

export interface McpClientAutoConfigPlan {
  readonly clientId: McpAutoConfigClientId;
  readonly mode: McpAutoConfigMode;
  readonly serverName: "zotero-gemini-notebook";
  readonly executable: string;
  readonly argv: readonly string[];
  readonly launchSpec: McpClientAutoConfigLaunchSpec;
}

export interface McpClientAutoConfigReceipt {
  readonly version: 1;
  readonly clientId: McpAutoConfigClientId;
  readonly serverName: "zotero-gemini-notebook";
  readonly launchSpec: McpClientAutoConfigLaunchSpec;
}

export interface McpClientAutoConfigRegistrationComparison {
  desiredLaunchSpec: McpClientAutoConfigLaunchSpec;
  currentLaunchSpec: McpClientAutoConfigLaunchSpec | null;
}

export interface McpClientAutoConfigRegistrationClassification {
  readonly status: McpAutoConfigRegistrationStatus;
}

export interface McpClientAutoConfigResetInput {
  clientId: McpAutoConfigClientId;
  currentLaunchSpec: McpClientAutoConfigLaunchSpec | null;
  receipt: McpClientAutoConfigReceipt | null;
}

export interface McpClientAutoConfigResetDecision {
  readonly allowed: boolean;
  readonly reason: McpAutoConfigResetReason;
}

export const MCP_AUTO_CONFIG_RECEIPT_VERSION: 1;
export const MCP_AUTO_CONFIG_CLIENT_IDS: readonly McpAutoConfigClientId[];
export const MCP_AUTO_CONFIG_MODES: readonly McpAutoConfigMode[];

export function createMcpClientAutoConfigPlan(
  input: McpClientAutoConfigPlanInput,
): McpClientAutoConfigPlan;
export function normalizeMcpClientAutoConfigLaunchSpec(
  input: unknown,
): McpClientAutoConfigLaunchSpec;
export function classifyMcpClientAutoConfigRegistration(
  input: McpClientAutoConfigRegistrationComparison,
): McpClientAutoConfigRegistrationClassification;
export function createMcpClientAutoConfigReceipt(input: {
  clientId: McpAutoConfigClientId;
  launchSpec: McpClientAutoConfigLaunchSpec;
}): McpClientAutoConfigReceipt;
export function evaluateMcpClientAutoConfigReset(
  input: McpClientAutoConfigResetInput,
): McpClientAutoConfigResetDecision;
