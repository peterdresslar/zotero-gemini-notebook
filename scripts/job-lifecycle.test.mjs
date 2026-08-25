import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseLegacyPopupClear } from "../chrome-extension/bridge-requests.js";
import "../chrome-extension/upload-handoff.js";

import {
  JOB_CLAIM_ACTION,
  JOB_CLAIM_CONTENT_TYPE,
  JOB_CLAIM_ENDPOINT,
  JOB_CONTROL_RESPONSE_MAX_BYTES,
  JOB_LIFECYCLE_ACTION,
  JOB_LIFECYCLE_CONTENT_TYPE,
  JOB_LIFECYCLE_ENDPOINT,
  createJobClaimBody,
  createJobLifecycleBody,
  isAllowedJobClaimSender,
  isAllowedJobLifecycleSender,
  postJobClaim,
  postJobLifecycleEvent,
  readJobClaimMessage,
  readJobLifecycleMessage,
} from "../chrome-extension/job-lifecycle.js";

const JOB_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const CLAIM_ID = "12345678-90ab-4cde-8fab-1234567890ab";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup.html`;
const POPUP_SENDER = Object.freeze({ id: EXTENSION_ID, url: POPUP_URL });
const {
  PROTOCOL_VERSION,
  createController,
  createPingResponse,
  isAllowedPopupSender,
} = globalThis.ZoteroUploadHandoff;

test("creates the exact canonical claim and lifecycle bodies", () => {
  const attachmentIds = [30, 10, 20];

  assert.equal(
    createJobClaimBody(JOB_ID, CLAIM_ID, attachmentIds),
    `{"attachmentIds":[10,20,30],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
  );
  assert.deepEqual(attachmentIds, [30, 10, 20]);
  assert.equal(
    createJobLifecycleBody(JOB_ID, CLAIM_ID, "submitted"),
    `{"claimId":"${CLAIM_ID}","event":"submitted","jobId":"${JOB_ID}"}`,
  );
});

test("accepts only the exact internal message schemas", () => {
  assert.deepEqual(
    readJobClaimMessage({
      action: JOB_CLAIM_ACTION,
      attachmentIds: [2, 1],
      claimId: CLAIM_ID,
      jobId: JOB_ID,
    }),
    {
      attachmentIds: [2, 1],
      claimId: CLAIM_ID,
      jobId: JOB_ID,
    },
  );
  assert.deepEqual(
    readJobLifecycleMessage({
      action: JOB_LIFECYCLE_ACTION,
      claimId: CLAIM_ID,
      event: "failed",
      jobId: JOB_ID,
    }),
    { claimId: CLAIM_ID, event: "failed", jobId: JOB_ID },
  );

  assert.throws(
    () =>
      readJobClaimMessage({
        action: JOB_CLAIM_ACTION,
        attachmentIds: [1],
        claimId: CLAIM_ID,
        jobId: JOB_ID,
        extra: true,
      }),
    /Claim message is invalid/,
  );
  assert.throws(
    () =>
      readJobLifecycleMessage({
        action: JOB_LIFECYCLE_ACTION,
        claimId: CLAIM_ID,
        event: "verified",
        jobId: JOB_ID,
      }),
    /event is invalid/,
  );
});

test("rejects malformed claim IDs, job IDs, and attachment selections", () => {
  for (const claimId of [
    "",
    "contains space",
    "slash/value",
    "x".repeat(129),
  ]) {
    assert.throws(
      () => createJobClaimBody(JOB_ID, claimId, [1]),
      /Claim ID is invalid/,
    );
  }
  for (const jobId of ["", "contains space", "x".repeat(129)]) {
    assert.throws(
      () => createJobClaimBody(jobId, CLAIM_ID, [1]),
      /Job ID is invalid/,
    );
  }
  for (const attachmentIds of [
    [],
    [0],
    [1.5],
    [1, 1],
    Array.from({ length: 51 }, (_, index) => index + 1),
  ]) {
    assert.throws(
      () => createJobClaimBody(JOB_ID, CLAIM_ID, attachmentIds),
      /attachment IDs are invalid/,
    );
  }
});

