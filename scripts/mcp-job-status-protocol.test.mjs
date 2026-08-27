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
  MCP_JOB_STATUS_CONTENT_TYPE,
  MCP_JOB_STATUS_MAX_BODY_BYTES,
  McpJobStatusProtocolError,
  createMcpJobNotFoundBody,
  createMcpJobStatusSuccessBody,
  parseCanonicalJobStatusBody,
  readMcpJobStatusContentLength,
} from "../src/modules/mcpJobStatusProtocol.js";

const encoder = new globalThis.TextEncoder();
const JOB_ID = "f84bf93c-1435-41a2-ae08-b25e0eed195f";
const VECTOR_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const VECTOR_NONCE = "AAECAwQFBgcICQoLDA0ODw";
const VECTOR_TIMESTAMP = "1787558400";
const STATUS_PATH = "/notebooklm/control/v1/jobs/status";

function expectStatusProtocolError(error) {
  assert.ok(error instanceof McpJobStatusProtocolError);
  assert.equal(error.code, "INVALID_REQUEST");
  return true;
}

test("publishes one bounded raw job-status request representation", () => {
  assert.equal(
    MCP_JOB_STATUS_CONTENT_TYPE,
    "application/vnd.zotero-gemini-notebook.job-status+json",
  );
  assert.equal(MCP_JOB_STATUS_MAX_BODY_BYTES, 256);
});

test("parses only the exact compact canonical job ID request", () => {
  const body = `{"jobId":"${JOB_ID}"}`;
  assert.deepEqual(parseCanonicalJobStatusBody(encoder.encode(body)), {
    jobId: JOB_ID,
  });
  assert.deepEqual(
    parseCanonicalJobStatusBody(
      encoder.encode('{"jobId":"00112233445566778899aabbccddeeff"}'),
    ),
    { jobId: "00112233445566778899aabbccddeeff" },
  );
});

test("rejects malformed IDs, unknown fields, and noncanonical JSON", () => {
  for (const body of [
    `{ "jobId":"${JOB_ID}"}`,
    `{"jobId":"${JOB_ID}","extra":true}`,
    `{"jobId":"${JOB_ID}","jobId":"${JOB_ID}"}`,
    "{}",
    '{"jobId":""}',
    '{"jobId":"opaque-job-1"}',
    '{"jobId":"123e4567-e89b-12d3-a456-426614174000"}',
    '{"jobId":"123e4567-e89b-42d3-7456-426614174000"}',
    '{"jobId":"123e4567-e89b-42d3-a456-42661417400g"}',
  ]) {
    assert.throws(
      () => parseCanonicalJobStatusBody(encoder.encode(body)),
      expectStatusProtocolError,
    );
  }
  assert.throws(
    () => parseCanonicalJobStatusBody(Uint8Array.of(0xc3, 0x28)),
    expectStatusProtocolError,
  );
  assert.throws(
    () =>
      parseCanonicalJobStatusBody(
        new Uint8Array(MCP_JOB_STATUS_MAX_BODY_BYTES + 1),
      ),
    expectStatusProtocolError,
  );
  assert.throws(
    () => parseCanonicalJobStatusBody(`{"jobId":"${JOB_ID}"}`),
    expectStatusProtocolError,
  );
});

test("requires an exact canonical Content-Length between one and 256", () => {
  assert.equal(readMcpJobStatusContentLength({ "content-length": "1" }), 1);
  assert.equal(readMcpJobStatusContentLength({ "Content-Length": "256" }), 256);

  for (const headers of [
    {},
    { "content-length": "0" },
    { "content-length": "01" },
    { "content-length": "257" },
    { "content-length": "1.0" },
    { "content-length": 1 },
    { "content-length": "1", "Content-Length": "1" },
  ]) {
    assert.throws(
      () => readMcpJobStatusContentLength(headers),
      expectStatusProtocolError,
    );
  }
});

test("returns only the existing canonical allowlisted job snapshot", () => {
  const responseBody = createMcpJobStatusSuccessBody({
    jobId: JOB_ID,
    state: "submitted",
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
    updatedAt: 1_787_558_401_000,
    expiresAt: null,
    requestId: "private-request",
    details: {
      claimId: "private-claim",
      filePath: "/private/source.pdf",
      message: "private browser details",
    },
  });

  assert.equal(
    responseBody,
    `{"apiVersion":1,"job":{"createdAt":1787558400000,"expiresAt":null,"itemCount":2,"jobId":"${JOB_ID}","skippedCount":1,"state":"submitted","updatedAt":1787558401000}}`,
  );
  assert.doesNotMatch(
    responseBody,
    /PRIVATE1|libraryID|origin|destination|requestId|details|claimId|filePath|source\.pdf/u,
  );
});

test("publishes a cross-language job-status request and response proof vector", async () => {
  const requestBody = `{"jobId":"${JOB_ID}"}`;
  const bodySha256 = await sha256Hex(requestBody, webcrypto);
  const canonical = createMcpAuthCanonicalString({
    timestamp: VECTOR_TIMESTAMP,
    nonce: VECTOR_NONCE,
    method: "POST",
    pathname: STATUS_PATH,
    contentType: MCP_JOB_STATUS_CONTENT_TYPE,
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

  assert.equal(encoder.encode(requestBody).byteLength, 48);
  assert.equal(
    bodySha256,
    "86f575298e64434e0b9ecf4fd2de3cd9e00fe8b3152f0153d8219e1df574203d",
  );
  assert.equal(requestSignature, "gy4aNIw9PqDzcVfIViqhhKKs3VhEG8iqDa4nAI7uGLg");

  const responseBody =
    `{"apiVersion":1,"job":{"createdAt":1787558400000,"expiresAt":null,"itemCount":2,"jobId":"${JOB_ID}",` +
    '"skippedCount":1,"state":"submitted","updatedAt":1787558401000}}';
  assert.equal(
    await createMcpAuthResponseSignature({
      timestamp: VECTOR_TIMESTAMP,
      nonce: VECTOR_NONCE,
      method: "POST",
      pathname: STATUS_PATH,
      status: 200,
      body: responseBody,
      key: VECTOR_KEY,
      cryptoApi: webcrypto,
    }),
    "1RJN_K7ENzIreR9RjulByZ5J4LGeOEu8qFOcLuJaSyE",
  );

  const notFoundBody = createMcpJobNotFoundBody();
  assert.equal(
    notFoundBody,
    '{"apiVersion":1,"error":{"code":"job_not_found","message":"The requested Zotero bridge job was not found.","retryable":false}}',
  );
  assert.equal(
    await createMcpAuthResponseSignature({
      timestamp: VECTOR_TIMESTAMP,
      nonce: VECTOR_NONCE,
      method: "POST",
      pathname: STATUS_PATH,
      status: 404,
      body: notFoundBody,
      key: VECTOR_KEY,
      cryptoApi: webcrypto,
    }),
    "C0624VScuPMXb4uXxnsCReQ7e6RiOT5aSHJjxAUqJtA",
  );
});
