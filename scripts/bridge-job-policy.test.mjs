import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGENT_JOB_TTL_MS,
  BridgeJobCreationError,
  MAX_AGENT_CANDIDATE_ITEMS,
  MAX_AGENT_COLLECTIONS_SCANNED,
  MAX_AGENT_SOURCE_BYTES,
  MAX_AGENT_STAGED_SOURCES,
  MAX_AGENT_TOTAL_BYTES,
  getAgentJobExpiresAt,
  prepareAgentStagedItems,
} from "../src/modules/bridgeJobPolicy.js";

const bridgeJobsSource = await readFile(
  new globalThis.URL("../src/modules/bridgeJobs.ts", import.meta.url),
  "utf8",
);
const itemsSource = await readFile(
  new globalThis.URL("../src/modules/items.ts", import.meta.url),
  "utf8",
);

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

function expectCreationError(code) {
  return (error) => {
    assert.ok(error instanceof BridgeJobCreationError);
    assert.equal(error.code, code);
    return true;
  };
}

test("publishes the conservative first-beta agent job limits", () => {
  assert.equal(MAX_AGENT_STAGED_SOURCES, 50);
  assert.equal(MAX_AGENT_CANDIDATE_ITEMS, 256);
  assert.equal(MAX_AGENT_COLLECTIONS_SCANNED, 1_000);
  assert.equal(MAX_AGENT_SOURCE_BYTES, 200_000_000);
  assert.equal(MAX_AGENT_TOTAL_BYTES, 200_000_000);
  assert.equal(AGENT_JOB_TTL_MS, 60 * 60 * 1000);
  assert.equal(getAgentJobExpiresAt(1_000), 3_601_000);
});

test("connects agent job creation to sized resolution, limits, and TTL", () => {
  assert.match(bridgeJobsSource, /toSizedStagedItem/u);
  assert.match(bridgeJobsSource, /prepareAgentStagedItems\(/u);
  assert.match(bridgeJobsSource, /expiresAt: getAgentJobExpiresAt\(\)/u);
  assert.match(bridgeJobsSource, /MAX_AGENT_CANDIDATE_ITEMS/u);
  assert.match(bridgeJobsSource, /MAX_AGENT_COLLECTIONS_SCANNED/u);
  assert.ok(
    bridgeJobsSource.indexOf("prepareAgentStagedItems(") <
      bridgeJobsSource.indexOf("bridgeJobStore.activate({"),
  );
  assert.match(itemsSource, /IOUtils\.stat\(attachment\.filePath\)/u);
  assert.match(itemsSource, /byteSize: info\.size/u);
});

test("retains private read bounds for the Zotero job authority", async () => {
  const resolved = await prepareAgentStagedItems([1, 2, 3], async (id) =>
    id === 2 ? null : { stagedItem: stagedItem(id), byteSize: id * 10 },
  );

  assert.deepEqual(resolved, {
    stagedItems: [
      { ...stagedItem(1), maxByteSize: 10 },
      { ...stagedItem(3), maxByteSize: 30 },
    ],
    skippedCount: 1,
  });
  assert.equal(JSON.stringify(resolved).includes("privatePath"), false);
});

test("rejects a 51st staged source with a stable typed code", async () => {
  const requested = Array.from({ length: 51 }, (_, index) => index + 1);
  await assert.rejects(
    prepareAgentStagedItems(requested, async (id) => ({
      stagedItem: stagedItem(id),
      byteSize: 1,
    })),
    expectCreationError("SOURCE_LIMIT_EXCEEDED"),
  );
});

test("accepts exact byte boundaries and rejects per-source overflow", async () => {
  const exact = await prepareAgentStagedItems([1], async (id) => ({
    stagedItem: stagedItem(id),
    byteSize: MAX_AGENT_SOURCE_BYTES,
  }));
  assert.equal(exact.stagedItems.length, 1);

  await assert.rejects(
    prepareAgentStagedItems([1], async (id) => ({
      stagedItem: stagedItem(id),
      byteSize: MAX_AGENT_SOURCE_BYTES + 1,
    })),
    expectCreationError("SOURCE_LIMIT_EXCEEDED"),
  );
});

test("rejects aggregate byte overflow without exposing source metadata", async () => {
  const privatePath = "/private/library/source.pdf";
  await assert.rejects(
    prepareAgentStagedItems(
      [1, 2],
      async (id) => ({
        stagedItem: { ...stagedItem(id), privatePath },
        byteSize: 100_000_001,
      }),
      {
        maxSourceBytes: 200_000_000,
        maxTotalBytes: 200_000_000,
      },
    ),
    (error) => {
      assert.ok(expectCreationError("SOURCE_LIMIT_EXCEEDED")(error));
      assert.equal(error.message.includes(privatePath), false);
      return true;
    },
  );
});

test("fails closed on an unavailable or unsafe byte size", async () => {
  for (const byteSize of [undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      prepareAgentStagedItems([1], async (id) => ({
        stagedItem: stagedItem(id),
        byteSize,
      })),
      expectCreationError("SOURCE_LIMIT_EXCEEDED"),
    );
  }
});

test("validates injected policy values and expiry clocks", async () => {
  await assert.rejects(
    prepareAgentStagedItems([], async () => null, { maxStagedSources: 0 }),
    expectCreationError("INVALID_POLICY_INPUT"),
  );
  assert.throws(
    () => getAgentJobExpiresAt(-1),
    expectCreationError("INVALID_POLICY_INPUT"),
  );
  assert.throws(
    () => getAgentJobExpiresAt(Number.MAX_SAFE_INTEGER),
    expectCreationError("INVALID_POLICY_INPUT"),
  );
});
