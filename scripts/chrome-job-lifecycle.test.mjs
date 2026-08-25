import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_CLAIM_CONTENT_TYPE as CHROME_CLAIM_CONTENT_TYPE,
  JOB_LIFECYCLE_CONTENT_TYPE as CHROME_EVENT_CONTENT_TYPE,
  createJobClaimBody,
  createJobLifecycleBody,
} from "../chrome-extension/job-lifecycle.js";
import {
  CHROME_JOB_CLAIM_CONTENT_TYPE,
  CHROME_JOB_CLAIM_MAX_ATTACHMENTS,
  CHROME_JOB_CLAIM_MAX_BODY_BYTES,
  ChromeJobClaimProtocolError,
  parseCanonicalChromeJobClaimBody,
  rawChromeJobClaimBodyToBytes,
  readChromeJobClaimContentLength,
} from "../src/modules/chromeJobClaimProtocol.js";
import {
  CHROME_JOB_EVENT_CONTENT_TYPE,
  CHROME_JOB_EVENT_MAX_BODY_BYTES,
  ChromeJobEventProtocolError,
  parseCanonicalChromeJobEventBody,
  rawChromeJobEventBodyToBytes,
  readChromeJobEventContentLength,
} from "../src/modules/chromeJobEventProtocol.js";
import {
  ChromeJobEventConflictError,
  reportChromeJobEventToStore,
} from "../src/modules/chromeJobEventState.js";
import { createBridgeJobStore } from "../src/modules/bridgeJobStore.js";

const encoder = new globalThis.TextEncoder();
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLAIM_ID = "tab.claim-1:1787558400";

function stagedItem(id) {
  return {
    itemId: id,
    title: `Source ${id}`,
    creators: "Example",
    year: "2026",
    attachmentId: id + 100,
    contentType: "application/pdf",
    fileName: `source-${id}.pdf`,
  };
}

function createStore(
  items = [stagedItem(1), stagedItem(2)],
  { now = () => 1_787_558_400_000 } = {},
) {
  const store = createBridgeJobStore({
    now,
    createId: () => JOB_ID,
  });
  const staged = store.activate({
    items,
    origin: "agent",
    source: { type: "items", libraryID: 1, itemKeys: ["AAAA1111"] },
    destination: "new",
    skippedCount: 0,
  });
  return { staged, store };
}

function expectProtocolError(ExpectedError) {
  return (error) => {
    assert.ok(error instanceof ExpectedError);
    return true;
  };
}

function expectEventConflict(error) {
  assert.ok(error instanceof ChromeJobEventConflictError);
  assert.equal(error.code, "CHROME_JOB_EVENT_CONFLICT");
  return true;
}

test("publishes narrow raw browser lifecycle representations and bounds", () => {
  assert.equal(
    CHROME_JOB_CLAIM_CONTENT_TYPE,
    "application/vnd.zotero-gemini-notebook.job-claim+json",
  );
  assert.equal(CHROME_JOB_CLAIM_MAX_BODY_BYTES, 4096);
  assert.equal(CHROME_JOB_CLAIM_MAX_ATTACHMENTS, 50);
  assert.equal(
    CHROME_JOB_EVENT_CONTENT_TYPE,
    "application/vnd.zotero-gemini-notebook.job-event+json",
  );
  assert.equal(CHROME_JOB_EVENT_MAX_BODY_BYTES, 1024);
  assert.equal(CHROME_CLAIM_CONTENT_TYPE, CHROME_JOB_CLAIM_CONTENT_TYPE);
  assert.equal(CHROME_EVENT_CONTENT_TYPE, CHROME_JOB_EVENT_CONTENT_TYPE);
});

