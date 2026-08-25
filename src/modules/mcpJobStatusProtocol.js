import { createMcpCreateJobSuccessBody } from "./mcpJobControlProtocol.js";

export const MCP_JOB_STATUS_CONTENT_TYPE =
  "application/vnd.zotero-gemini-notebook.job-status+json";
export const MCP_JOB_STATUS_MAX_BODY_BYTES = 256;

const JOB_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export class McpJobStatusProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpJobStatusProtocolError";
    this.code = "INVALID_REQUEST";
  }
}

export function readMcpJobStatusContentLength(headers) {
  const value = readSingleHeader(headers, "content-length");
  if (!/^(?:[1-9][0-9]{0,2})$/.test(value ?? "")) {
    throw invalidRequest("Content-Length must use canonical decimal notation");
  }

  const length = Number(value);
  if (length < 1 || length > MCP_JOB_STATUS_MAX_BODY_BYTES) {
    throw invalidRequest("The job-status request body is too large");
  }
  return length;
}

export function parseCanonicalJobStatusBody(value) {
  const bytes = toBytes(value);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MCP_JOB_STATUS_MAX_BODY_BYTES
  ) {
    throw invalidRequest("The job-status request body length is invalid");
  }

  let text;
  let document;
  try {
    text = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(text);
  } catch {
    throw invalidRequest("The job-status request body is not strict JSON");
  }

  if (
    !isPlainObject(document) ||
    Object.keys(document).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(document, "jobId") ||
    typeof document.jobId !== "string" ||
    !JOB_ID_PATTERN.test(document.jobId)
  ) {
    throw invalidRequest("The job-status request schema is invalid");
  }

  const normalized = Object.freeze({ jobId: document.jobId });
  const canonical = JSON.stringify(normalized);
  const canonicalBytes = new globalThis.TextEncoder().encode(canonical);
  if (!bytesEqual(bytes, canonicalBytes) || text !== canonical) {
    throw invalidRequest("The job-status request is not canonical JSON");
  }
  return normalized;
}

export function createMcpJobStatusSuccessBody(job) {
  return createMcpCreateJobSuccessBody(job);
}

export function createMcpJobNotFoundBody() {
  return '{"apiVersion":1,"error":{"code":"job_not_found","message":"The requested Zotero bridge job was not found.","retryable":false}}';
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
  throw invalidRequest("The job-status request body must be raw bytes");
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
  return new McpJobStatusProtocolError(message);
}
