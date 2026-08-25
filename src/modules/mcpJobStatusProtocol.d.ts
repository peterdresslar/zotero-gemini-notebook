import type { BridgeJobSnapshot } from "./bridgeJobStore.js";

export const MCP_JOB_STATUS_CONTENT_TYPE: string;
export const MCP_JOB_STATUS_MAX_BODY_BYTES: 256;

export interface McpJobStatusInput {
  jobId: string;
}

export class McpJobStatusProtocolError extends Error {
  readonly code: "INVALID_REQUEST";
}

export function readMcpJobStatusContentLength(
  headers: Record<string, unknown>,
): number;
export function parseCanonicalJobStatusBody(
  value: ArrayBuffer | ArrayBufferView,
): Readonly<McpJobStatusInput>;
export function createMcpJobStatusSuccessBody(job: BridgeJobSnapshot): string;
export function createMcpJobNotFoundBody(): string;
