export const MCP_AUTH_HEADERS: Readonly<{
  version: "X-ZGN-Auth-Version";
  timestamp: "X-ZGN-Timestamp";
  nonce: "X-ZGN-Nonce";
  signature: "X-ZGN-Signature";
}>;

export const MCP_AUTH_VERSION: "1";
export const MCP_AUTH_CANONICAL_PREFIX: "ZGN-LOCAL-AUTH-V1";
export const MCP_AUTH_RESPONSE_CANONICAL_PREFIX: "ZGN-LOCAL-AUTH-RESPONSE-V1";
export const MCP_AUTH_RESPONSE_SIGNATURE_HEADER: "X-ZGN-Response-Signature";
export const MCP_AUTH_EMPTY_BODY_SHA256: string;

export type McpAuthProtocolErrorCode =
  | "INVALID_REQUEST"
  | "BROWSER_REQUEST_REJECTED"
  | "AUTHENTICATION_FAILED"
  | "CRYPTO_UNAVAILABLE";

export class McpAuthProtocolError extends Error {
  constructor(code: McpAuthProtocolErrorCode, message: string);
  readonly code: McpAuthProtocolErrorCode;
}

export interface McpAuthCanonicalInput {
  timestamp: string | number;
  nonce: string;
  method: string;
  pathname: string;
  contentType: string;
  bodySha256: string;
}

export interface McpAuthResponseCanonicalInput {
  timestamp: string | number;
  nonce: string;
  method: string;
  pathname: string;
  status: number;
  bodySha256: string;
}

export interface McpAuthResponseSignatureInput {
  timestamp: string | number;
  nonce: string;
  method: string;
  pathname: string;
  status: number;
  body: string | ArrayBuffer | ArrayBufferView;
  key: ArrayBuffer | ArrayBufferView;
  cryptoApi?: Crypto;
}

export interface McpAuthHeaders {
  readonly version: "1";
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface McpAuthReplayCache {
  reserve(nonce: string, atSeconds?: number): "reserved" | "replay" | "full";
  reset(): void;
  readonly size: number;
}

export interface McpAuthReplayCacheOptions {
  ttlSeconds?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface McpAuthVerificationInput {
  method: string;
  pathname: string;
  contentType: string;
  body: string | ArrayBuffer | ArrayBufferView;
  headers: Record<string, unknown>;
  key: ArrayBuffer | ArrayBufferView;
  replayCache: McpAuthReplayCache;
  cryptoApi?: Crypto;
  nowSeconds?: number;
  maxClockSkewSeconds?: number;
}

export interface McpAuthenticatedRequest {
  readonly timestamp: number;
  readonly nonce: string;
}

export function createMcpAuthCanonicalString(
  input: McpAuthCanonicalInput,
): string;
export function createMcpAuthResponseCanonicalString(
  input: McpAuthResponseCanonicalInput,
): string;
export function createMcpAuthResponseSignature(
  input: McpAuthResponseSignatureInput,
): Promise<string>;
export function readMcpAuthHeaders(
  headers: Record<string, unknown>,
): McpAuthHeaders;
export function isMcpBrowserRequest(headers: Record<string, unknown>): boolean;
export function assertMcpNonBrowserRequest(
  headers: Record<string, unknown>,
): void;
export function hasMcpQueryParameters(searchParams: unknown): boolean;
export function createMcpAuthReplayCache(
  options?: McpAuthReplayCacheOptions,
): McpAuthReplayCache;
export function verifyMcpAuthRequest(
  input: McpAuthVerificationInput,
): Promise<McpAuthenticatedRequest>;
export function sha256Hex(
  value: string | ArrayBuffer | ArrayBufferView,
  cryptoApi?: Crypto,
): Promise<string>;
export function encodeBase64Url(
  value: string | ArrayBuffer | ArrayBufferView,
): string;
