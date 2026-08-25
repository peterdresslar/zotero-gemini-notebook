import type { ChromeUploadDestination, StatusResponse } from "../types";
import type { BridgeJobSnapshot } from "./bridgeJobStore.js";

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

export function readPendingDestination(
  activeJob: Pick<BridgeJobSnapshot, "destination"> | null | undefined,
): ChromeUploadDestination | null;

export const PRIVATE_RESPONSE_OPTIONS: Readonly<{
  logFilter: (response: string) => string;
}>;