test("allows only this extension's top-frame Gemini content script", () => {
  const allowed = {
    id: EXTENSION_ID,
    frameId: 0,
    tab: { id: 7, url: "https://notebook.google.com/notebook/example" },
    url: "https://notebook.google.com/notebook/example",
  };

  assert.equal(
    isAllowedJobLifecycleSender({
      sender: allowed,
      extensionId: EXTENSION_ID,
    }),
    true,
  );
  assert.equal(
    isAllowedJobClaimSender({ sender: allowed, extensionId: EXTENSION_ID }),
    true,
  );

  const rejected = [
    { ...allowed, id: "another-extension" },
    { ...allowed, frameId: 1 },
    {
      ...allowed,
      tab: undefined,
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    },
    { ...allowed, url: "https://notebook.google.com.evil.example/notebook/x" },
    { ...allowed, url: "http://notebook.google.com/notebook/x" },
    { ...allowed, url: "https://notebook.google.com:444/notebook/x" },
  ];
  for (const sender of rejected) {
    assert.equal(
      isAllowedJobLifecycleSender({ sender, extensionId: EXTENSION_ID }),
      false,
    );
  }
});

test("posts a fixed claim request and validates the bound response", async () => {
  let observed;
  const result = await postJobClaim({
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return response({
        url: JOB_CLAIM_ENDPOINT,
        body: `{"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}","state":"claimed"}`,
      });
    },
    jobId: JOB_ID,
    claimId: CLAIM_ID,
    attachmentIds: [20, 10],
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(observed.url, JOB_CLAIM_ENDPOINT);
  assert.deepEqual(
    {
      method: observed.init.method,
      headers: observed.init.headers,
      body: observed.init.body,
      cache: observed.init.cache,
      credentials: observed.init.credentials,
      redirect: observed.init.redirect,
      referrerPolicy: observed.init.referrerPolicy,
    },
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": JOB_CLAIM_CONTENT_TYPE,
        "zotero-allowed-request": "1",
      },
      body: `{"attachmentIds":[10,20],"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}"}`,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    },
  );
  assert.equal(observed.init.signal instanceof globalThis.AbortSignal, true);
});

test("posts only the three allowed lifecycle events", async () => {
  for (const event of ["submitted", "unverified", "failed"]) {
    let observed;
    await postJobLifecycleEvent({
      fetchImpl: async (url, init) => {
        observed = { url, init };
        return response({ url: JOB_LIFECYCLE_ENDPOINT });
      },
      jobId: JOB_ID,
      claimId: CLAIM_ID,
      event,
    });
    assert.equal(observed.url, JOB_LIFECYCLE_ENDPOINT);
    assert.equal(
      observed.init.headers["Content-Type"],
      JOB_LIFECYCLE_CONTENT_TYPE,
    );
    assert.equal(
      observed.init.body,
      `{"claimId":"${CLAIM_ID}","event":"${event}","jobId":"${JOB_ID}"}`,
    );
  }
});

test("rejects redirects, wrong origins, media types, bodies, and oversized responses", async () => {
  const invalidResponses = [
    response({ url: JOB_LIFECYCLE_ENDPOINT, redirected: true }),
    response({ url: "http://127.0.0.1:23119/notebooklm/other" }),
    response({ url: JOB_LIFECYCLE_ENDPOINT, contentType: "text/plain" }),
    response({ url: JOB_LIFECYCLE_ENDPOINT, body: '{"accepted":false}' }),
    response({ url: JOB_LIFECYCLE_ENDPOINT, status: 409 }),
    response({
      url: JOB_LIFECYCLE_ENDPOINT,
      body: "x".repeat(JOB_CONTROL_RESPONSE_MAX_BYTES + 1),
      omitContentLength: true,
    }),
  ];

  for (const invalidResponse of invalidResponses) {
    await assert.rejects(
      postJobLifecycleEvent({
        fetchImpl: async () => invalidResponse,
        jobId: JOB_ID,
        claimId: CLAIM_ID,
        event: "submitted",
      }),
    );
  }
});

