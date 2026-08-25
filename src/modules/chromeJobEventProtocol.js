export const CHROME_JOB_EVENT_CONTENT_TYPE =
  "application/vnd.zotero-gemini-notebook.job-event+json";
export const CHROME_JOB_EVENT_MAX_BODY_BYTES = 1024;

const CHROME_JOB_EVENTS = new Set(["submitted", "unverified", "failed"]);
const JOB_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class ChromeJobEventProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChromeJobEventProtocolError";
  }
}

export function readChromeJobEventContentLength(headers) {
  const value = readSingleHeader(headers, "content-length");
  if (!/^(?:[1-9][0-9]{0,3})$/.test(value ?? "")) {
    throw invalidRequest("Content-Length must use canonical decimal notation");
  }

  const length = Number(value);
  if (length < 1 || length > CHROME_JOB_EVENT_MAX_BODY_BYTES) {
    throw invalidRequest("The Chrome job-event request body is too large");
  }
  return length;
}

export function rawChromeJobEventBodyToBytes(value, expectedLength) {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > CHROME_JOB_EVENT_MAX_BODY_BYTES ||
    value.length !== expectedLength
  ) {
    throw invalidRequest("The Chrome job-event request body length is invalid");
  }

  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) {
      throw invalidRequest(
        "The Chrome job-event request body is not raw bytes",
      );
    }
    bytes[index] = code;
  }
  return bytes;
}

export function parseCanonicalChromeJobEventBody(value) {
  const bytes = toBytes(value);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > CHROME_JOB_EVENT_MAX_BODY_BYTES
  ) {
    throw invalidRequest("The Chrome job-event request body length is invalid");
  }

  let text;
  let document;
  try {
    text = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(text);
  } catch {
    throw invalidRequest(
      "The Chrome job-event request body is not strict JSON",
    );
  }

  if (
    !isPlainObject(document) ||
    Object.keys(document).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(document, "claimId") ||
    !Object.prototype.hasOwnProperty.call(document, "event") ||
    !Object.prototype.hasOwnProperty.call(document, "jobId") ||
    typeof document.claimId !== "string" ||
    !CLAIM_ID_PATTERN.test(document.claimId) ||
    typeof document.event !== "string" ||
    !CHROME_JOB_EVENTS.has(document.event) ||
    typeof document.jobId !== "string" ||
    !JOB_ID_PATTERN.test(document.jobId)
  ) {
    throw invalidRequest("The Chrome job-event request schema is invalid");
  }

  const normalized = Object.freeze({
    claimId: document.claimId,
    event: document.event,
    jobId: document.jobId,
  });
  const canonical = JSON.stringify(normalized);
  const canonicalBytes = new globalThis.TextEncoder().encode(canonical);
  if (!bytesEqual(bytes, canonicalBytes) || text !== canonical) {
    throw invalidRequest("The Chrome job-event request is not canonical JSON");
  }

  return normalized;
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
  throw invalidRequest("The Chrome job-event request body must be raw bytes");
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
  return new ChromeJobEventProtocolError(message);
}
