const AUTH_HEADER_NAMES = Object.freeze({
  version: "X-ZGN-Auth-Version",
  timestamp: "X-ZGN-Timestamp",
  nonce: "X-ZGN-Nonce",
  signature: "X-ZGN-Signature",
});

// Request headers are logged by Zotero core before an add-on endpoint runs.
// A bare body digest would therefore leave a stable, guessable fingerprint of
// private Zotero identifiers in the debug log. Both peers already have the
// exact request bytes, so the digest belongs only inside the HMAC canonical
// string and is never transmitted as a header.
const FORBIDDEN_BODY_DIGEST_HEADER = "X-ZGN-Body-SHA256";

const CANONICAL_PREFIX = "ZGN-LOCAL-AUTH-V1";
const RESPONSE_CANONICAL_PREFIX = "ZGN-LOCAL-AUTH-RESPONSE-V1";
const RESPONSE_SIGNATURE_HEADER = "X-ZGN-Response-Signature";
const AUTH_VERSION = "1";
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_REPLAY_TTL_SECONDS = 120;
const DEFAULT_MAX_REPLAY_ENTRIES = 2048;
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_AUTHORIZATION_KEY_BYTES = 32;

export const MCP_AUTH_HEADERS = AUTH_HEADER_NAMES;
export const MCP_AUTH_VERSION = AUTH_VERSION;
export const MCP_AUTH_CANONICAL_PREFIX = CANONICAL_PREFIX;
export const MCP_AUTH_RESPONSE_CANONICAL_PREFIX = RESPONSE_CANONICAL_PREFIX;
export const MCP_AUTH_RESPONSE_SIGNATURE_HEADER = RESPONSE_SIGNATURE_HEADER;
export const MCP_AUTH_EMPTY_BODY_SHA256 =
  "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

export class McpAuthProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpAuthProtocolError";
    this.code = code;
  }
}

export function createMcpAuthCanonicalString(input) {
  if (!isPlainObject(input)) {
    throw invalidRequest("Authentication input must be an object");
  }

  const timestamp = requireTimestamp(input.timestamp);
  const nonce = requireNonce(input.nonce);
  const method = requireCanonicalField(input.method, "method");
  const pathname = requireCanonicalField(input.pathname, "pathname");
  const contentType = requireCanonicalField(
    input.contentType,
    "contentType",
    true,
  );
  const bodySha256 = requireBodySha256(input.bodySha256);

  if (!/^[A-Z]+$/.test(method)) {
    throw invalidRequest("method must use uppercase ASCII letters");
  }
  if (
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#")
  ) {
    throw invalidRequest(
      "pathname must be an exact path without a query or fragment",
    );
  }

  return [
    CANONICAL_PREFIX,
    timestamp,
    nonce,
    method,
    pathname,
    contentType,
    bodySha256,
  ].join("\n");
}

export function createMcpAuthResponseCanonicalString(input) {
  if (!isPlainObject(input)) {
    throw invalidRequest("Authentication response input must be an object");
  }

  const timestamp = requireTimestamp(input.timestamp);
  const nonce = requireNonce(input.nonce);
  const method = requireCanonicalField(input.method, "method");
  const pathname = requireCanonicalField(input.pathname, "pathname");
  const status = input.status;
  const bodySha256 = requireBodySha256(input.bodySha256);

  if (!/^[A-Z]+$/.test(method)) {
    throw invalidRequest("method must use uppercase ASCII letters");
  }
  if (
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#")
  ) {
    throw invalidRequest(
      "pathname must be an exact path without a query or fragment",
    );
  }
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw invalidRequest("status must be a valid HTTP status code");
  }

  return [
    RESPONSE_CANONICAL_PREFIX,
    timestamp,
    nonce,
    method,
    pathname,
    String(status),
    bodySha256,
  ].join("\n");
}

export async function createMcpAuthResponseSignature({
  timestamp,
  nonce,
  method,
  pathname,
  status,
  body,
  key,
  cryptoApi = globalThis.crypto,
}) {
  const bodySha256 = await sha256Hex(body, cryptoApi);
  const canonical = createMcpAuthResponseCanonicalString({
    timestamp,
    nonce,
    method,
    pathname,
    status,
    bodySha256,
  });
  const signingKey = await importHmacKey(key, cryptoApi, "sign");

  let signature;
  try {
    signature = await cryptoApi.subtle.sign(
      "HMAC",
      signingKey,
      new globalThis.TextEncoder().encode(canonical),
    );
  } catch {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "HMAC signing is unavailable",
    );
  }
  return encodeBase64Url(new Uint8Array(signature));
}

