import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCreateBridgeJobInput } from "../src/modules/bridgeJobInput.js";

test("normalizes stable item keys for semantic idempotency", () => {
  assert.deepEqual(
    normalizeCreateBridgeJobInput({
      libraryID: 1,
      itemKeys: ["bbbb2222", "AAAA1111"],
      destination: "new",
      requestId: " request-1 ",
    }),
    {
      libraryID: 1,
      itemKeys: ["AAAA1111", "BBBB2222"],
      destination: "new",
      requestId: "request-1",
      replace: false,
    },
  );
});

test("normalizes a collection request and its recursive default", () => {
  assert.deepEqual(
    normalizeCreateBridgeJobInput({
      libraryID: 2,
      collectionKey: "abcd1234",
      destination: "new",
      replace: true,
    }),
    {
      libraryID: 2,
      collectionKey: "ABCD1234",
      recursive: false,
      destination: "new",
      replace: true,
    },
  );
});

test("requires exactly one stable Zotero source selector", () => {
  const base = { libraryID: 1, destination: "new" };
  assert.throws(() => normalizeCreateBridgeJobInput(base), /exactly one/);
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        itemKeys: ["AAAA1111"],
        collectionKey: "BBBB2222",
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        itemKeys: ["AAAA1111"],
        recursive: false,
      }),
    /recursive is only valid/,
  );
});

test("rejects malformed and case-insensitive duplicate Zotero keys", () => {
  const base = { libraryID: 1, destination: "new" };
  assert.throws(
    () => normalizeCreateBridgeJobInput({ ...base, itemKeys: ["SHORT"] }),
    /eight alphanumeric/,
  );
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        itemKeys: ["aaaa1111", "AAAA1111"],
      }),
    /duplicates/,
  );
});

test("rejects numeric IDs, attachment IDs, paths, and unknown fields", () => {
  const base = {
    libraryID: 1,
    itemKeys: ["AAAA1111"],
    destination: "new",
  };
  for (const forbidden of [
    { itemIds: [1] },
    { attachmentIds: [2] },
    { filePath: "/private/source.pdf" },
  ]) {
    assert.throws(
      () => normalizeCreateBridgeJobInput({ ...base, ...forbidden }),
      /does not accept the field/,
    );
  }
});

test("rejects invalid libraries, destinations, request IDs, and flags", () => {
  const base = { itemKeys: ["AAAA1111"], destination: "new" };
  assert.throws(
    () => normalizeCreateBridgeJobInput({ ...base, libraryID: 0 }),
    /positive integer/,
  );
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        libraryID: 1,
        destination: "current",
      }),
    /destination must be "new"/,
  );
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        libraryID: 1,
        requestId: "x".repeat(129),
      }),
    /128 characters/,
  );
  assert.throws(
    () =>
      normalizeCreateBridgeJobInput({
        ...base,
        libraryID: 1,
        replace: "yes",
      }),
    /replace must be a boolean/,
  );
});

test("rejects non-plain input objects", () => {
  assert.throws(() => normalizeCreateBridgeJobInput(null), /plain input/);
  assert.throws(() => normalizeCreateBridgeJobInput([]), /plain input/);
  assert.throws(
    () => normalizeCreateBridgeJobInput(new (class Request {})()),
    /plain input/,
  );
});