test("retries one ambiguous claim failure with the identical request", async () => {
  const requests = [];
  const harness = createHandoffHarness({
    claimJob: (job) =>
      postJobClaim({
        fetchImpl: async (url, init) => {
          requests.push({ url, body: init.body });
          if (requests.length === 1) throw new TypeError("response was lost");
          return response({
            url: JOB_CLAIM_ENDPOINT,
            body: `{"claimId":"${CLAIM_ID}","jobId":"${JOB_ID}","state":"claimed"}`,
          });
        },
        ...job,
      }),
  });

  harness.controller.begin(beginMessage(), POPUP_SENDER);
  harness.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await harness.controller.commit(CLAIM_ID, POPUP_SENDER);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, JOB_CLAIM_ENDPOINT);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(harness.uploads.length, 1);
});

test("does not retry an explicit claim rejection", async () => {
  let attempts = 0;
  const harness = createHandoffHarness({
    claimJob: (job) =>
      postJobClaim({
        fetchImpl: async () => {
          attempts += 1;
          return response({
            url: JOB_CLAIM_ENDPOINT,
            status: 409,
            body: '{"error":{"code":"claim_conflict"}}',
          });
        },
        ...job,
      }),
  });
  harness.controller.begin(beginMessage(), POPUP_SENDER);
  harness.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await assert.rejects(
    harness.controller.commit(CLAIM_ID, POPUP_SENDER),
    /could not claim/,
  );
  assert.equal(attempts, 1);
  assert.equal(harness.uploads.length, 0);
});

test("exhausted claim transport retries discard bytes without upload", async () => {
  let attempts = 0;
  const harness = createHandoffHarness({
    claimJob: (job) =>
      postJobClaim({
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("loopback unavailable");
        },
        ...job,
      }),
  });
  harness.controller.begin(beginMessage(), POPUP_SENDER);
  harness.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await assert.rejects(
    harness.controller.commit(CLAIM_ID, POPUP_SENDER),
    /could not claim/,
  );
  assert.equal(attempts, 2);
  assert.equal(harness.uploads.length, 0);
});