export function readMcpAuthHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    throw authenticationFailed();
  }

  const version = readHeader(headers, AUTH_HEADER_NAMES.version);
  if (version !== AUTH_VERSION) throw authenticationFailed();
  if (hasHeader(headers, FORBIDDEN_BODY_DIGEST_HEADER)) {
    throw authenticationFailed();
  }

  return Object.freeze({
    version,
    timestamp: requireTimestamp(
      readHeader(headers, AUTH_HEADER_NAMES.timestamp),
      true,
    ),
    nonce: requireNonce(readHeader(headers, AUTH_HEADER_NAMES.nonce), true),
    signature: requireSignature(
      readHeader(headers, AUTH_HEADER_NAMES.signature),
    ),
  });
}

export function isMcpBrowserRequest(headers) {
  if (!headers || typeof headers !== "object") return true;

  if (
    hasHeader(headers, "origin") ||
    hasHeader(headers, "zotero-allowed-request") ||
    hasHeader(headers, "x-zotero-connector-api-version")
  ) {
    return true;
  }

  const userAgent = readHeader(headers, "user-agent");
  if (
    hasHeader(headers, "user-agent") &&
    (typeof userAgent !== "string" || /^Mozilla\//i.test(userAgent))
  ) {
    return true;
  }

  return Object.keys(headers).some((name) => {
    const normalizedName = name.toLowerCase();
    return (
      normalizedName === "sec-fetch" || normalizedName.startsWith("sec-fetch-")
    );
  });
}

export function assertMcpNonBrowserRequest(headers) {
  if (isMcpBrowserRequest(headers)) {
    throw new McpAuthProtocolError(
      "BROWSER_REQUEST_REJECTED",
      "Browser requests are not allowed on the MCP control endpoint",
    );
  }
}

export function hasMcpQueryParameters(searchParams) {
  if (
    !searchParams ||
    typeof searchParams !== "object" ||
    typeof searchParams.toString !== "function"
  ) {
    return true;
  }
  try {
    return searchParams.toString() !== "";
  } catch {
    return true;
  }
}

export function createMcpAuthReplayCache(options = {}) {
  if (!isPlainObject(options)) {
    throw invalidRequest("Replay-cache options must be an object");
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_REPLAY_TTL_SECONDS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_REPLAY_ENTRIES;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw invalidRequest("Replay-cache TTL must be a positive integer");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw invalidRequest("Replay-cache size must be a positive integer");
  }
  if (typeof now !== "function") {
    throw invalidRequest("Replay-cache clock must be a function");
  }

  const entries = new Map();

  function reserve(nonce, atSeconds = readNow(now)) {
    const normalizedNonce = requireNonce(nonce);
    if (!Number.isSafeInteger(atSeconds) || atSeconds < 0) {
      throw invalidRequest("Replay-cache time must be a nonnegative integer");
    }

    prune(atSeconds);
    if (entries.has(normalizedNonce)) return "replay";
    if (entries.size >= maxEntries) return "full";

    entries.set(normalizedNonce, atSeconds + ttlSeconds);
    return "reserved";
  }

  function prune(atSeconds = readNow(now)) {
    for (const [nonce, expiresAt] of entries) {
      // Keep a reservation through its boundary second. A request timestamped
      // 60 seconds in the future can otherwise be replayed exactly 120 seconds
      // later while it is still inside the inclusive clock-skew window.
      if (expiresAt < atSeconds) entries.delete(nonce);
    }
  }

  function reset() {
    entries.clear();
  }

  return Object.freeze({
    reserve,
    reset,
    get size() {
      prune();
      return entries.size;
    },
  });
}

export async function verifyMcpAuthRequest({
  method,
  pathname,
  contentType,
  body,
  headers,
  key,
  replayCache,
  cryptoApi = globalThis.crypto,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxClockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
}) {
  if (!replayCache || typeof replayCache.reserve !== "function") {
    throw invalidRequest("A replay cache is required");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw invalidRequest("Authentication time must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 0) {
    throw invalidRequest("Clock skew must be a nonnegative integer");
  }

  assertMcpNonBrowserRequest(headers);
  const auth = readMcpAuthHeaders(headers);
  const timestamp = Number(auth.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > maxClockSkewSeconds
  ) {
    throw authenticationFailed();
  }

  const bodyBytes = toBytes(body);
  const actualBodySha256 = await sha256Hex(bodyBytes, cryptoApi);

  const canonical = createMcpAuthCanonicalString({
    timestamp: auth.timestamp,
    nonce: auth.nonce,
    method,
    pathname,
    contentType,
    bodySha256: actualBodySha256,
  });
  const signature = decodeBase64Url(auth.signature, 32);
  const verificationKey = await importHmacKey(key, cryptoApi, "verify");

  let valid;
  try {
    valid = await cryptoApi.subtle.verify(
      "HMAC",
      verificationKey,
      signature,
      new globalThis.TextEncoder().encode(canonical),
    );
  } catch {
    throw authenticationFailed();
  }
  if (valid !== true) throw authenticationFailed();

  const reservation = replayCache.reserve(auth.nonce, nowSeconds);
  if (reservation !== "reserved") throw authenticationFailed();

  return Object.freeze({
    timestamp,
    nonce: auth.nonce,
  });
}

export async function sha256Hex(value, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== "function") {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "Web Crypto is unavailable",
    );
  }

  let digest;
  try {
    digest = await cryptoApi.subtle.digest("SHA-256", toBytes(value));
  } catch {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "SHA-256 is unavailable",
    );
  }
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function encodeBase64Url(value) {
  const bytes = toBytes(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function readHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  const matchingNames = Object.keys(headers).filter(
    (candidate) => candidate.toLowerCase() === normalizedName,
  );
  if (matchingNames.length !== 1) return undefined;
  const value = headers[matchingNames[0]];
  return typeof value === "string" ? value : undefined;
}

function hasHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some(
    (candidate) => candidate.toLowerCase() === normalizedName,
  );
}

