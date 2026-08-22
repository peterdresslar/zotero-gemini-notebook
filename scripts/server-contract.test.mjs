import assert from "node:assert/strict";
import test from "node:test";

import { STAGED_CLEAR_METHOD } from "../chrome-extension/bridge-requests.js";
import {
  PRIVATE_RESPONSE_OPTIONS,
  ZOTERO_MUTATION_METHOD,
} from "../src/modules/zoteroServerContract.js";

test("keeps Chrome clear requests on Zotero's supported mutation method", () => {
  assert.equal(ZOTERO_MUTATION_METHOD, "POST");
  assert.equal(STAGED_CLEAR_METHOD, ZOTERO_MUTATION_METHOD);
});

test("filters private endpoint bodies from Zotero debug logging", () => {
  const privateResponse = JSON.stringify({
    title: "Private source title",
    fileName: "private.pdf",
    data: "base64-file-content",
  });
  const logged = PRIVATE_RESPONSE_OPTIONS.logFilter(privateResponse);

  assert.equal(logged, "[Zotero Gemini Notebook response omitted]");
  assert.equal(logged.includes("Private source title"), false);
  assert.equal(logged.includes("private.pdf"), false);
  assert.equal(logged.includes("base64-file-content"), false);
  assert.equal(Object.isFrozen(PRIVATE_RESPONSE_OPTIONS), true);
});
