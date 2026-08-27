import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  MCP_AUTH_EMPTY_BODY_SHA256,
  MCP_AUTH_HEADERS,
  MCP_AUTH_RESPONSE_CANONICAL_PREFIX,
  MCP_AUTH_RESPONSE_SIGNATURE_HEADER,
  McpAuthProtocolError,
  createMcpAuthCanonicalString,
  createMcpAuthReplayCache,
  createMcpAuthResponseCanonicalString,
  createMcpAuthResponseSignature,
  encodeBase64Url,
  hasMcpQueryParameters,
  isMcpBrowserRequest,
  sha256Hex,
  verifyMcpAuthRequest,
} from "../src/modules/mcpAuthProtocol.js";

const NOW = 1_787_558_400;
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const NONCE = encodeBase64Url(Uint8Array.from({ length: 16 }, (_, i) => i));
const PATHNAME = "/notebooklm/control/v1/auth-check";
const CONTENT_TYPE = "application/json";
const BODY = "{}";
const RESPONSE_BODY = '{"apiVersion":1,"authenticated":true}';
const RESPONSE_BODY_SHA256 =
  "9ffcda143f09709b95ac54dbba37b8893df5b6b7991f8cea01c69af9a7cb692c";
const RESPONSE_SIGNATURE = "m6zXyLpSa25w2Q12Vf3htBaX0eNnqR-YLweKEMN3kZ8";

test("publishes the canonical authentication header spellings", () => {
  assert.deepEqual(MCP_AUTH_HEADERS, {
    version: "X-ZGN-Auth-Version",
    timestamp: "X-ZGN-Timestamp",
    nonce: "X-ZGN-Nonce",
    signature: "X-ZGN-Signature",
  });
  assert.equal(
    MCP_AUTH_RESPONSE_CANONICAL_PREFIX,
    "ZGN-LOCAL-AUTH-RESPONSE-V1",
  );
  assert.equal(MCP_AUTH_RESPONSE_SIGNATURE_HEADER, "X-ZGN-Response-Signature");
});

function expectProtocolError(code) {
  return (error) => {
    assert.ok(error instanceof McpAuthProtocolError);
    assert.equal(error.code, code);
    return true;
  };
}

async function createSigningHarness(overrides = {}) {
  const bodySha256 = await sha256Hex(BODY, webcrypto);
  const input = {
    timestamp: String(NOW),
    nonce: NONCE,
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    bodySha256,
    ...overrides,
  };
  const canonical = createMcpAuthCanonicalString(input);
  const signingKey = await webcrypto.subtle.importKey(
    "raw",
    KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      "HMAC",
      signingKey,
      new globalThis.TextEncoder().encode(canonical),
    ),
  );
  assert.equal(signature.length, 32);

  return {
    input,
    headers: {
      "x-zgn-auth-version": "1",
      "x-zgn-timestamp": input.timestamp,
      "x-zgn-nonce": input.nonce,
      "x-zgn-signature": encodeBase64Url(signature),
      "user-agent": "zotero-gemini-notebook-mcp/0.4.0",
    },
  };
}

test("builds the exact LF-delimited canonical request without a trailing LF", () => {
  const canonical = createMcpAuthCanonicalString({
    timestamp: String(NOW),
    nonce: NONCE,
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    bodySha256: MCP_AUTH_EMPTY_BODY_SHA256,
  });

  assert.equal(
    canonical,
    [
      "ZGN-LOCAL-AUTH-V1",
      String(NOW),
      NONCE,
      "POST",
      PATHNAME,
      CONTENT_TYPE,
      MCP_AUTH_EMPTY_BODY_SHA256,
    ].join("\n"),
  );
  assert.equal(canonical.endsWith("\n"), false);
});

test("publishes the fixed SHA-256 digest for the exact empty JSON object", async () => {
  assert.equal(await sha256Hex(BODY, webcrypto), MCP_AUTH_EMPTY_BODY_SHA256);
});

test("creates the shared request-bound response proof vector", async () => {
  const canonical = createMcpAuthResponseCanonicalString({
    timestamp: String(NOW),
    nonce: NONCE,
    method: "POST",
    pathname: PATHNAME,
    status: 200,
    bodySha256: RESPONSE_BODY_SHA256,
  });

  assert.equal(
    canonical,
    [
      "ZGN-LOCAL-AUTH-RESPONSE-V1",
      String(NOW),
      NONCE,
      "POST",
      PATHNAME,
      "200",
      RESPONSE_BODY_SHA256,
    ].join("\n"),
  );
  assert.equal(canonical.endsWith("\n"), false);
  assert.equal(
    await createMcpAuthResponseSignature({
      timestamp: NOW,
      nonce: NONCE,
      method: "POST",
      pathname: PATHNAME,
      status: 200,
      body: RESPONSE_BODY,
      key: KEY,
      cryptoApi: webcrypto,
    }),
    RESPONSE_SIGNATURE,
  );
});

