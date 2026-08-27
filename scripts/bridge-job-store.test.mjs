import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  BridgeJobStoreError,
  createBridgeJobStore,
  createOpaqueId,
} from "../src/modules/bridgeJobStore.js";

function createHarness({ maxHistory = 100, claimedTtlMs = 3_600_000 } = {}) {
  let timestamp = 1_000;
  let nextId = 1;
  const store = createBridgeJobStore({
    now: () => timestamp,
    createId: () => `opaque-job-${nextId++}`,
    maxHistory,
    claimedTtlMs,
  });

  return {
    store,
    setTime(value) {
      timestamp = value;
    },
  };
}

function stagedItem(id = 1) {
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

function activation(overrides = {}) {
  return {
    items: [stagedItem()],
    origin: "agent",
    source: { type: "items", libraryID: 1, itemKeys: ["ABC123"] },
    destination: "new",
    skippedCount: 0,
    ...overrides,
  };
}

function expectStoreError(code) {
  return (error) => {
    assert.ok(error instanceof BridgeJobStoreError);
    assert.equal(error.code, code);
    return true;
  };
}

function assertNoPrivateSnapshotFields(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPrivateSnapshotFields(entry);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value)) {
    assert.notEqual(key.toLowerCase(), "items");
    assert.notEqual(key.toLowerCase(), "filepath");
    assertNoPrivateSnapshotFields(entry);
  }
}

test("uses Zotero's privileged UUID generator when Web Crypto is unavailable", () => {
  const jobId = createOpaqueId({
    cryptoApi: null,
    uuidGenerator: {
      generateUUID: () => "{123e4567-e89b-42d3-a456-426614174000}",
    },
  });

  assert.equal(jobId, "123e4567-e89b-42d3-a456-426614174000");
});