function requireTimestamp(value, authentication = false) {
  const timestamp = String(value);
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    if (authentication) throw authenticationFailed();
    throw invalidRequest("timestamp is invalid");
  }
  return timestamp;
}

function requireNonce(value, authentication = false) {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    if (authentication) throw authenticationFailed();
    throw invalidRequest("nonce is invalid");
  }
  try {
    decodeBase64Url(value, 16);
  } catch {
    if (authentication) throw authenticationFailed();
    throw invalidRequest("nonce is invalid");
  }
  return value;
}

function requireBodySha256(value, authentication = false) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    if (authentication) throw authenticationFailed();
    throw invalidRequest("bodySha256 is invalid");
  }
  return value;
}

function requireSignature(value) {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) {
    throw authenticationFailed();
  }
  try {
    decodeBase64Url(value, 32);
  } catch {
    throw authenticationFailed();
  }
  return value;
}

function requireCanonicalField(value, field, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw invalidRequest(`${field} is invalid`);
  }
  return value;
}

async function importHmacKey(key, cryptoApi, usage) {
  const operation = usage === "sign" ? "sign" : "verify";
  if (
    !cryptoApi?.subtle ||
    typeof cryptoApi.subtle.importKey !== "function" ||
    typeof cryptoApi.subtle[operation] !== "function"
  ) {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "Web Crypto is unavailable",
    );
  }

  let keyBytes;
  try {
    keyBytes = toBytes(key);
  } catch {
    throw authenticationFailed();
  }
  if (keyBytes.byteLength !== LOCAL_AUTHORIZATION_KEY_BYTES) {
    throw authenticationFailed();
  }

  try {
    return await cryptoApi.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      [usage],
    );
  } catch {
    throw authenticationFailed();
  }
}

function decodeBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Invalid base64url value");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = globalThis.atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
  } catch {
    throw new TypeError("Invalid base64url value");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== expectedLength || encodeBase64Url(bytes) !== value) {
    throw new TypeError("Invalid base64url length");
  }
  return bytes;
}

function toBytes(value) {
  if (typeof value === "string") {
    return new globalThis.TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalidRequest("Expected a string or byte sequence");
}

function readNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest("Replay-cache clock returned an invalid time");
  }
  return value;
}

function invalidRequest(message) {
  return new McpAuthProtocolError("INVALID_REQUEST", message);
}

function authenticationFailed() {
  return new McpAuthProtocolError(
    "AUTHENTICATION_FAILED",
    "MCP authentication failed",
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
