import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(
  new globalThis.URL("../src/modules/chromeJobEventServer.ts", import.meta.url),
  "utf8",
);
const hooksSource = await readFile(
  new globalThis.URL("../src/hooks.ts", import.meta.url),
  "utf8",
);
const bridgeJobsSource = await readFile(
  new globalThis.URL("../src/modules/bridgeJobs.ts", import.meta.url),
  "utf8",
);

test("registers only narrow POST-only browser claim and event endpoints", () => {
  assert.match(serverSource, /"\/notebooklm\/job-claim"/u);
  assert.match(serverSource, /"\/notebooklm\/job-event"/u);
  assert.equal(serverSource.match(/supportedMethods: \["POST"\]/gu)?.length, 2);
  assert.doesNotMatch(
    serverSource,
    /supportedMethods: \[[^\]]*(?:GET|OPTIONS)/u,
  );
  assert.equal(
    serverSource.match(/allowRequestsFromUnsafeWebContent: false/gu)?.length,
    2,
  );
  assert.doesNotMatch(serverSource, /Access-Control-Allow/u);
});

test("uses one-argument raw handlers with strict browser request envelopes", () => {
  assert.match(
    serverSource,
    /async function handleChromeJobClaim\(\s*request: ChromeJobLifecycleRequest,\s*\)/u,
  );
  assert.match(
    serverSource,
    /async function handleChromeJobEvent\(\s*request: ChromeJobLifecycleRequest,\s*\)/u,
  );
  assert.match(serverSource, /readInputStreamToString/u);
  assert.match(serverSource, /readChromeJobClaimContentLength/u);
  assert.match(serverSource, /readChromeJobEventContentLength/u);
  assert.match(
    serverSource,
    /readSingleHeader\(request\?\.headers, "zotero-allowed-request"\) !== "1"/u,
  );
  assert.match(serverSource, /hasQueryParameters\(request\.searchParams\)/u);
  assert.match(
    serverSource,
    /hasHeader\(request\.headers, "content-encoding"\)/u,
  );
  assert.match(
    serverSource,
    /hasHeader\(request\.headers, "transfer-encoding"\)/u,
  );
  assert.doesNotMatch(serverSource, /HMAC|authorization key|readMcpLocal/u);
});

test("claims and reports only canonical claimant-bound DTOs", () => {
  assert.match(
    serverSource,
    /claimStagedJob\(\s*input\.jobId,\s*\[\.\.\.input\.attachmentIds\],\s*input\.claimId,/u,
  );
  assert.match(
    serverSource,
    /reportChromeJobEvent\(input\.jobId, input\.claimId, input\.event\)/u,
  );
  assert.match(
    serverSource,
    /claimId: input\.claimId,\s*jobId: input\.jobId,\s*state: "claimed",/u,
  );
  assert.match(serverSource, /jsonTextResponse\(200, '\{"accepted":true\}'\)/u);
  assert.match(
    serverSource,
    /fixedErrorResponse\(\s*409,\s*"job_claim_conflict"/u,
  );
  assert.match(
    serverSource,
    /fixedErrorResponse\(\s*409,\s*"job_event_conflict"/u,
  );
  assert.doesNotMatch(serverSource, /error\.message|String\(error\)/u);
});

test("keeps lifecycle responses private, uncached, and explicitly unregisters", () => {
  assert.match(serverSource, /"Cache-Control": "no-store"/u);
  assert.match(serverSource, /Pragma: "no-cache"/u);
  assert.match(serverSource, /PRIVATE_RESPONSE_OPTIONS/u);
  for (const name of [
    "registerChromeJobClaimEndpoint",
    "registerChromeJobEventEndpoint",
    "unregisterChromeJobClaimEndpoint",
    "unregisterChromeJobEventEndpoint",
  ]) {
    assert.match(hooksSource, new RegExp(`${name}\\(\\)`, "u"));
  }
});

test("does not advertise browser lifecycle reporting on the public bridge API", () => {
  const apiStart = bridgeJobsSource.indexOf("export const bridgeApi");
  const apiEnd = bridgeJobsSource.indexOf("async function resolveItemKeys");
  const publicApi = bridgeJobsSource.slice(apiStart, apiEnd);
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  assert.doesNotMatch(publicApi, /reportChromeJobEvent/u);
});
