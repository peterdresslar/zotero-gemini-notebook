import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { STAGED_CLEAR_METHOD } from "../chrome-extension/bridge-requests.js";
import {
  createStatusResponse,
  PRIVATE_RESPONSE_OPTIONS,
  ZOTERO_MUTATION_METHOD,
} from "../src/modules/zoteroServerContract.js";

const serverSource = await readFile(
  new globalThis.URL("../src/modules/server.ts", import.meta.url),
  "utf8",
);

test("keeps Chrome clear requests on Zotero's supported mutation method", () => {
  assert.equal(ZOTERO_MUTATION_METHOD, "POST");
  assert.equal(STAGED_CLEAR_METHOD, ZOTERO_MUTATION_METHOD);
  assert.match(
    serverSource,
    /supportedMethods: \[ZOTERO_MUTATION_METHOD, "DELETE", "OPTIONS"\]/u,
  );
});

test("builds an allowlisted status response with strict MCP opt-in", () => {
  const response = createStatusResponse({
    ready: true,
    count: 2,
    zoteroVersion: "10.0.4",
    pluginVersion: "Zotero Gemini Notebook 0.4.0",
    mcpOptedIn: true,
    runtimePath: "/private/runtime",
    adapterPath: "/private/server.py",
    clientConfigPath: "/private/config.toml",
    token: "secret",
  });

  assert.deepEqual(response, {
    ready: true,
    count: 2,
    zoteroVersion: "10.0.4",
    pluginVersion: "Zotero Gemini Notebook 0.4.0",
    mcpOptedIn: true,
  });
  assert.equal(Object.isFrozen(response), true);

  for (const mcpOptedIn of [false, undefined, null, "true", 1, {}]) {
    assert.equal(
      createStatusResponse({
        ready: false,
        count: 0,
        zoteroVersion: "10.0.4",
        pluginVersion: "Zotero Gemini Notebook 0.4.0",
        mcpOptedIn,
      }).mcpOptedIn,
      false,
    );
  }
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

test("revalidates each staged file against its private read bound", () => {
  assert.match(serverSource, /getStagedAttachmentAccess/u);
  assert.match(serverSource, /IOUtils\.stat\(filePath\)/u);
  assert.match(serverSource, /assertStagedFileReadPolicy/u);
  assert.match(serverSource, /readFileAsBase64\(filePath, maxByteSize\)/u);
  assert.match(serverSource, /error instanceof FileReadPolicyError/u);
});