test("handoff validates begin atomically and rejects stale popup senders", () => {
  const harness = createHandoffHarness();
  assert.throws(
    () =>
      harness.controller.begin(
        beginMessage({ jobId: "not-a-bridge-job" }),
        POPUP_SENDER,
      ),
    /job identifier/,
  );
  assert.throws(
    () => harness.controller.addChunk(chunkMessage(), POPUP_SENDER),
    /No upload batch/,
  );

  const staleSender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/stale-popup.html`,
  };
  assert.throws(
    () => harness.controller.begin(beginMessage(), staleSender),
    /sender is invalid/,
  );
  assert.throws(
    () => harness.controller.addChunk(chunkMessage(), POPUP_SENDER),
    /No upload batch/,
  );
  assert.equal(harness.claims.length, 0);
  assert.equal(harness.uploads.length, 0);
});

test("claim acknowledgement precedes exactly one upload", async () => {
  const order = [];
  const harness = createHandoffHarness({
    claimJob: async (job) => {
      order.push(`claim:${job.claimId}`);
    },
    startUpload: ({ complete }) => {
      order.push("upload");
      complete();
    },
  });

  harness.controller.begin(beginMessage(), POPUP_SENDER);
  harness.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await assert.rejects(
    harness.controller.commit("wrong-batch", POPUP_SENDER),
    /does not match/,
  );
  await harness.controller.commit(CLAIM_ID, POPUP_SENDER);
  await assert.rejects(
    harness.controller.commit(CLAIM_ID, POPUP_SENDER),
    /No upload batch/,
  );

  assert.deepEqual(order, [`claim:${CLAIM_ID}`, "upload"]);
});

test("claim rejection and cancellation discard held bytes without upload", async () => {
  const rejected = createHandoffHarness({
    claimJob: async () => {
      throw new Error("fixed rejection");
    },
  });
  rejected.controller.begin(beginMessage(), POPUP_SENDER);
  rejected.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await assert.rejects(
    rejected.controller.commit(CLAIM_ID, POPUP_SENDER),
    /could not claim/,
  );
  assert.equal(rejected.uploads.length, 0);

  // A new batch can begin after rejection, proving the held byte array was
  // discarded and the controller did not remain wedged.
  rejected.controller.begin(
    beginMessage({ batchId: "replacement-claim" }),
    POPUP_SENDER,
  );

  let releaseClaim;
  const claimPending = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  const cancelled = createHandoffHarness({
    claimJob: async () => claimPending,
  });
  cancelled.controller.begin(beginMessage(), POPUP_SENDER);
  cancelled.controller.addChunk(chunkMessage(), POPUP_SENDER);
  const commit = cancelled.controller.commit(CLAIM_ID, POPUP_SENDER);
  cancelled.controller.abort(CLAIM_ID, POPUP_SENDER);
  releaseClaim();
  await assert.rejects(commit, /cancelled/);
  assert.equal(cancelled.uploads.length, 0);
});

test("legacy null-job handoff skips claim and retains popup-only clear", async () => {
  const harness = createHandoffHarness();
  harness.controller.begin(
    beginMessage({ jobId: null, attachmentIds: undefined }),
    POPUP_SENDER,
  );
  harness.controller.addChunk(chunkMessage(), POPUP_SENDER);
  await harness.controller.commit(CLAIM_ID, POPUP_SENDER);

  assert.equal(harness.claims.length, 0);
  assert.equal(harness.uploads.length, 1);
  assert.equal(harness.uploads[0].job, null);
  assert.equal(shouldUseLegacyPopupClear(null), true);
  assert.equal(shouldUseLegacyPopupClear(JOB_ID), false);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(createPingResponse(), {
    ready: true,
    lifecycleProtocolVersion: 1,
  });
});

test("popup sender validation requires the exact extension popup", () => {
  assert.equal(
    isAllowedPopupSender({
      sender: POPUP_SENDER,
      extensionId: EXTENSION_ID,
      popupUrl: POPUP_URL,
    }),
    true,
  );
  for (const sender of [
    { ...POPUP_SENDER, id: "another-extension" },
    { ...POPUP_SENDER, tab: { id: 1 } },
    { ...POPUP_SENDER, url: `${POPUP_URL}?stale=1` },
  ]) {
    assert.equal(
      isAllowedPopupSender({
        sender,
        extensionId: EXTENSION_ID,
        popupUrl: POPUP_URL,
      }),
      false,
    );
  }
});

function createHandoffHarness(overrides = {}) {
  const claims = [];
  const uploads = [];
  let nextTimer = 0;
  const timers = new Map();
  const controller = createController({
    createBatch: createTestBatch,
    claimJob:
      overrides.claimJob ??
      (async (job) => {
        claims.push(job);
      }),
    startUpload:
      overrides.startUpload ??
      ((upload) => {
        uploads.push(upload);
        upload.complete();
      }),
    isAuthorizedSender: (sender) =>
      isAllowedPopupSender({
        sender,
        extensionId: EXTENSION_ID,
        popupUrl: POPUP_URL,
      }),
    setTimeout: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    expiryMs: 1000,
  });
  return { claims, controller, timers, uploads };
}

function beginMessage(overrides = {}) {
  return {
    action: "uploadBatchBegin",
    batchId: CLAIM_ID,
    fileCount: 1,
    jobId: JOB_ID,
    attachmentIds: [10],
    ...overrides,
  };
}

function chunkMessage(overrides = {}) {
  return {
    action: "uploadBatchChunk",
    batchId: CLAIM_ID,
    fileIndex: 0,
    chunkIndex: 0,
    chunkCount: 1,
    fileName: "source.pdf",
    contentType: "application/pdf",
    data: "c291cmNl",
    ...overrides,
  };
}

function createTestBatch(batchId, fileCount) {
  let chunk = null;
  let finalized = false;
  return Object.freeze({
    batchId,
    fileCount,
    addChunk(value) {
      if (finalized) throw new Error("Batch is finalized");
      if (value.batchId !== batchId) throw new Error("Chunk has wrong batch");
      chunk = value;
    },
    finalize() {
      if (finalized) throw new Error("Batch is finalized");
      if (!chunk) throw new Error("Batch is incomplete");
      finalized = true;
      return Object.freeze([
        Object.freeze({
          fileName: chunk.fileName,
          contentType: chunk.contentType,
          base64Data: chunk.data,
        }),
      ]);
    },
  });
}

function response({
  url,
  body = '{"accepted":true}',
  status = 200,
  redirected = false,
  contentType = "application/json; charset=utf-8",
  omitContentLength = false,
}) {
  const bytes = new globalThis.TextEncoder().encode(body);
  let read = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        if (name === "content-length") {
          return omitContentLength ? null : String(bytes.byteLength);
        }
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}
