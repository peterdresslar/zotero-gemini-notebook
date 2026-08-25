import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controlServerSource = await readFile(
  new globalThis.URL("../src/modules/mcpControlServer.ts", import.meta.url),
  "utf8",
);
const hooksSource = await readFile(
  new globalThis.URL("../src/hooks.ts", import.meta.url),
  "utf8",
);
const jobProtocolSource = await readFile(
  new globalThis.URL(
    "../src/modules/mcpJobControlProtocol.js",
    import.meta.url,
  ),
  "utf8",
);
const jobStatusProtocolSource = await readFile(
  new globalThis.URL("../src/modules/mcpJobStatusProtocol.js", import.meta.url),
  "utf8",
);

test("registers only the three narrow authenticated local MCP control endpoints", () => {
  assert.match(controlServerSource, /"\/notebooklm\/control\/v1\/auth-check"/u);
  assert.match(controlServerSource, /"\/notebooklm\/control\/v1\/jobs"/u);
  assert.match(
    controlServerSource,
    /"\/notebooklm\/control\/v1\/jobs\/status"/u,
  );
  assert.equal(
    controlServerSource.match(/supportedMethods: \["POST"\]/gu)?.length,
    3,
  );
  assert.match(
    controlServerSource,
    /supportedDataTypes: \[MCP_JOB_STATUS_CONTENT_TYPE\]/u,
  );
  assert.match(
    controlServerSource,
    /delete endpoints\[MCP_CONTROL_JOB_STATUS_PATH\]/u,
  );
  assert.doesNotMatch(controlServerSource, /control\/v1\/info/u);
  assert.doesNotMatch(
    controlServerSource,
    /supportedMethods: \[[^\]]*(?:GET|OPTIONS)/u,
  );
  assert.doesNotMatch(
    controlServerSource,
    /getStaged|claimStaged|stageSelected|cancelJob|transitionJob/u,
  );
});

test("create-job uses a bounded raw vendor body and authenticates before parsing", () => {
  assert.match(
    jobProtocolSource,
    /application\/vnd\.zotero-gemini-notebook\.job\+json/u,
  );
  assert.match(jobProtocolSource, /16 \* 1024/u);
  assert.match(controlServerSource, /readInputStreamToString/u);
  assert.match(controlServerSource, /rawBinaryStringToBytes/u);
  assert.match(controlServerSource, /readMcpCreateJobContentLength/u);

  const handlerStart = controlServerSource.indexOf(
    "async function handleMcpControlCreateJob",
  );
  const handlerEnd = controlServerSource.indexOf(
    "function validateRequestEnvelope",
    handlerStart,
  );
  const handler = controlServerSource.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(
    handler.indexOf("readMcpRawRequestBody") <
      handler.indexOf("verifyMcpAuthRequest"),
  );
  assert.ok(
    handler.indexOf("verifyMcpAuthRequest") <
      handler.indexOf("parseCanonicalCreateJobBody"),
  );
  assert.ok(
    handler.indexOf("parseCanonicalCreateJobBody") <
      handler.indexOf("createJob(input)"),
  );
  assert.ok(
    handler.indexOf("createMcpCreateJobSuccessBody") <
      handler.indexOf("createMcpAuthResponseSignature"),
  );
});

test("create-job forces active-or-new, non-replacement input and returns an allowlisted job DTO", () => {
  assert.match(jobProtocolSource, /document\.replace !== false/u);
  assert.match(jobProtocolSource, /document\.destination !== "active-or-new"/u);
  assert.match(
    jobProtocolSource,
    /hasOwnProperty\.call\(document, "requestId"\)/u,
  );
  assert.match(jobProtocolSource, /MCP_CREATE_JOB_MAX_ITEM_KEYS = 256/u);
  assert.match(jobProtocolSource, /jobId: job\.jobId/u);
  assert.match(jobProtocolSource, /createdAt: job\.createdAt/u);
  assert.match(jobProtocolSource, /updatedAt: job\.updatedAt/u);
  assert.match(jobProtocolSource, /expiresAt: job\.expiresAt/u);
  assert.doesNotMatch(
    jobProtocolSource.slice(
      jobProtocolSource.indexOf("createMcpCreateJobSuccessBody"),
      jobProtocolSource.indexOf("export function canonicalJsonStringify"),
    ),
    /job\.(?:source|destination|origin|details|items|filePath)/u,
  );
});

test("job-status authenticates a bounded raw vendor body before reading the job", () => {
  assert.match(
    jobStatusProtocolSource,
    /application\/vnd\.zotero-gemini-notebook\.job-status\+json/u,
  );
  assert.match(jobStatusProtocolSource, /MAX_BODY_BYTES = 256/u);
  assert.match(controlServerSource, /readMcpJobStatusContentLength/u);
  assert.match(controlServerSource, /parseCanonicalJobStatusBody/u);

  const handlerStart = controlServerSource.indexOf(
    "async function handleMcpControlJobStatus",
  );
  const handlerEnd = controlServerSource.indexOf(
    "function validateRequestEnvelope",
    handlerStart,
  );
  const handler = controlServerSource.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(
    handler.indexOf("readMcpRawRequestBody") <
      handler.indexOf("verifyMcpAuthRequest"),
  );
  assert.ok(
    handler.indexOf("verifyMcpAuthRequest") <
      handler.indexOf("parseCanonicalJobStatusBody"),
  );
  assert.ok(
    handler.indexOf("parseCanonicalJobStatusBody") <
      handler.indexOf("getJob(input.jobId)"),
  );
  const successBodyIndex = handler.indexOf("createMcpJobStatusSuccessBody");
  assert.ok(successBodyIndex >= 0);
  assert.ok(
    successBodyIndex <
      handler.indexOf("createMcpAuthResponseSignature", successBodyIndex),
  );
});

