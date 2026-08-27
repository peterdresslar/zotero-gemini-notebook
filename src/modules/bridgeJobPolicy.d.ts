import type { StagedItem } from "../types";

export const MAX_AGENT_STAGED_SOURCES: 50;
export const MAX_AGENT_CANDIDATE_ITEMS: 256;
export const MAX_AGENT_COLLECTIONS_SCANNED: 1000;
export const MAX_AGENT_SOURCE_BYTES: 200000000;
export const MAX_AGENT_TOTAL_BYTES: 200000000;
export const AGENT_JOB_TTL_MS: 3600000;

export type BridgeJobCreationErrorCode =
  | "INVALID_POLICY_INPUT"
  | "LIBRARY_NOT_FOUND"
  | "COLLECTION_NOT_FOUND"
  | "NO_SUPPORTED_ATTACHMENTS"
  | "SOURCE_LIMIT_EXCEEDED";

export class BridgeJobCreationError extends Error {
  constructor(code: BridgeJobCreationErrorCode, message: string);
  readonly code: BridgeJobCreationErrorCode;
}

export interface SizedStagedItem {
  stagedItem: StagedItem;
  byteSize: number;
}

export interface BoundedStagedItem extends StagedItem {
  maxByteSize: number;
}

export interface AgentBridgeJobLimits {
  maxStagedSources?: number;
  maxSourceBytes?: number;
  maxTotalBytes?: number;
}

export interface PreparedAgentStagedItems {
  readonly stagedItems: readonly BoundedStagedItem[];
  readonly skippedCount: number;
}

export function prepareAgentStagedItems<T>(
  items: T[],
  resolveStagedItem: (item: T) => Promise<SizedStagedItem | null>,
  limits?: AgentBridgeJobLimits,
): Promise<PreparedAgentStagedItems>;

export function getAgentJobExpiresAt(now?: number): number;
