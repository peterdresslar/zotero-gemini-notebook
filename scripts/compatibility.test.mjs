import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChromeCompanionCompatibility,
  COMPANION_COMPATIBILITY,
  getCompatibilityWarningCopy,
} from "../chrome-extension/compatibility.js";

const { COMPATIBLE, CHROME_UPDATE_REQUIRED, ZOTERO_UPDATE_REQUIRED, UNKNOWN } =
  COMPANION_COMPATIBILITY;

test("accepts the legacy backend when compatibility metadata is absent", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(undefined, "0.3.0"),
    COMPATIBLE,
  );
});

test("accepts a companion version listed by the backend", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.2.0", "0.3.0"], "0.3.0"),
    COMPATIBLE,
  );
});

test("accepts an explicitly listed prerelease without directional inference", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.4-beta.1"], "0.3.4-beta.1"),
    COMPATIBLE,
  );
});

test("directs the reported v0.3.2 and v0.3.1 mismatch to the Zotero updater", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.1"], "0.3.2"),
    ZOTERO_UPDATE_REQUIRED,
  );
});

test("v0.3.3 Zotero accepts v0.3.2 Chrome but still rejects v0.3.1 Chrome", () => {
  const compatibleVersions = ["0.3.2", "0.3.3"];
  assert.equal(
    classifyChromeCompanionCompatibility(compatibleVersions, "0.3.2"),
    COMPATIBLE,
  );
  assert.equal(
    classifyChromeCompanionCompatibility(compatibleVersions, "0.3.1"),
    CHROME_UPDATE_REQUIRED,
  );
});

test("requires a Zotero update when Chrome is newer than every advertised version", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.0", "0.3.1"], "0.3.2"),
    ZOTERO_UPDATE_REQUIRED,
  );
});

test("requires a Chrome update when Chrome is older than every advertised version", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.1", "0.3.2"], "0.3.0"),
    CHROME_UPDATE_REQUIRED,
  );
});

test("compares numeric version components instead of sorting version strings", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.9"], "0.3.10"),
    ZOTERO_UPDATE_REQUIRED,
  );
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.10"], "0.3.9"),
    CHROME_UPDATE_REQUIRED,
  );
});

test("does not guess an update target for an omitted version inside the advertised range", () => {
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.0", "0.3.2"], "0.3.1"),
    UNKNOWN,
  );
});

test("does not guess an update target from malformed compatibility metadata", () => {
  assert.equal(classifyChromeCompanionCompatibility(null, "0.3.0"), UNKNOWN);
  assert.equal(classifyChromeCompanionCompatibility("0.3.0", "0.3.0"), UNKNOWN);
  assert.equal(classifyChromeCompanionCompatibility([], "0.3.0"), UNKNOWN);
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.0", null], "0.3.0"),
    UNKNOWN,
  );
  assert.equal(
    classifyChromeCompanionCompatibility(["0.3.0"], "0.3.0-beta.1"),
    UNKNOWN,
  );
});

test("provides Zotero update instructions for a newer Chrome companion", () => {
  assert.deepEqual(
    getCompatibilityWarningCopy(ZOTERO_UPDATE_REQUIRED, "0.3.2"),
    {
      status: "Zotero plugin update required",
      heading:
        "Chrome companion version 0.3.2 is newer than the installed Zotero plugin",
      guidance:
        "In Zotero, open Tools \u2192 Plugins, open the gear menu, choose Check for Updates, then return here and click Refresh.",
      linkText: "View releases and install the newest Zotero plugin",
    },
  );
});

test("provides Chrome update instructions for an older Chrome companion", () => {
  assert.deepEqual(
    getCompatibilityWarningCopy(CHROME_UPDATE_REQUIRED, "0.3.0"),
    {
      status: "Chrome companion update required",
      heading:
        "Chrome companion version 0.3.0 is older than the installed Zotero plugin",
      guidance:
        "Download the latest Chrome companion, replace the files in its existing folder, then click Reload on chrome://extensions/.",
      linkText: "View releases and install the newest Chrome companion",
    },
  );
});

test("provides neutral instructions when the mismatch direction is unknown", () => {
  assert.deepEqual(getCompatibilityWarningCopy(UNKNOWN, "0.3.1"), {
    status: "Version compatibility could not be determined",
    heading:
      "Chrome companion version 0.3.1 could not be matched to the installed Zotero plugin",
    guidance:
      "Update the Zotero plugin and Chrome companion to the latest release, then click Refresh.",
    linkText: "View the latest release files",
  });
});

test("does not provide warning copy for a compatible pair", () => {
  assert.equal(getCompatibilityWarningCopy(COMPATIBLE, "0.3.2"), null);
});