test("falls through broken Web Crypto providers to Zotero's UUID generator", () => {
  const uuidGenerator = {
    generateUUID: () => "{123e4567-e89b-42d3-a456-426614174000}",
  };

  assert.equal(
    createOpaqueId({
      cryptoApi: { randomUUID: () => "malformed" },
      uuidGenerator,
    }),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(
    createOpaqueId({
      cryptoApi: {
        randomUUID: () => {
          throw new Error("unavailable");
        },
        getRandomValues: () => {
          throw new Error("unavailable");
        },
      },
      uuidGenerator,
    }),
    "123e4567-e89b-42d3-a456-426614174000",
  );
});

test("fails closed when no secure job ID provider is available", () => {
  assert.throws(
    () => createOpaqueId({ cryptoApi: null, uuidGenerator: null }),
    expectStoreError("SECURE_RANDOM_UNAVAILABLE"),
  );
  assert.throws(
    () =>
      createOpaqueId({
        cryptoApi: null,
        uuidGenerator: { generateUUID: () => "not-a-version-4-uuid" },
      }),
    expectStoreError("SECURE_RANDOM_UNAVAILABLE"),
  );
  for (const malformed of [
    "{123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000}",
  ]) {
    assert.throws(
      () =>
        createOpaqueId({
          cryptoApi: null,
          uuidGenerator: { generateUUID: () => malformed },
        }),
      expectStoreError("SECURE_RANDOM_UNAVAILABLE"),
    );
  }
});

test("accepts JSON metadata created in another JavaScript realm", () => {
  const { store } = createHarness();
  const source = runInNewContext(`({
    type: "items",
    libraryID: 1,
    itemKeys: ["ABC123"]
  })`);

  const created = store.activate(activation({ source }));
  assert.deepEqual(created.source, {
    type: "items",
    libraryID: 1,
    itemKeys: ["ABC123"],
  });
});

test("activates one staged job and exposes defensive pending-item copies", () => {
  const { store } = createHarness();
  const created = store.activate(
    activation({ items: [stagedItem(1), stagedItem(2)], skippedCount: 3 }),
  );

  assert.deepEqual(created, {
    jobId: "opaque-job-1",
    state: "staged",
    origin: "agent",
    source: { type: "items", libraryID: 1, itemKeys: ["ABC123"] },
    destination: "new",
    itemCount: 2,
    skippedCount: 3,
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: null,
  });
  assert.deepEqual(store.getActiveJob(), created);
  assert.equal(store.getStagedTimestamp(), 1_000);
  assert.equal(store.getStagedCount(), 2);
  assert.equal(store.isReady(), true);

  const pending = store.getPendingItems();
  pending[0].title = "Mutated outside the store";
  assert.equal(store.getPendingItems()[0].title, "Source 1");
});

test("retains private file-read bounds without exposing them in pending DTOs", () => {
  const { store } = createHarness();
  const bounded = { ...stagedItem(1), maxByteSize: 1234 };
  const created = store.activate(activation({ items: [bounded] }));

  assert.deepEqual(store.getAttachmentAccess(101, created.jobId), {
    maxByteSize: 1234,
  });
  assert.deepEqual(store.getPendingItems(), [stagedItem(1)]);
  assert.equal("maxByteSize" in store.getPendingItems()[0], false);
  assert.equal(JSON.stringify(created).includes("maxByteSize"), false);

  store.claimActive(created.jobId);
  assert.deepEqual(store.getAttachmentAccess(101, created.jobId), {
    maxByteSize: 1234,
  });
  assert.equal(store.getAttachmentAccess(101), null);
});

test("sanitizes every public snapshot without exposing items or file paths", () => {
  const { store } = createHarness();
  const created = store.activate(
    activation({
      items: [{ ...stagedItem(), filePath: "/private/source.pdf" }],
      requestId: "private-request-correlation",
      source: {
        type: "items",
        items: [{ filePath: "/do/not/expose.pdf" }],
        nested: { filePath: "/also/private.pdf", safe: true },
      },
      destination: {
        type: "existing",
        filePath: "/private/destination",
      },
    }),
  );

  assert.deepEqual(created.source, {
    type: "items",
    nested: { safe: true },
  });
  assert.deepEqual(created.destination, { type: "existing" });
  assertNoPrivateSnapshotFields(created);
  assert.equal(JSON.stringify(created).includes("/do/not/expose"), false);
  assert.equal("requestId" in created, false);
  assert.equal("filePath" in store.getPendingItems()[0], false);

  const claimed = store.claimActive();
  const submitted = store.transition(claimed.jobId, "submitted", {
    items: ["private"],
    nested: { filePath: "/private/status", message: "accepted" },
  });
  assert.deepEqual(submitted.details, {
    nested: { message: "accepted" },
  });
  assertNoPrivateSnapshotFields(store.getJob(created.jobId));
});

test("rejects invalid replacement input without clobbering the pending job", () => {
  const { store } = createHarness();
  const first = store.activate(activation());

  assert.throws(
    () =>
      store.activate(
        activation({ items: [], replaceExisting: true, requestId: "bad" }),
      ),
    expectStoreError("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      store.activate(
        activation({
          items: [{ ...stagedItem(2), fileName: "" }],
          replaceExisting: true,
        }),
      ),
    expectStoreError("INVALID_INPUT"),
  );

  assert.deepEqual(store.getActiveJob(), first);
  assert.equal(store.hasPendingAttachment(101), true);
});

test("conflicts on a second pending job unless replacement is explicit", () => {
  const { store } = createHarness();
  const first = store.activate(activation({ requestId: "request-one" }));

  assert.throws(
    () => store.activate(activation({ items: [stagedItem(2)] })),
    expectStoreError("PENDING_JOB_EXISTS"),
  );

  const second = store.activate(
    activation({
      items: [stagedItem(2)],
      requestId: "request-two",
      replaceExisting: true,
    }),
  );
  assert.equal(second.jobId, "opaque-job-2");
  assert.equal(store.getJob(first.jobId).state, "superseded");
  assert.deepEqual(store.getJob(first.jobId).details, {
    replacementJobId: second.jobId,
  });
  assert.deepEqual(store.getActiveJob(), second);
  assert.equal(store.hasPendingAttachment(101, first.jobId), false);
});

test("returns the retained result for an idempotent request ID", () => {
  const { store } = createHarness();
  const first = store.activate(activation({ requestId: "stable-request" }));

  assert.deepEqual(
    store.getIdempotentJob(" stable-request ", {
      origin: "agent",
      source: { type: "items", libraryID: 1, itemKeys: ["ABC123"] },
      destination: "new",
    }),
    first,
  );
  assert.equal(
    store.getIdempotentJob("unseen-request", {
      origin: "agent",
      source: { type: "items", libraryID: 1, itemKeys: ["ABC123"] },
      destination: "new",
    }),
    null,
  );

  const repeatedPending = store.activate(
    activation({
      items: [{ ...stagedItem(9), title: "Metadata changed in Zotero" }],
      skippedCount: 4,
      requestId: "stable-request",
      replaceExisting: true,
    }),
  );
  assert.deepEqual(repeatedPending, first);
  assert.equal(store.getStagedCount(), 1);
  assert.equal(store.getPendingItems()[0].itemId, 1);

  const claimed = store.claimActive(first.jobId);
  const repeatedClaimed = store.activate(
    activation({ requestId: "stable-request" }),
  );
  assert.deepEqual(repeatedClaimed, claimed);
  assert.equal(store.getActiveJob(), null);

  const submitted = store.transition(first.jobId, "submitted");
  const repeatedSubmitted = store.activate(
    activation({ requestId: "stable-request", expiresAt: 9_999_999 }),
  );
  assert.deepEqual(repeatedSubmitted, submitted);
  assert.equal(repeatedSubmitted.state, "submitted");
  assert.equal(repeatedSubmitted.expiresAt, claimed.expiresAt);
  assert.equal(store.getActiveJob(), null);

  const next = store.activate(activation({ items: [stagedItem(4)] }));
  assert.equal(next.jobId, "opaque-job-2");
});

test("conflicts when an idempotency key is reused with different input", () => {
  const { store } = createHarness();
  const first = store.activate(activation({ requestId: "stable-request" }));

  assert.throws(
    () =>
      store.getIdempotentJob("stable-request", {
        origin: "agent",
        source: {
          type: "items",
          libraryID: 1,
          itemKeys: ["DIFFERENT"],
        },
        destination: "new",
      }),
    expectStoreError("IDEMPOTENCY_CONFLICT"),
  );
  assert.throws(
    () =>
      store.activate(
        activation({
          requestId: "stable-request",
          source: {
            type: "items",
            libraryID: 1,
            itemKeys: ["DIFFERENT"],
          },
        }),
      ),
    expectStoreError("IDEMPOTENCY_CONFLICT"),
  );
  assert.deepEqual(store.getActiveJob(), first);
});

test("claiming is job-bound and frees the legacy pending slot", () => {
  const { store } = createHarness();
  const staged = store.activate(activation());

  assert.equal(store.claimActive("a-different-job"), null);
  assert.deepEqual(store.getActiveJob(), staged);

  const claimed = store.claimActive(staged.jobId);
  assert.equal(claimed.state, "claimed");
  assert.equal(store.getActiveJob(), null);
  assert.deepEqual(store.getPendingItems(), []);
  assert.equal(store.getStagedTimestamp(), null);
  assert.equal(store.getStagedCount(), 0);
  assert.equal(store.isReady(), false);
  assert.deepEqual(store.claimActive(staged.jobId), claimed);
  assert.deepEqual(store.getJob(staged.jobId), claimed);

  const next = store.activate(activation({ items: [stagedItem(2)] }));
  assert.equal(next.state, "staged");
});

test("an unscoped claim consumes only the current pending job", () => {
  const { store } = createHarness();
  const staged = store.activate(activation());

  const claimed = store.claimActive();
  assert.equal(claimed.jobId, staged.jobId);
  assert.equal(claimed.state, "claimed");
  assert.equal(store.getActiveJob(), null);
  assert.deepEqual(store.getPendingItems(), []);
});

test("a job-bound claim narrows access to the selected staged subset", () => {
  const { store } = createHarness();
  const staged = store.activate(
    activation({ items: [stagedItem(1), stagedItem(2)] }),
  );

  const claimed = store.claimActive(staged.jobId, [102]);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.itemCount, 1);
  assert.equal(store.hasPendingAttachment(101, staged.jobId), false);
  assert.equal(store.hasPendingAttachment(102, staged.jobId), true);
  assert.deepEqual(store.claimActive(staged.jobId, [102]), claimed);

  assert.throws(
    () => store.claimActive(staged.jobId, [101]),
    expectStoreError("INVALID_INPUT"),
  );
});

