import type { McpAutoConfigClientId } from "./mcpClientAutoConfig.js";

export type McpExecutableDiscoveryErrorCode =
  | "MCP_CLIENT_EXECUTABLE_NOT_FOUND"
  | "MCP_RUNTIME_EXECUTABLE_NOT_FOUND";

export class McpExecutableDiscoveryError extends Error {
  readonly code: McpExecutableDiscoveryErrorCode;
  constructor(code: McpExecutableDiscoveryErrorCode, message: string);
}

export interface McpExecutableDiscoveryInput {
  clientId: McpAutoConfigClientId;
  clientExecutablePath: string;
  runtimePath: string;
  homeDir: string;
  platform: "darwin" | "linux" | "win32";
}

export interface McpExecutableDiscoveryDependencies {
  isExecutableFile(path: string): Promise<boolean>;
  pathSearch(command: string): Promise<string>;
}

export interface McpDiscoveredExecutables {
  readonly clientExecutablePath: string;
  readonly runtimePath: string;
}

export function discoverMcpAutoConfigExecutables(
  input: McpExecutableDiscoveryInput,
  dependencies: McpExecutableDiscoveryDependencies,
): Promise<McpDiscoveredExecutables>;
