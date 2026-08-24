import type { StatusResponse } from "../types";

export const ZOTERO_MUTATION_METHOD: "POST";

export interface StatusResponseInput {
  ready: boolean;
  count: number;
  zoteroVersion: string;
  pluginVersion: string;
  mcpOptedIn: unknown;
}

export function createStatusResponse(
  input: StatusResponseInput,
): Readonly<StatusResponse>;

export const PRIVATE_RESPONSE_OPTIONS: Readonly<{
  logFilter: (response: string) => string;
}>;