test("a stale job-bound claim cannot consume a replacement pending job", () => {
  const { store } = createHarness();
  const first = store.activate(activation({ items: [stagedItem(1)] }));
  const second = store.activate(
    activation({ items: [stagedItem(2)], replaceExisting: true }),
  );

  assert.equal(store.claimActive(first.jobId, [101]), null);
  assert.deepEqual(store.getActiveJob(), second);
  assert.equal(store.hasPendingAttachment(102), true);
});

test("requires an explicit job ID for files retained after claim", () => {
  const { store } = createHarness();
  const first = store.activate(activation());
  store.claimActive(first.jobId);

  assert.equal(store.hasPendingAttachment(101), false);
  assert.equal(store.hasPendingAttachment(101, first.jobId), true);
  assert.equal(store.hasPendingAttachment(101, "wrong-job"), false);

  const second = store.activate(activation({ items: [stagedItem(2)] }));
  assert.equal(store.hasPendingAttachment(102), true);
  assert.equal(store.hasPendingAttachment(101), false);
  assert.equal(store.hasPendingAttachment(101, first.jobId), true);
  assert.equal(store.hasPendingAttachment(102, second.jobId), true);

  store.transition(first.jobId, "submitted");
  store.transition(first.jobId, "verifying");
  store.transition(first.jobId, "verified");
  assert.equal(store.hasPendingAttachment(101, first.jobId), false);
});

