import assert from "node:assert/strict";
import test from "node:test";

import {
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
