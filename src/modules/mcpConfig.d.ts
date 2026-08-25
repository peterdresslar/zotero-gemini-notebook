export type McpClientPreset =
  | "codex"
  | "claude-code"
  | "gemini-cli"
  | "claude-desktop"
  | "custom";

export interface McpClientPresetDefinition {
  readonly id: McpClientPreset;
  readonly label: string;
}

export interface McpSettings {
  readonly enabled: boolean;
  readonly clientPreset: McpClientPreset;
  readonly clientExecutablePath: string;
  readonly runtimePath: string;
  readonly adapterPath: string;
  readonly clientConfigPath: string;
}

export interface McpClientDefaults {
  readonly clientPreset: McpClientPreset;
  readonly clientExecutablePath: string;
  readonly runtimePath: string;
  readonly adapterPath: string;
  readonly clientConfigPath: string;
}

export interface McpPathEnvironment {
  platform: string;
  homeDir?: string;
  appDataDir?: string;
}

export interface McpStdioLaunchSpec {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
}

export const MCP_CLIENT_PRESETS: readonly McpClientPresetDefinition[];
export const DEFAULT_MCP_SETTINGS: McpSettings;
export const MCP_SERVER_NAME: "zotero-gemini-notebook";

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
export function createMcpStdioLaunchSpec(
  input: unknown,
  platform: string,
): McpStdioLaunchSpec;
export function formatMcpStdioCommand(input: unknown, platform: string): string;
