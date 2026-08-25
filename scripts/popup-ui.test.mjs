import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const popupHTML = await readFile(
  new globalThis.URL("../chrome-extension/popup.html", import.meta.url),
  "utf8",
);

function readStyleRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = popupHTML.match(
    new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "u"),
  );
  assert.ok(match?.groups?.body, `Missing ${selector} style rule`);
  return match.groups.body;
}

test("aligns popup progress text to the existing 16px content inset", () => {
  assert.match(
    popupHTML,
    /<div class="progress-text" id="progress-text"><\/div>/u,
  );
  const progressTextRule = readStyleRule(".progress-text");
  assert.match(progressTextRule, /margin-top:\s*4px;/u);
  assert.match(progressTextRule, /padding-inline:\s*16px;/u);
  assert.match(progressTextRule, /overflow-wrap:\s*anywhere;/u);
  assert.match(readStyleRule(".content"), /padding:\s*12px 16px;/u);
  assert.match(readStyleRule(".actions"), /padding:\s*12px 16px;/u);

  const progressRule = readStyleRule(".progress");
  assert.match(progressRule, /margin:\s*8px 0;/u);
  assert.doesNotMatch(progressRule, /padding/u);
});
