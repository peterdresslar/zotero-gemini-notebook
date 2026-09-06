import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import * as jobInput from "../src/modules/bridgeJobInput.js";
import * as jobPolicy from "../src/modules/bridgeJobPolicy.js";
import * as jobEvents from "../src/modules/chromeJobEventState.js";
import * as serverContract from "../src/modules/zoteroServerContract.js";
import { createBridgeJobStore } from "../src/modules/bridgeJobStore.js";
import {
  canonicalJsonStringify,
  createMcpCreateJobSuccessBody,
  parseCanonicalCreateJobBody,
} from "../src/modules/mcpJobControlProtocol.js";

const encoder = new globalThis.TextEncoder();
const prompt =
  '  Compare café studies — 蜜蜂 🎧.\nExplain "uncertainty"\twith care.  ';
const request = {
  destination: "active-or-new",
  itemKeys: ["AAAA1111"],
  libraryID: 1,
  replace: false,
  requestId: "studio-1",
};
const item = {
  itemId: 1,
  attachmentId: 101,
  title: "Example study",
  creators: "Example author",
  year: "2026",
  fileName: "example.pdf",
  contentType: "application/pdf",
};

test("preserves optional Studio text and rejects malformed or oversized values", () => {
  assert.equal(
    "studioPrompt" in jobInput.normalizeCreateBridgeJobInput(request),
    false,
  );
  assert.equal(jobInput.normalizeStudioPrompt(prompt), prompt);
  assert.equal(jobInput.normalizeStudioPrompt("é".repeat(2000)).length, 2000);
  for (const value of [
    null,
    false,
    123,
    {},
    "",
    " \t\r\n",
    "\ufeff",
    "\u2000",
    "x".repeat(4001),
    "é".repeat(2001),
    "🎧".repeat(1001),
    "bad\u0000text",
    "bad\u000btext",
    "bad\u001ftext",
    "bad\u007ftext",
    "bad\ud800text",
    "bad\udffftext",
  ]) {
    assert.throws(
      () =>
        jobInput.normalizeCreateBridgeJobInput({
          ...request,
          studioPrompt: value,
        }),
      /studioPrompt/,
    );
  }
});

test("matches Python ASCII-escaped canonical JSON for Studio Unicode and newlines", () => {
  // Exact json.dumps(..., ensure_ascii=True, separators=(",", ":"), sort_keys=True).
  const studioPrompt = 'café 🎧\n"quote"\\\t\r蜜';
  const body = String.raw`{"destination":"active-or-new","itemKeys":["AAAA1111"],"libraryID":1,"replace":false,"requestId":"studio-1","studioPrompt":"caf\u00e9 \ud83c\udfa7\n\"quote\"\\\t\r\u871c"}`;
  assert.equal(canonicalJsonStringify({ ...request, studioPrompt }), body);
  assert.equal(
    parseCanonicalCreateJobBody(encoder.encode(body)).studioPrompt,
    studioPrompt,
  );
  assert.throws(() =>
    parseCanonicalCreateJobBody(encoder.encode(body.replace("\\u00e9", "é"))),
  );
  assert.throws(() =>
    parseCanonicalCreateJobBody(
      encoder.encode(body.replace("\\u00e9", "\\u00E9")),
    ),
  );
});

test("maximum Studio text still fits the existing request bound with 256 item keys", () => {
  const input = {
    ...request,
    requestId: "r".repeat(128),
    itemKeys: Array.from({ length: 256 }, (_, index) =>
      index.toString(36).toUpperCase().padStart(8, "0"),
    ).sort(),
    studioPrompt: "é".repeat(2000),
  };
  const body = encoder.encode(canonicalJsonStringify(input));
  assert.ok(body.byteLength <= 16_384);
  assert.equal(
    parseCanonicalCreateJobBody(body).studioPrompt,
    input.studioPrompt,
  );
});

async function loadModule(relativePath, dependencies, globals = {}) {
  const source = await readFile(
    new globalThis.URL(relativePath, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  });
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(specifier) {
      assert.ok(
        Object.hasOwn(dependencies, specifier),
        `Unexpected dependency ${specifier}`,
      );
      return dependencies[specifier];
    },
    ...globals,
  });
  return exports;
}