test("binds response proofs to the request, status, path, and exact body", async () => {
  const base = {
    timestamp: NOW,
    nonce: NONCE,
    method: "POST",
    pathname: PATHNAME,
    status: 200,
    body: RESPONSE_BODY,
    key: KEY,
    cryptoApi: webcrypto,
  };
  const signatures = await Promise.all([
    createMcpAuthResponseSignature(base),
    createMcpAuthResponseSignature({ ...base, timestamp: NOW + 1 }),
    createMcpAuthResponseSignature({
      ...base,
      nonce: encodeBase64Url(
        Uint8Array.from({ length: 16 }, (_, index) => index + 1),
      ),
    }),
    createMcpAuthResponseSignature({ ...base, pathname: "/other" }),
    createMcpAuthResponseSignature({ ...base, status: 201 }),
    createMcpAuthResponseSignature({ ...base, body: RESPONSE_BODY + " " }),
  ]);

  assert.equal(new Set(signatures).size, signatures.length);
});

test("verifies the shared cross-language HMAC-SHA256 protocol vector", async () => {
  const headers = {
    "X-ZGN-Auth-Version": "1",
    "X-ZGN-Timestamp": String(NOW),
    "X-ZGN-Nonce": NONCE,
    "X-ZGN-Signature": "IBgKEu-BEe213hse1WS9QLmFDlHZQsj5lpjdLMgUmEA",
    "User-Agent": "zotero-gemini-notebook-mcp/0.4.0",
  };

  await verifyMcpAuthRequest({
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    body: BODY,
    headers,
    key: KEY,
    replayCache: createMcpAuthReplayCache({ now: () => NOW }),
    cryptoApi: webcrypto,
    nowSeconds: NOW,
  });
});

test("verifies a 32-byte HMAC and reserves its nonce", async () => {
  const { headers } = await createSigningHarness();
  const replayCache = createMcpAuthReplayCache({ now: () => NOW });

  const authenticated = await verifyMcpAuthRequest({
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    body: BODY,
    headers,
    key: KEY,
    replayCache,
    cryptoApi: webcrypto,
    nowSeconds: NOW,
  });

  assert.deepEqual(authenticated, {
    timestamp: NOW,
    nonce: NONCE,
  });
  assert.equal(replayCache.size, 1);
  await assert.rejects(
    verifyMcpAuthRequest({
      method: "POST",
      pathname: PATHNAME,
      contentType: CONTENT_TYPE,
      body: BODY,
      headers,
      key: KEY,
      replayCache,
      cryptoApi: webcrypto,
      nowSeconds: NOW,
    }),
    expectProtocolError("AUTHENTICATION_FAILED"),
  );
});

test("rejects stale, future, wrong-body, wrong-path, and wrong-key requests", async () => {
  const { headers } = await createSigningHarness();
  const base = {
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    body: BODY,
    headers,
    key: KEY,
    cryptoApi: webcrypto,
  };

  for (const overrides of [
    { nowSeconds: NOW + 61 },
    { nowSeconds: NOW - 61 },
    { nowSeconds: NOW, body: '{"unexpected":true}' },
    { nowSeconds: NOW, pathname: "/notebooklm/control/v1/other" },
    {
      nowSeconds: NOW,
      key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    },
  ]) {
    await assert.rejects(
      verifyMcpAuthRequest({
        ...base,
        ...overrides,
        replayCache: createMcpAuthReplayCache({ now: () => NOW }),
      }),
      expectProtocolError("AUTHENTICATION_FAILED"),
    );
  }
});

