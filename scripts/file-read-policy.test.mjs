import assert from "node:assert/strict";
import test from "node:test";

import {
  FileReadPolicyError,
  assertStagedFileReadPolicy,
  readFileAsBase64,
} from "../src/utils/file.ts";

test("rejects a staged file that is no longer regular or exceeds its bound", () => {
  assert.doesNotThrow(() =>
    assertStagedFileReadPolicy({ type: "regular", size: 10 }, 10),
  );
  assert.doesNotThrow(() =>
    assertStagedFileReadPolicy({ type: "regular", size: 9 }, 10),
  );
  assert.throws(
    () => assertStagedFileReadPolicy({ type: "regular", size: 11 }, 10),
    FileReadPolicyError,
  );
  assert.throws(
    () => assertStagedFileReadPolicy({ type: "other", size: 10 }, 10),
    FileReadPolicyError,
  );
});

test("caps the actual read if a staged file grows after its stat", async () => {
  const previousIOUtils = globalThis.IOUtils;
  const calls = [];
  try {
    globalThis.IOUtils = {
      async read(filePath, options) {
        calls.push({ filePath, options });
        return new Uint8Array([1, 2, 3, 4]);
      },
    };

    await assert.rejects(
      readFileAsBase64("/private/staged.pdf", 3),
      FileReadPolicyError,
    );
    assert.deepEqual(calls, [
      {
        filePath: "/private/staged.pdf",
        options: { maxBytes: 4 },
      },
    ]);
  } finally {
    globalThis.IOUtils = previousIOUtils;
  }
});

test("encodes a read that remains within its staged byte bound", async () => {
  const previousIOUtils = globalThis.IOUtils;
  try {
    globalThis.IOUtils = {
      async read() {
        return new Uint8Array([0, 1, 2]);
      },
    };

    assert.equal(await readFileAsBase64("/private/staged.pdf", 3), "AAEC");
  } finally {
    globalThis.IOUtils = previousIOUtils;
  }
});
