import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  createMcpAuthCanonicalString,
  createMcpAuthResponseSignature,
  encodeBase64Url,
  sha256Hex,
} from "../src/modules/mcpAuthProtocol.js";
import {
  MCP_CREATE_JOB_CONTENT_TYPE,
  MCP_CREATE_JOB_MAX_BODY_BYTES,
  MCP_CREATE_JOB_MAX_ITEM_KEYS,
  McpJobControlProtocolError,
  canonicalJsonStringify,
  createMcpCreateJobSuccessBody,
  parseCanonicalCreateJobBody,
  rawBinaryStringToBytes,
  readMcpCreateJobContentLength,
} from "../src/modules/mcpJobControlProtocol.js";

const encoder = new globalThis.TextEncoder();
const VECTOR_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const VECTOR_NONCE = "AAECAwQFBgcICQoLDA0ODw";
const VECTOR_TIMESTAMP = "1787558400";

function expectJobProtocolError(code = "INVALID_REQUEST") {
  return (error) => {
    assert.ok(error instanceof McpJobControlProtocolError);
    assert.equal(error.code, code);
    return true;
  };
}

test("publishes one non-plain-text raw request representation and tight bounds", () => {
  assert.equal(
    MCP_CREATE_JOB_CONTENT_TYPE,
    "application/vnd.zotero-gemini-notebook.job+json",
  );
  assert.equal(MCP_CREATE_JOB_MAX_BODY_BYTES, 16_384);
  assert.equal(MCP_CREATE_JOB_MAX_ITEM_KEYS, 256);
});

test("parses the exact sorted compact item-key request", () => {
  const body =
    '{"destination":"new","itemKeys":["AAAA1111","BBBB2222"],"libraryID":1,"replace":false,"requestId":"request-1"}';

  assert.deepEqual(parseCanonicalCreateJobBody(encoder.encode(body)), {
    libraryID: 1,
    destination: "new",
    replace: false,
    requestId: "request-1",
    itemKeys: ["AAAA1111", "BBBB2222"],
  });
});

test("parses the exact sorted compact collection request with explicit defaults", () => {
  const body =
    '{"collectionKey":"ABCD1234","destination":"new","libraryID":2,"recursive":false,"replace":false,"requestId":"a3c14c56-1f00-4d2e-8e68-b36fc7068be3"}';

  assert.deepEqual(parseCanonicalCreateJobBody(encoder.encode(body)), {
    libraryID: 2,
    destination: "new",
    replace: false,
    requestId: "a3c14c56-1f00-4d2e-8e68-b36fc7068be3",
    collectionKey: "ABCD1234",
    recursive: false,
  });
});

test("rejects semantically valid but noncanonical JSON bytes", () => {
  const cases = [
    '{ "destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"replace":false,"requestId":"request-1"}',
    '{"libraryID":1,"destination":"new","itemKeys":["AAAA1111"],"replace":false,"requestId":"request-1"}',
    '{"destination":"new","itemKeys":["aaaa1111"],"libraryID":1,"replace":false,"requestId":"request-1"}',
    '{"destination":"new","itemKeys":["BBBB2222","AAAA1111"],"libraryID":1,"replace":false,"requestId":"request-1"}',
    '{"collectionKey":"ABCD1234","destination":"new","libraryID":2,"replace":false,"requestId":"request-1"}',
    '{"destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"requestId":"request-1"}',
    '{"destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"replace":false,"requestId":"request-1","requestId":"request-1"}',
  ];

  for (const body of cases) {
    assert.throws(
      () => parseCanonicalCreateJobBody(encoder.encode(body)),
      expectJobProtocolError(),
    );
  }
});

test("requires a bounded ASCII request ID and forbids replacement", () => {
  for (const body of [
    '{"destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"replace":false}',
    '{"destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"replace":false,"requestId":"café"}',
    '{"destination":"new","itemKeys":["AAAA1111"],"libraryID":1,"replace":true,"requestId":"request-1"}',
  ]) {
    assert.throws(
      () => parseCanonicalCreateJobBody(encoder.encode(body)),
      expectJobProtocolError(),
    );
  }
});

test("rejects invalid UTF-8 and bounds explicit item-key selections", () => {
  assert.throws(
    () => parseCanonicalCreateJobBody(Uint8Array.of(0xc3, 0x28)),
    expectJobProtocolError(),
  );

  const tooManyKeys = Array.from(
    { length: MCP_CREATE_JOB_MAX_ITEM_KEYS + 1 },
    (_, index) => index.toString(36).toUpperCase().padStart(8, "0"),
  );
  const body = canonicalJsonStringify({
    destination: "new",
    itemKeys: tooManyKeys,
    libraryID: 1,
    replace: false,
    requestId: "request-1",
  });
  assert.throws(
    () => parseCanonicalCreateJobBody(encoder.encode(body)),
    expectJobProtocolError("SOURCE_LIMIT_EXCEEDED"),
  );
});

