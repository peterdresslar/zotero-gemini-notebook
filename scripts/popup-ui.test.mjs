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

test("discloses the Zotero file transfer immediately before import", () => {
  assert.match(popupHTML, /<h1>Zotero-Gemini Notebook Connector<\/h1>/u);
  assert.match(
    popupHTML,
    /<p id="import-disclosure" class="import-disclosure">\s*Selected files go directly to Google Gemini Notebook\.<br \/>\s*The developer does not receive them\.\s*<a\s+href="https:\/\/github\.com\/peterdresslar\/zotero-gemini-notebook\/blob\/main\/PRIVACY\.md"\s+target="_blank"\s+rel="noopener noreferrer"\s*>Privacy policy<\/a\s*>\s*<\/p>\s*<div class="actions">/u,
  );
  assert.match(
    popupHTML,
    /<button\s+id="import-btn"\s+class="primary"\s+aria-describedby="import-disclosure"\s+disabled\s*>/u,
  );

  const disclosureRule = readStyleRule(".import-disclosure");
  assert.match(disclosureRule, /padding:\s*6px 16px;/u);
  assert.match(disclosureRule, /font-size:\s*12px;/u);
  assert.match(disclosureRule, /line-height:\s*1\.4;/u);
  assert.match(disclosureRule, /background:\s*#e8f0fe;/u);
  assert.match(disclosureRule, /border-top:\s*1px solid #d2e3fc;/u);
});
