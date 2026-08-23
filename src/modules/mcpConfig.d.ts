export type McpClientPreset =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "custom";

export interface McpClientPresetDefinition {
  readonly id: McpClientPreset;
  readonly label: string;
}

export interface McpSettings {
  readonly enabled: boolean;
  readonly clientPreset: McpClientPreset;
  readonly runtimePath: string;
  readonly adapterPath: string;
  readonly clientConfigPath: string;
}

export interface McpClientDefaults {
  readonly clientPreset: McpClientPreset;
  readonly runtimePath: string;
  readonly adapterPath: string;
  readonly clientConfigPath: string;
}

export interface McpPathEnvironment {
  platform: string;
  homeDir?: string;
  appDataDir?: string;
}

export const MCP_CLIENT_PRESETS: readonly McpClientPresetDefinition[];
export const DEFAULT_MCP_SETTINGS: McpSettings;

export function normalizeMcpClientPreset(value: unknown): McpClientPreset;
export function normalizeMcpSettings(input?: unknown): McpSettings;
export function normalizePersistedMcpSettings(input?: unknown): McpSettings;
export function getMcpClientDefaults(
  preset: unknown,
  environment: McpPathEnvironment,
): McpClientDefaults;
export function applyMcpClientPreset(
  input: unknown,
  preset: unknown,
  environment: McpPathEnvironment,
): McpSettings;