test("accepts the exact Chrome-generated cross-boundary request vectors", () => {
  const claimBody = createJobClaimBody(JOB_ID, CLAIM_ID, [102, 101]);
  assert.equal(
    claimBody,
    `{"attachmentIds":[101,102],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
  );
  assert.deepEqual(
    parseCanonicalChromeJobClaimBody(encoder.encode(claimBody)),
    {
      attachmentIds: [101, 102],
      claimId: CLAIM_ID,
      jobId: JOB_ID,
    },
  );

  const eventBody = createJobLifecycleBody(JOB_ID, CLAIM_ID, "submitted");
  assert.equal(
    eventBody,
    `{"claimId":"${CLAIM_ID}","event":"submitted","jobId":"${JOB_ID}"}`,
  );
  assert.deepEqual(
    parseCanonicalChromeJobEventBody(encoder.encode(eventBody)),
    {
      claimId: CLAIM_ID,
      event: "submitted",
      jobId: JOB_ID,
    },
  );
});

test("parses the exact canonical claimant-bound claim request", () => {
  const body = `{"attachmentIds":[101,102],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`;
  assert.deepEqual(parseCanonicalChromeJobClaimBody(encoder.encode(body)), {
    attachmentIds: [101, 102],
    claimId: CLAIM_ID,
    jobId: JOB_ID,
  });
});

test("parses each exact canonical claimant-bound lifecycle event", () => {
  for (const event of [
    "submitted",
    "verifying",
    "verified",
    "unverified",
    "failed",
  ]) {
    const body = `{"claimId":"${CLAIM_ID}","event":"${event}","jobId":"${JOB_ID}"}`;
    assert.deepEqual(parseCanonicalChromeJobEventBody(encoder.encode(body)), {
      claimId: CLAIM_ID,
      event,
      jobId: JOB_ID,
    });
  }
});

test("rejects noncanonical, malformed, or unsafe claim documents", () => {
  const tooManyIds = Array.from(
    { length: CHROME_JOB_CLAIM_MAX_ATTACHMENTS + 1 },
    (_, index) => index + 1,
  );
  const cases = [
    `{"claimId":"${CLAIM_ID}","attachmentIds":[101],"jobId":"${JOB_ID}"}`,
    `{ "attachmentIds":[101],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[102,101],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[101,101],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[0],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[101],"claimId":"bad/claim","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[101],"claimId":"${"a".repeat(129)}","jobId":"${JOB_ID}"}`,
    `{"attachmentIds":[101],"claimId":"${CLAIM_ID}","jobId":"wrong"}`,
    `{"attachmentIds":[101],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}","extra":true}`,
    JSON.stringify({
      attachmentIds: tooManyIds,
      claimId: CLAIM_ID,
      jobId: JOB_ID,
    }),
  ];

  for (const body of cases) {
    assert.throws(
      () => parseCanonicalChromeJobClaimBody(encoder.encode(body)),
      expectProtocolError(ChromeJobClaimProtocolError),
    );
  }
  assert.throws(
    () => parseCanonicalChromeJobClaimBody(Uint8Array.of(0xc3, 0x28)),
    expectProtocolError(ChromeJobClaimProtocolError),
  );
});

test("rejects noncanonical, malformed, or unsafe event documents", () => {
  const cases = [
    `{"event":"submitted","claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
    `{ "claimId":"${CLAIM_ID}","event":"submitted","jobId":"${JOB_ID}"}`,
    `{"claimId":"bad/claim","event":"submitted","jobId":"${JOB_ID}"}`,
    `{"claimId":"${CLAIM_ID}","event":"cancelled","jobId":"${JOB_ID}"}`,
    `{"claimId":"${CLAIM_ID}","event":"submitted","jobId":"wrong"}`,
    `{"claimId":"${CLAIM_ID}","event":"submitted","jobId":"${JOB_ID}","extra":true}`,
    `{"claimId":"${CLAIM_ID}","event":"submitted","event":"submitted","jobId":"${JOB_ID}"}`,
  ];

  for (const body of cases) {
    assert.throws(
      () => parseCanonicalChromeJobEventBody(encoder.encode(body)),
      expectProtocolError(ChromeJobEventProtocolError),
    );
  }
  assert.throws(
    () => parseCanonicalChromeJobEventBody(Uint8Array.of(0xc3, 0x28)),
    expectProtocolError(ChromeJobEventProtocolError),
  );
});

test("requires exact canonical Content-Length values for both endpoints", () => {
  assert.equal(readChromeJobClaimContentLength({ "content-length": "1" }), 1);
  assert.equal(
    readChromeJobClaimContentLength({ "Content-Length": "4096" }),
    4096,
  );
  assert.equal(readChromeJobEventContentLength({ "content-length": "1" }), 1);
  assert.equal(
    readChromeJobEventContentLength({ "Content-Length": "1024" }),
    1024,
  );

  for (const headers of [
    {},
    { "content-length": "0" },
    { "content-length": "01" },
    { "content-length": "4097" },
    { "content-length": "1.0" },
    { "content-length": 1 },
    { "content-length": "1", "Content-Length": "1" },
  ]) {
    assert.throws(
      () => readChromeJobClaimContentLength(headers),
      expectProtocolError(ChromeJobClaimProtocolError),
    );
  }
  for (const headers of [
    {},
    { "content-length": "0" },
    { "content-length": "01" },
    { "content-length": "1025" },
    { "content-length": "1.0" },
    { "content-length": 1 },
    { "content-length": "1", "Content-Length": "1" },
  ]) {
    assert.throws(
      () => readChromeJobEventContentLength(headers),
      expectProtocolError(ChromeJobEventProtocolError),
    );
  }
});

test("converts only exact raw binary strings to lifecycle body bytes", () => {
  assert.deepEqual(
    rawChromeJobClaimBodyToBytes("\u0000\u00ffA", 3),
    Uint8Array.of(0, 255, 65),
  );
  assert.deepEqual(
    rawChromeJobEventBodyToBytes("\u0000\u00ffA", 3),
    Uint8Array.of(0, 255, 65),
  );
  assert.throws(
    () => rawChromeJobClaimBodyToBytes("AB", 3),
    expectProtocolError(ChromeJobClaimProtocolError),
  );
  assert.throws(
    () => rawChromeJobEventBodyToBytes("\u0100", 1),
    expectProtocolError(ChromeJobEventProtocolError),
  );
});

test("binds the first claimant and makes an exact lost-response retry idempotent", () => {
  const { staged, store } = createStore();
  const first = store.claimActive(staged.jobId, [101, 102], CLAIM_ID);
  const retry = store.claimActive(staged.jobId, [101, 102], CLAIM_ID);

  assert.equal(first.state, "claimed");
  assert.deepEqual(retry, first);
  assert.equal(store.claimActive(staged.jobId, [101, 102], "other-tab"), null);
  assert.equal(store.claimActive(staged.jobId, [101], CLAIM_ID), null);
  assert.equal(store.claimActive(staged.jobId, [101, 102]), null);
  assert.equal(store.hasPendingAttachment(101, staged.jobId), true);
  assert.equal(store.hasPendingAttachment(102, staged.jobId), true);
});

test("preserves legacy no-claimId behavior without allowing later claimant binding", () => {
  const { staged, store } = createStore([stagedItem(1)]);
  const claimed = store.claimActive(staged.jobId, [101]);

  assert.equal(claimed.state, "claimed");
  assert.deepEqual(store.claimActive(staged.jobId, [101]), claimed);
  assert.equal(store.claimActive(staged.jobId, [101], CLAIM_ID), null);
  assert.throws(
    () =>
      reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "submitted"),
    expectEventConflict,
  );
});

test("reports claimant-bound verification events in strict order", () => {
  let timestamp = 1_787_558_400_000;
  const { staged, store } = createStore([stagedItem(1)], {
    now: () => timestamp,
  });

  assert.throws(
    () =>
      reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "submitted"),
    expectEventConflict,
  );
  assert.equal(store.getJob(staged.jobId).state, "staged");

  store.claimActive(staged.jobId, [101], CLAIM_ID);

  for (const event of ["verifying", "verified"]) {
    assert.throws(
      () => reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, event),
      expectEventConflict,
    );
  }
  assert.throws(
    () =>
      reportChromeJobEventToStore(
        store,
        staged.jobId,
        "other-tab",
        "submitted",
      ),
    expectEventConflict,
  );
  timestamp += 1_000;
  const submitted = reportChromeJobEventToStore(
    store,
    staged.jobId,
    CLAIM_ID,
    "submitted",
  );
  assert.equal(submitted.state, "submitted");
  timestamp += 1_000;
  assert.deepEqual(
    reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "submitted"),
    submitted,
  );
  for (const event of ["verified", "unverified", "failed"]) {
    assert.throws(
      () => reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, event),
      expectEventConflict,
    );
  }

  timestamp += 1_000;
  const verifying = reportChromeJobEventToStore(
    store,
    staged.jobId,
    CLAIM_ID,
    "verifying",
  );
  assert.equal(verifying.state, "verifying");
  assert.equal(verifying.details, undefined);
  timestamp += 1_000;
  assert.deepEqual(
    reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "verifying"),
    verifying,
  );
  for (const event of ["submitted", "failed"]) {
    assert.throws(
      () => reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, event),
      expectEventConflict,
    );
  }

  timestamp += 1_000;
  const verified = reportChromeJobEventToStore(
    store,
    staged.jobId,
    CLAIM_ID,
    "verified",
  );
  assert.equal(verified.state, "verified");
  assert.equal(verified.details, undefined);
  timestamp += 1_000;
  assert.deepEqual(
    reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "verified"),
    verified,
  );
  assert.throws(
    () =>
      reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "unverified"),
    expectEventConflict,
  );
  assert.deepEqual(store.getJob(staged.jobId), verified);
});

test("records an inconclusive verification only after verifying", () => {
  const { staged, store } = createStore([stagedItem(1)]);
  store.claimActive(staged.jobId, [101], CLAIM_ID);
  reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "submitted");
  reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "verifying");

  const unverified = reportChromeJobEventToStore(
    store,
    staged.jobId,
    CLAIM_ID,
    "unverified",
  );
  assert.equal(unverified.state, "unverified");
  assert.deepEqual(unverified.details, {
    code: "chrome_upload_unverified",
    message:
      "Chrome could not confirm that Gemini Notebook accepted the staged sources.",
    retryable: false,
  });
  assert.deepEqual(
    reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "unverified"),
    unverified,
  );
  assert.throws(
    () =>
      reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, "verified"),
    expectEventConflict,
  );
  assert.deepEqual(store.getJob(staged.jobId), unverified);
});

test("derives fixed terminal details and rejects post-terminal changes", () => {
  for (const [event, code, message] of [
    [
      "unverified",
      "chrome_upload_unverified",
      "Chrome could not confirm that Gemini Notebook accepted the staged sources.",
    ],
    [
      "failed",
      "chrome_upload_failed",
      "Chrome could not submit the staged sources to Gemini Notebook.",
    ],
  ]) {
    const { staged, store } = createStore([stagedItem(1)]);
    store.claimActive(staged.jobId, [101], CLAIM_ID);
    const terminal = reportChromeJobEventToStore(
      store,
      staged.jobId,
      CLAIM_ID,
      event,
    );

    assert.deepEqual(terminal.details, {
      code,
      message,
      retryable: false,
    });
    assert.deepEqual(
      reportChromeJobEventToStore(store, staged.jobId, CLAIM_ID, event),
      terminal,
    );
    assert.throws(
      () =>
        reportChromeJobEventToStore(
          store,
          staged.jobId,
          CLAIM_ID,
          event === "failed" ? "unverified" : "failed",
        ),
      expectEventConflict,
    );
    assert.deepEqual(store.getJob(staged.jobId), terminal);
  }
});

test("never exposes private claim IDs through snapshots, pending items, or details", () => {
  const { staged, store } = createStore([stagedItem(1)]);
  assert.doesNotMatch(JSON.stringify(store.getActiveJob()), /claimId/u);
  assert.doesNotMatch(JSON.stringify(store.getPendingItems()), /claimId/u);

  store.claimActive(staged.jobId, [101], CLAIM_ID);
  assert.equal(
    JSON.stringify(store.getJob(staged.jobId)).includes(CLAIM_ID),
    false,
  );
  const failed = store.transition(staged.jobId, "failed", {
    claimId: CLAIM_ID,
    nested: { claimId: CLAIM_ID },
  });
  assert.deepEqual(failed.details, { nested: {} });
  assert.equal(JSON.stringify(failed).includes(CLAIM_ID), false);
  assert.doesNotMatch(JSON.stringify(failed), /claimId/u);
});