test("requires an exact canonical Content-Length between one and 16384", () => {
  assert.equal(readMcpCreateJobContentLength({ "content-length": "1" }), 1);
  assert.equal(
    readMcpCreateJobContentLength({ "Content-Length": "16384" }),
    16_384,
  );

  for (const headers of [
    {},
    { "content-length": "0" },
    { "content-length": "01" },
    { "content-length": "16385" },
    { "content-length": "1.0" },
    { "content-length": 1 },
    { "content-length": "1", "Content-Length": "1" },
  ]) {
    assert.throws(
      () => readMcpCreateJobContentLength(headers),
      expectJobProtocolError(),
    );
  }
});

test("converts only an exact raw binary string to bytes", () => {
  assert.deepEqual(
    rawBinaryStringToBytes("\u0000\u00ffA", 3),
    Uint8Array.of(0, 255, 65),
  );
  assert.throws(
    () => rawBinaryStringToBytes("AB", 3),
    expectJobProtocolError(),
  );
  assert.throws(
    () => rawBinaryStringToBytes("\u0100", 1),
    expectJobProtocolError(),
  );
});

test("creates only the allowlisted, canonical signed-success body", () => {
  const body = createMcpCreateJobSuccessBody({
    jobId: "f84bf93c-1435-41a2-ae08-b25e0eed195f",
    state: "staged",
    origin: "agent",
    source: {
      type: "items",
      libraryID: 1,
      itemKeys: ["PRIVATE1"],
    },
    destination: "new",
    itemCount: 2,
    skippedCount: 1,
    createdAt: 1_787_558_400_000,
    updatedAt: 1_787_558_400_000,
    expiresAt: null,
    details: { filePath: "/private/source.pdf" },
  });

  assert.equal(
    body,
    '{"apiVersion":1,"job":{"createdAt":1787558400000,"expiresAt":null,"itemCount":2,"jobId":"f84bf93c-1435-41a2-ae08-b25e0eed195f","skippedCount":1,"state":"staged","updatedAt":1787558400000}}',
  );
  assert.doesNotMatch(body, /PRIVATE1|libraryID|filePath|source\.pdf/u);
});

test("publishes a cross-language create-job request and response proof vector", async () => {
  const requestBody =
    '{"collectionKey":"ABCD1234","destination":"new","libraryID":2,"recursive":false,"replace":false,"requestId":"a3c14c56-1f00-4d2e-8e68-b36fc7068be3"}';
  const bodySha256 = await sha256Hex(requestBody, webcrypto);
  const canonical = createMcpAuthCanonicalString({
    timestamp: VECTOR_TIMESTAMP,
    nonce: VECTOR_NONCE,
    method: "POST",
    pathname: "/notebooklm/control/v1/jobs",
    contentType: MCP_CREATE_JOB_CONTENT_TYPE,
    bodySha256,
  });
  const signingKey = await webcrypto.subtle.importKey(
    "raw",
    VECTOR_KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const requestSignature = encodeBase64Url(
    new Uint8Array(
      await webcrypto.subtle.sign(
        "HMAC",
        signingKey,
        encoder.encode(canonical),
      ),
    ),
  );

  assert.equal(encoder.encode(requestBody).byteLength, 147);
  assert.equal(
    bodySha256,
    "ec4c6d4fb65a9ad5b1295d4e7a0438cc4775399148fa671b55eecae888a68aa3",
  );
  assert.equal(requestSignature, "dHPG5WHeIWUYMOr8AS8nCIv6QJnKAD1LYNdwSgoBXMc");

  const responseBody =
    '{"apiVersion":1,"job":{"createdAt":1787558400000,"expiresAt":null,"itemCount":2,"jobId":"f84bf93c-1435-41a2-ae08-b25e0eed195f","skippedCount":1,"state":"staged","updatedAt":1787558400000}}';
  assert.equal(
    await createMcpAuthResponseSignature({
      timestamp: VECTOR_TIMESTAMP,
      nonce: VECTOR_NONCE,
      method: "POST",
      pathname: "/notebooklm/control/v1/jobs",
      status: 200,
      body: responseBody,
      key: VECTOR_KEY,
      cryptoApi: webcrypto,
    }),
    "20dBnXP0_QYiMvnDMnkad6h-q0AZBM4O8845VDAcxsQ",
  );
});
