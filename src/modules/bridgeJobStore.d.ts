import type { BridgeJobState, StagedItem } from "../types";

export type { BridgeJobState } from "../types";

export type BridgeJobJson =
  | null
  | boolean
  | number
  | string
  | BridgeJobJson[]
  | { [key: string]: BridgeJobJson };

export interface BridgeJobActivation {
  items: StagedItem[];
  origin: string;
  source: BridgeJobJson;
  destination: BridgeJobJson;
  skippedCount: number;
  requestId?: string;
  replaceExisting?: boolean;
  expiresAt?: number | null;
}

export interface BridgeJobRequestIdentity {
  origin: string;
  source: BridgeJobJson;
  destination: BridgeJobJson;
}

export interface BridgeJobSnapshot {
  jobId: string;
  state: BridgeJobState;
  origin: string;
  source: BridgeJobJson;
  destination: BridgeJobJson;
  itemCount: number;
  skippedCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  details?: BridgeJobJson;
}

export interface BridgeJobStoreOptions {
  now?: () => number;
  createId?: () => string;
  maxHistory?: number;
  claimedTtlMs?: number;
}

export type BridgeJobStoreErrorCode =
  | "INVALID_INPUT"
  | "PENDING_JOB_EXISTS"
  | "IDEMPOTENCY_CONFLICT"
  | "SECURE_RANDOM_UNAVAILABLE"
  | "JOB_NOT_FOUND"
  | "INVALID_TRANSITION";

export class BridgeJobStoreError extends Error {
  constructor(code: BridgeJobStoreErrorCode, message: string);
  readonly code: BridgeJobStoreErrorCode;
}

export interface BridgeJobStore {
  activate(input: BridgeJobActivation): BridgeJobSnapshot;
  getIdempotentJob(
    requestId: string,
    identity: BridgeJobRequestIdentity,
  ): BridgeJobSnapshot | null;
  getJob(jobId: string): BridgeJobSnapshot | null;
  getActiveJob(): BridgeJobSnapshot | null;
  getPendingItems(): StagedItem[];
  getStagedTimestamp(): number | null;
  getStagedCount(): number;
  isReady(): boolean;
  hasPendingAttachment(attachmentId: number, expectedJobId?: string): boolean;
  claimActive(
    expectedJobId?: string,
    selectedAttachmentIds?: number[],
  ): BridgeJobSnapshot | null;
  transition(
    jobId: string,
    state: BridgeJobState,
    details?: BridgeJobJson,
  ): BridgeJobSnapshot;
  cancel(jobId: string, details?: BridgeJobJson): BridgeJobSnapshot;
  reset(): void;
}

export function createBridgeJobStore(
  options?: BridgeJobStoreOptions,
): BridgeJobStore;

export const bridgeJobStore: BridgeJobStore;

export default bridgeJobStore;
