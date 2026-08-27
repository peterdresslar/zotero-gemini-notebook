import { normalizeCreateBridgeJobInput } from "./bridgeJobInput.js";

export const MCP_CREATE_JOB_CONTENT_TYPE =
  "application/vnd.zotero-gemini-notebook.job+json";
export const MCP_CREATE_JOB_MAX_BODY_BYTES = 16 * 1024;
export const MCP_CREATE_JOB_MAX_ITEM_KEYS = 256;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const JOB_STATES = new Set([
  "staged",
  "claimed",
  "submitted",
  "verifying",
  "verified",
  "unverified",
  "failed",
  "cancelled",
  "expired",
  "superseded",
]);

export class McpJobControlProtocolError extends Error {
  constructor(message, code = "INVALID_REQUEST") {
    super(message);
    this.name = "McpJobControlProtocolError";
    this.code = code;
  }
}

export function readMcpCreateJobContentLength(headers) {
  const value = readSingleHeader(headers, "content-length");
  if (!/^(?:[1-9][0-9]{0,4})$/.test(value ?? "")) {
    throw invalidRequest("Content-Length must use canonical decimal notation");
  }

  const length = Number(value);
  if (length < 1 || length > MCP_CREATE_JOB_MAX_BODY_BYTES) {
    throw invalidRequest("The create-job request body is too large");
  }
  return length;
}

export function rawBinaryStringToBytes(value, expectedLength) {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > MCP_CREATE_JOB_MAX_BODY_BYTES ||
    value.length !== expectedLength
  ) {
    throw invalidRequest("The create-job request body length is invalid");
  }

  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) {
      throw invalidRequest("The create-job request body is not raw bytes");
    }
    bytes[index] = code;
  }
  return bytes;
}

export function parseCanonicalCreateJobBody(value) {
  const bytes = toBytes(value);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MCP_CREATE_JOB_MAX_BODY_BYTES
  ) {
    throw invalidRequest("The create-job request body length is invalid");
  }

  let text;
  let document;
  try {
    text = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(text);
  } catch {
    throw invalidRequest("The create-job request body is not strict JSON");
  }

  if (!isPlainObject(document)) {
    throw invalidRequest("The create-job request body must be an object");
  }
  if (!Object.prototype.hasOwnProperty.call(document, "requestId")) {
    throw invalidRequest("requestId is required");
  }
  if (
    typeof document.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(document.requestId)
  ) {
    throw invalidRequest("requestId must be a bounded ASCII identifier");
  }
  if (document.destination !== "active-or-new" || document.replace !== false) {
    throw invalidRequest(
      'The create-job endpoint requires destination "active-or-new" and replace false',
    );
  }
  if (
    Array.isArray(document.itemKeys) &&
    document.itemKeys.length > MCP_CREATE_JOB_MAX_ITEM_KEYS
  ) {
    throw new McpJobControlProtocolError(
      "The create-job request contains too many item keys",
      "SOURCE_LIMIT_EXCEEDED",
    );
  }

  let normalized;
  try {
    normalized = normalizeCreateBridgeJobInput(document);
  } catch {
    throw invalidRequest("The create-job request schema is invalid");
  }

  let canonical;
  try {
    canonical = canonicalJsonStringify(normalized);
  } catch {
    throw invalidRequest("The create-job request is not canonical JSON");
  }
  const canonicalBytes = new globalThis.TextEncoder().encode(canonical);
  if (!bytesEqual(bytes, canonicalBytes) || text !== canonical) {
    throw invalidRequest("The create-job request is not canonical JSON");
  }

  return normalized;
}

export function createMcpCreateJobSuccessBody(job) {
  if (!isPlainObject(job)) {
    throw invalidRequest("The create-job result is invalid");
  }
  if (
    typeof job.jobId !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(job.jobId) ||
    !JOB_STATES.has(job.state) ||
    !Number.isSafeInteger(job.itemCount) ||
    job.itemCount < 1 ||
    !Number.isSafeInteger(job.skippedCount) ||
    job.skippedCount < 0 ||
    !Number.isSafeInteger(job.createdAt) ||
    job.createdAt < 0 ||
    !Number.isSafeInteger(job.updatedAt) ||
    job.updatedAt < 0 ||
    (job.expiresAt !== null &&
      (!Number.isSafeInteger(job.expiresAt) || job.expiresAt < 0))
  ) {
    throw invalidRequest("The create-job result is invalid");
  }

  return canonicalJsonStringify({
    apiVersion: 1,
    job: {
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      jobId: job.jobId,
      itemCount: job.itemCount,
      skippedCount: job.skippedCount,
      state: job.state,
      updatedAt: job.updatedAt,
    },
  });
}

export function canonicalJsonStringify(value) {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!/^[\x20-\x7e]*$/.test(value)) {
      throw new TypeError("Canonical JSON strings must contain only ASCII");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError("Canonical JSON values must be plain JSON values");
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${canonicalJsonStringify(key)}:${canonicalJsonStringify(value[key])}`,
    )
    .join(",")}}`;
}

function readSingleHeader(headers, expectedName) {
  if (!headers || typeof headers !== "object") return undefined;
  const matchingNames = Object.keys(headers).filter(
    (name) => name.toLowerCase() === expectedName,
  );
  if (matchingNames.length !== 1) return undefined;
  const value = headers[matchingNames[0]];
  return typeof value === "string" ? value : undefined;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalidRequest("The create-job request body must be raw bytes");
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function invalidRequest(message) {
  return new McpJobControlProtocolError(message);
}