async function createHarness() {
  let timestamp = Date.now();
  let nextId = 0;
  let resolutionCount = 0;
  const store = createBridgeJobStore({
    now: () => timestamp,
    createId: () => `job-${++nextId}`,
  });
  const Zotero = {
    Server: { Endpoints: {} },
    Libraries: { exists: () => true },
    Items: {
      getByLibraryAndKeyAsync: async () => {
        resolutionCount += 1;
        return { isRegularItem: () => true };
      },
    },
  };
  const jobs = await loadModule(
    "../src/modules/bridgeJobs.ts",
    {
      "./bridgeJobStore.js": { bridgeJobStore: store },
      "./bridgeJobInput.js": jobInput,
      "./bridgeJobPolicy.js": jobPolicy,
      "./chromeJobEventState.js": jobEvents,
      "./items": {
        toSizedStagedItem: async () => ({ stagedItem: item, byteSize: 100 }),
      },
    },
    { Zotero },
  );
  const staging = await loadModule("../src/modules/staging.ts", {
    "./bridgeJobStore.js": { bridgeJobStore: store },
  });
  const server = await loadModule(
    "../src/modules/server.ts",
    {
      "../../package.json": {
        companionCompatibility: { validVersions: ["0.4.1"] },
      },
      "./staging": staging,
      "../utils/file": {},
      "../utils/fileName.js": {},
      "../utils/prefs": {},
      "../utils/attachment": {},
      "./zoteroServerContract.js": serverContract,
    },
    { Zotero },
  );
  server.registerEndpoints();
  return {
    jobs,
    store,
    expire() {
      timestamp = store.getActiveJob().expiresAt + 1;
    },
    get resolutionCount() {
      return resolutionCount;
    },
    pending() {
      let result;
      const endpoint = new Zotero.Server.Endpoints["/notebooklm/pending"]();
      endpoint.init({}, (status, contentType, body, options) => {
        assert.equal(status, 200);
        assert.equal(contentType, "application/json");
        assert.equal(options.logFilter(body).includes(prompt), false);
        result = JSON.parse(body);
      });
      return result;
    },
  };
}

test("carries prompt through job creation into pending only and binds exact retries", async () => {
  const h = await createHarness();
  const input = parseCanonicalCreateJobBody(
    encoder.encode(
      canonicalJsonStringify({ ...request, studioPrompt: prompt }),
    ),
  );
  const job = await h.jobs.createJob(input);
  assert.equal(h.pending().studioPrompt, prompt);
  assert.equal(h.pending().jobId, job.jobId);
  assert.deepEqual(h.pending().items, [item]);
  assert.equal("studioPrompt" in job, false);
  assert.equal("studioPrompt" in h.jobs.getJob(job.jobId), false);
  assert.equal(
    createMcpCreateJobSuccessBody({ ...job, studioPrompt: prompt }).includes(
      "studioPrompt",
    ),
    false,
  );
  assert.deepEqual(await h.jobs.createJob(input), job);
  assert.equal(h.resolutionCount, 1);

  for (const changed of [
    { ...input, studioPrompt: "A different angle." },
    request,
  ]) {
    await assert.rejects(h.jobs.createJob(changed), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    assert.equal(h.pending().studioPrompt, prompt);
  }
  assert.equal(h.resolutionCount, 1);
  const claimed = h.store.claimActive(job.jobId);
  assert.equal("studioPrompt" in h.pending(), false);
  assert.equal(h.store.getPendingStudioPrompt(job.jobId), undefined);
  assert.deepEqual(await h.jobs.createJob(input), claimed);
  assert.equal("studioPrompt" in h.pending(), false);
});

test("omits prompts for ordinary jobs and clears visibility on expiry, cancellation, or replacement", async () => {
  for (const end of ["expire", "cancel", "replace", "reset"]) {
    const h = await createHarness();
    assert.equal(h.store.getPendingStudioPrompt(), undefined);
    const job = await h.jobs.createJob({ ...request, studioPrompt: prompt });
    assert.equal(h.store.getPendingStudioPrompt("another-job"), undefined);
    if (end === "expire") h.expire();
    if (end === "cancel") h.jobs.cancelJob(job.jobId);
    if (end === "replace") {
      await h.jobs.createJob({
        ...request,
        requestId: "ordinary",
        replace: true,
      });
      assert.equal(h.pending().count, 1);
    }
    if (end === "reset") h.store.reset();
    assert.equal("studioPrompt" in h.pending(), false);
  }
});