test("rejects malformed or missing authentication headers uniformly", async () => {
  const { headers } = await createSigningHarness();
  for (const name of [
    "x-zgn-auth-version",
    "x-zgn-timestamp",
    "x-zgn-nonce",
    "x-zgn-signature",
  ]) {
    const malformed = { ...headers };
    delete malformed[name];
    await assert.rejects(
      verifyMcpAuthRequest({
        method: "POST",
        pathname: PATHNAME,
        contentType: CONTENT_TYPE,
        body: BODY,
        headers: malformed,
        key: KEY,
        replayCache: createMcpAuthReplayCache({ now: () => NOW }),
        cryptoApi: webcrypto,
        nowSeconds: NOW,
      }),
      expectProtocolError("AUTHENTICATION_FAILED"),
    );
  }

  await assert.rejects(
    verifyMcpAuthRequest({
      method: "POST",
      pathname: PATHNAME,
      contentType: CONTENT_TYPE,
      body: BODY,
      headers: {
        ...headers,
        "X-ZGN-Timestamp": headers["x-zgn-timestamp"],
      },
      key: KEY,
      replayCache: createMcpAuthReplayCache({ now: () => NOW }),
      cryptoApi: webcrypto,
      nowSeconds: NOW,
    }),
    expectProtocolError("AUTHENTICATION_FAILED"),
  );

  await assert.rejects(
    verifyMcpAuthRequest({
      method: "POST",
      pathname: PATHNAME,
      contentType: CONTENT_TYPE,
      body: BODY,
      headers: {
        ...headers,
        "X-ZGN-Body-SHA256": MCP_AUTH_EMPTY_BODY_SHA256,
      },
      key: KEY,
      replayCache: createMcpAuthReplayCache({ now: () => NOW }),
      cryptoApi: webcrypto,
      nowSeconds: NOW,
    }),
    expectProtocolError("AUTHENTICATION_FAILED"),
  );
});

test("rejects browser and legacy connector request signals", () => {
  const safe = { "user-agent": "Python-urllib/3.13" };
  assert.equal(isMcpBrowserRequest(safe), false);

  for (const headers of [
    { origin: "https://example.com" },
    { Origin: "https://example.com" },
    { "Sec-Fetch": "cross-site" },
    { "sec-fetch-site": "cross-site" },
    { "user-agent": "Mozilla/5.0" },
    { "user-agent": "Python-urllib/3.13", "User-Agent": "Mozilla/5.0" },
    { "zotero-allowed-request": "1" },
    { "x-zotero-connector-api-version": "3" },
  ]) {
    assert.equal(isMcpBrowserRequest(headers), true);
  }
});

test("requires an empty URLSearchParams-like query container", () => {
  assert.equal(hasMcpQueryParameters(new globalThis.URLSearchParams()), false);
  assert.equal(
    hasMcpQueryParameters(new globalThis.URLSearchParams("anything=1")),
    true,
  );
  assert.equal(
    hasMcpQueryParameters(new globalThis.URLSearchParams("anything")),
    true,
  );
  assert.equal(hasMcpQueryParameters(undefined), true);
  assert.equal(hasMcpQueryParameters({}), true);
});

test("fails closed when a bounded replay cache is full and reopens after TTL", () => {
  let now = NOW;
  const cache = createMcpAuthReplayCache({
    maxEntries: 1,
    ttlSeconds: 120,
    now: () => now,
  });
  const secondNonce = encodeBase64Url(
    Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  );

  assert.equal(cache.reserve(NONCE), "reserved");
  assert.equal(cache.reserve(NONCE), "replay");
  assert.equal(cache.reserve(secondNonce), "full");
  now += 120;
  assert.equal(cache.reserve(secondNonce), "full");
  now += 1;
  assert.equal(cache.reserve(secondNonce), "reserved");
  cache.reset();
  assert.equal(cache.size, 0);
});

test("rejects canonical fields containing ambiguity", () => {
  const base = {
    timestamp: String(NOW),
    nonce: NONCE,
    method: "POST",
    pathname: PATHNAME,
    contentType: CONTENT_TYPE,
    bodySha256: MCP_AUTH_EMPTY_BODY_SHA256,
  };

  assert.throws(
    () => createMcpAuthCanonicalString({ ...base, method: "post" }),
    expectProtocolError("INVALID_REQUEST"),
  );
  assert.throws(
    () =>
      createMcpAuthCanonicalString({ ...base, pathname: `${PATHNAME}?x=1` }),
    expectProtocolError("INVALID_REQUEST"),
  );
  assert.throws(
    () => createMcpAuthCanonicalString({ ...base, contentType: "bad\ntype" }),
    expectProtocolError("INVALID_REQUEST"),
  );
  assert.throws(
    () => createMcpAuthCanonicalString({ ...base, timestamp: `0${NOW}` }),
    expectProtocolError("INVALID_REQUEST"),
  );
});
