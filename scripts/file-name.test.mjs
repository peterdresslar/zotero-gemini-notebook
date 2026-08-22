import assert from "node:assert/strict";
import test from "node:test";

import { getSafeFileName } from "../src/utils/fileName.js";

test("uses a plain Zotero attachment filename", () => {
  assert.equal(
    getSafeFileName("article.pdf", "/Users/example/library/article.pdf"),
    "article.pdf",
  );
});

test("reduces preferred names and fallback paths to a basename", () => {
  assert.equal(
    getSafeFileName("C:\\private\\renamed.pdf", "/ignored/original.pdf"),
    "renamed.pdf",
  );
  assert.equal(
    getSafeFileName("", "C:\\Users\\example\\library\\article.pdf"),
    "article.pdf",
  );
  assert.equal(
    getSafeFileName(null, "/Users/example/library/article.pdf"),
    "article.pdf",
  );
});

test("removes control characters and never returns a full local path", () => {
  const fileName = getSafeFileName("..\\private\\paper\n.pdf", null);
  assert.equal(fileName, "paper.pdf");
  assert.equal(fileName.includes("private"), false);
  assert.equal(fileName.includes("\\"), false);
});

test("uses a neutral fallback when neither value contains a filename", () => {
  assert.equal(getSafeFileName("..", null), "unknown");
});
