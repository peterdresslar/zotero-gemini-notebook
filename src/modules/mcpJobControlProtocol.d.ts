import type { BridgeJobSnapshot } from "./bridgeJobStore.js";
import type { CreateBridgeJobInput } from "../types";

export const MCP_CREATE_JOB_CONTENT_TYPE: string;
export const MCP_CREATE_JOB_MAX_BODY_BYTES: 16384;
export const MCP_CREATE_JOB_MAX_ITEM_KEYS: 256;

export class McpJobControlProtocolError extends Error {
  constructor(
    message: string,
    code?: "INVALID_REQUEST" | "SOURCE_LIMIT_EXCEEDED",
  );
  readonly code: "INVALID_REQUEST" | "SOURCE_LIMIT_EXCEEDED";
}

export type AuthenticatedCreateBridgeJobInput = CreateBridgeJobInput & {
  requestId: string;
  replace: false;
};

export function readMcpCreateJobContentLength(
  headers: Record<string, unknown>,
): number;
export function rawBinaryStringToBytes(
  value: unknown,
  expectedLength: number,
): Uint8Array;
export function parseCanonicalCreateJobBody(
  value: ArrayBuffer | ArrayBufferView,
): AuthenticatedCreateBridgeJobInput;
export function createMcpCreateJobSuccessBody(job: BridgeJobSnapshot): string;
export function canonicalJsonStringify(value: unknown): string;
