import assert from "node:assert/strict";
import test from "node:test";

import {
  clearStagedJob,
  createStagedClearRequest,
  createStagedFileRequest,
  STAGED_CLEAR_METHOD,
} from "../chrome-extension/bridge-requests.js";

test("uses the POST method supported by Zotero's local server", () => {
  assert.equal(STAGED_CLEAR_METHOD, "POST");
});

test("binds file reads to a job when the Zotero backend supplies one", () => {
  assert.deepEqual(createStagedFileRequest(42, "job-1"), {
    attachmentId: 42,
    jobId: "job-1",
  });
  assert.deepEqual(createStagedFileRequest(42, null), { attachmentId: 42 });
});

test("binds clear to the loaded job and exact selected subset", () => {
  assert.deepEqual(createStagedClearRequest("job-1", [42, 43]), {
    jobId: "job-1",
    attachmentIds: [42, 43],
  });
  assert.equal(createStagedClearRequest(null, [42]), null);
});

test("rejects malformed job-bound requests", () => {
  assert.throws(() => createStagedFileRequest(0, "job-1"), /positive integer/);
  assert.throws(() => createStagedFileRequest(42, " "), /nonempty string/);
  assert.throws(() => createStagedClearRequest("job-1", []), /requires/);
  assert.throws(() => createStagedClearRequest("job-1", [42, 42]), /unique/);
});

test("sends a job-bound clear with the selected attachment IDs", async () => {
  const calls = [];
  const response = { ok: true };
  const result = await clearStagedJob({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response;
    },
    url: "http://127.0.0.1:23119/notebooklm/clear",
    headers: { "Content-Type": "application/json" },
    jobId: "job-1",
    attachmentIds: [42, 43],
  });

  assert.equal(result, response);
  assert.deepEqual(calls, [
    [
      "http://127.0.0.1:23119/notebooklm/clear",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-1", attachmentIds: [42, 43] }),
      },
    ],
  ]);
});

test("sends an empty clear request when the pending response has no job ID", async () => {
  let requestOptions;
  await clearStagedJob({
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return { ok: true };
    },
    url: "http://127.0.0.1:23119/notebooklm/clear",
    headers: {},
    jobId: null,
    attachmentIds: [42],
  });

  assert.equal(requestOptions.body, "{}");
});

test("surfaces clear transport and response failures", async () => {
  await assert.rejects(
    clearStagedJob({
      fetchImpl: async () => ({ ok: false }),
      url: "http://127.0.0.1:23119/notebooklm/clear",
      headers: {},
      jobId: "job-1",
      attachmentIds: [42],
    }),
    /could not finalize/,
  );

  await assert.rejects(
    clearStagedJob({
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
      url: "http://127.0.0.1:23119/notebooklm/clear",
      headers: {},
      jobId: "job-1",
      attachmentIds: [42],
    }),
    /network unavailable/,
  );
});