test("job-status returns only the signed allowlisted DTO or a fixed not-found error", () => {
  assert.match(
    jobStatusProtocolSource,
    /return createMcpCreateJobSuccessBody\(job\)/u,
  );
  assert.match(
    jobStatusProtocolSource,
    /"code":"job_not_found","message":"The requested Zotero bridge job was not found\.","retryable":false/u,
  );
  assert.match(
    controlServerSource,
    /pathname: MCP_CONTROL_JOB_STATUS_PATH,\s*status: 200,\s*body: responseBody/u,
  );
  assert.match(
    controlServerSource,
    /createMcpJobNotFoundBody\(\)[\s\S]*pathname: MCP_CONTROL_JOB_STATUS_PATH,[\s\S]*status: 404,[\s\S]*MCP_AUTH_RESPONSE_SIGNATURE_HEADER/u,
  );
  assert.doesNotMatch(
    jobStatusProtocolSource,
    /job\.(?:source|origin|destination|details|requestId|items|filePath)/u,
  );
});

test("maps create-job failures only from stable typed codes to fixed DTOs", () => {
  const mapperStart = controlServerSource.indexOf(
    "function createJobErrorResponse",
  );
  const mapperEnd = controlServerSource.indexOf(
    "function createJobProtocolErrorResponse",
    mapperStart,
  );
  const mapper = controlServerSource.slice(mapperStart, mapperEnd);
  assert.ok(mapperStart >= 0 && mapperEnd > mapperStart);
  for (const code of [
    "PENDING_JOB_EXISTS",
    "IDEMPOTENCY_CONFLICT",
    "LIBRARY_NOT_FOUND",
    "COLLECTION_NOT_FOUND",
    "NO_SUPPORTED_ATTACHMENTS",
    "SOURCE_LIMIT_EXCEEDED",
  ]) {
    assert.match(mapper, new RegExp(`hasErrorCode\\(error, "${code}"\\)`, "u"));
  }
  assert.match(mapper, /status: 400,\s*code: "no_supported_attachments"/u);
  assert.match(mapper, /status: 400,\s*code: "source_limit_exceeded"/u);
  assert.doesNotMatch(mapper, /status: (?:413|422)/u);
  assert.doesNotMatch(controlServerSource, /status: (?:413|422)/u);
  assert.doesNotMatch(mapper, /error\.message|readErrorMessage/u);
});

test("keeps control responses private, uncached, and does not opt into CORS", () => {
  assert.match(controlServerSource, /"Cache-Control": "no-store"/u);
  assert.match(controlServerSource, /PRIVATE_RESPONSE_OPTIONS/u);
  assert.match(
    controlServerSource,
    /allowRequestsFromUnsafeWebContent: false/u,
  );
  assert.doesNotMatch(controlServerSource, /Access-Control-Allow/u);
});

test("auth-check verifies only the fixed empty JSON request with the local key", () => {
  assert.match(controlServerSource, /const MCP_AUTH_BODY = "\{\}"/u);
  assert.match(
    controlServerSource,
    /readHeader\(request\.headers, "content-type"\) !== MCP_AUTH_CONTENT_TYPE/u,
  );
  assert.match(
    controlServerSource,
    /readHeader\(request\.headers, "content-length"\)/u,
  );
  assert.match(
    controlServerSource,
    /hasMcpQueryParameters\(request\.searchParams\)/u,
  );
  assert.match(controlServerSource, /readMcpLocalAuthorizationKey\(\)/u);
  assert.match(controlServerSource, /verifyMcpAuthRequest\(\{/u);
  assert.match(controlServerSource, /createMcpAuthResponseSignature\(\{/u);
  assert.match(controlServerSource, /MCP_AUTH_RESPONSE_SIGNATURE_HEADER/u);
  assert.match(controlServerSource, /createMcpAuthReplayCache\(\{/u);
  assert.match(controlServerSource, /key\.fill\(0\)/u);
  assert.ok(
    controlServerSource.indexOf("createMcpAuthResponseSignature({") <
      controlServerSource.indexOf("key.fill(0)"),
  );
});

test("hooks register endpoints once startup is ready and remove them on shutdown", () => {
  assert.match(hooksSource, /registerMcpControlEndpoints\(\)/u);
  assert.match(hooksSource, /unregisterMcpControlEndpoints\(\)/u);
  assert.ok(
    hooksSource.indexOf("registerMcpControlEndpoints()") >
      hooksSource.indexOf("await Promise.all"),
  );
});
