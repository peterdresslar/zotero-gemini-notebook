import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const injectorSource = await readFile(
  new globalThis.URL("../chrome-extension/injector.js", import.meta.url),
  "utf8",
);

test("MAIN world does not replay or forge page events", () => {
  for (const removedSurface of [
    'command === "activate-trigger"',
    "EventTarget.prototype.addEventListener",
    "EventTarget.prototype.removeEventListener",
    "recordedListeners",
    "recordEventListener",
    "forgetEventListener",
    "invokeRecordedListeners",
    "dispatchTrustedMouseEvent",
    "createTrustedEventProxy",
    "findCandidateUploadTrigger",
    "findElementBySelector",
    "scoreUploadTrigger",
    "isTrusted",
  ]) {
    assert.equal(injectorSource.includes(removedSurface), false);
  }
});

test("only a real file input or picker can emit terminal success", () => {
  const successSites = injectorSource.match(/reply\(true, null,/gu) ?? [];
  assert.equal(successSites.length, 2);

  assert.match(
    injectorSource,
    /HTMLInputElement\.prototype\.click[\s\S]*interceptedInput = this;[\s\S]*doInject\(current\.attemptNonce\)/u,
  );
  assert.match(
    injectorSource,
    /HTMLInputElement\.prototype\.showPicker[\s\S]*interceptedInput = this;[\s\S]*doInject\(current\.attemptNonce\)/u,
  );
  assert.match(
    injectorSource,
    /window\.showOpenFilePicker = async function[\s\S]*pendingFiles\.map\(createFileHandle\)[\s\S]*reply\(true, null, current\.attemptNonce\)/u,
  );
  assert.match(
    injectorSource,
    /function doInject[\s\S]*input\.files = dt\.files;[\s\S]*new Event\("input"[\s\S]*new Event\("change"[\s\S]*reply\(true, null, current\.attemptNonce\)/u,
  );

  assert.match(injectorSource, /Synthetic drop is disabled/u);
  assert.doesNotMatch(
    injectorSource,
    /command === "drop-files"[\s\S]{0,600}reply\(true/u,
  );
});