test("enforces the bridge job state machine", () => {
  const { store } = createHarness();
  const staged = store.activate(activation());

  assert.throws(
    () => store.transition(staged.jobId, "verified"),
    expectStoreError("INVALID_TRANSITION"),
  );
  assert.throws(
    () => store.transition(staged.jobId, "not-a-state"),
    expectStoreError("INVALID_INPUT"),
  );

  assert.equal(store.transition(staged.jobId, "claimed").state, "claimed");
  assert.equal(store.transition(staged.jobId, "submitted").state, "submitted");
  for (const state of ["verified", "unverified"]) {
    assert.throws(
      () => store.transition(staged.jobId, state),
      expectStoreError("INVALID_TRANSITION"),
    );
  }
  assert.equal(store.transition(staged.jobId, "verifying").state, "verifying");
  assert.equal(
    store.transition(staged.jobId, "unverified").state,
    "unverified",
  );
  assert.throws(
    () => store.transition(staged.jobId, "verified"),
    expectStoreError("INVALID_TRANSITION"),
  );
  assert.throws(
    () => store.transition("missing-job", "cancelled"),
    expectStoreError("JOB_NOT_FOUND"),
  );
});

test("supports idempotent cancellation and locks other terminal changes", () => {
  const { store } = createHarness();
  const staged = store.activate(activation());
  const cancelled = store.cancel(staged.jobId, { reason: "user request" });

  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.details, { reason: "user request" });
  assert.equal(store.getActiveJob(), null);
  assert.equal(store.hasPendingAttachment(101, staged.jobId), false);
  assert.deepEqual(store.cancel(staged.jobId), cancelled);
  assert.deepEqual(
    store.transition(staged.jobId, "cancelled", { reason: "stale retry" }),
    cancelled,
  );
  assert.throws(
    () => store.transition(staged.jobId, "failed"),
    expectStoreError("INVALID_TRANSITION"),
  );
});

test("expires pending and retained jobs using the injected clock", () => {
  const { store, setTime } = createHarness();
  const first = store.activate(
    activation({ requestId: "expires", expiresAt: 1_100 }),
  );
  setTime(1_100);

  assert.equal(store.isReady(), false);
  assert.equal(store.getJob(first.jobId).state, "expired");
  assert.equal(store.hasPendingAttachment(101, first.jobId), false);

  assert.throws(
    () => store.activate(activation({ expiresAt: 1_100 })),
    expectStoreError("INVALID_INPUT"),
  );
});

test("expires legacy claimed jobs and releases their attachment allowlists", () => {
  const { store, setTime } = createHarness({ claimedTtlMs: 100 });
  const first = store.activate(activation());
  const claimed = store.claimActive(first.jobId);

  assert.equal(claimed.expiresAt, 1_100);
  assert.equal(store.hasPendingAttachment(101, first.jobId), true);

  setTime(1_100);
  assert.equal(store.getJob(first.jobId).state, "expired");
  assert.equal(store.hasPendingAttachment(101, first.jobId), false);
});

test("bounds terminal history without pruning live or pending jobs", () => {
  const { store } = createHarness({ maxHistory: 2 });
  const first = store.activate(
    activation({ requestId: "request-1", items: [stagedItem(1)] }),
  );
  store.claimActive(first.jobId);
  const second = store.activate(
    activation({ requestId: "request-2", items: [stagedItem(2)] }),
  );
  store.claimActive(second.jobId);
  const third = store.activate(
    activation({ requestId: "request-3", items: [stagedItem(3)] }),
  );

  assert.equal(store.getJob(first.jobId).state, "claimed");
  assert.equal(store.getJob(second.jobId).state, "claimed");
  assert.deepEqual(store.getActiveJob(), third);

  store.cancel(first.jobId);
  store.cancel(second.jobId);
  store.cancel(third.jobId);
  assert.equal(store.getJob(first.jobId), null);
  assert.equal(store.getJob(second.jobId).state, "cancelled");
  assert.equal(store.getJob(third.jobId).state, "cancelled");

  const reusedPrunedRequest = store.activate(
    activation({
      requestId: "request-1",
      items: [stagedItem(4)],
    }),
  );
  assert.equal(reusedPrunedRequest.jobId, "opaque-job-4");
});

test("reset removes pending jobs, history, request IDs, and file access", () => {
  const { store } = createHarness();
  const staged = store.activate(activation({ requestId: "reset-me" }));
  store.claimActive(staged.jobId);
  store.reset();

  assert.equal(store.getJob(staged.jobId), null);
  assert.equal(store.getActiveJob(), null);
  assert.equal(store.hasPendingAttachment(101, staged.jobId), false);

  const afterReset = store.activate(activation({ requestId: "reset-me" }));
  assert.equal(afterReset.jobId, "opaque-job-2");
});
