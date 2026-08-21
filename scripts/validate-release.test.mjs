import nodeAssert from "node:assert/strict";
import test from "node:test";

import {
  assertChromeRuntimePackage,
  assertUpdateManifest,
  parseUpdateHash,
  releaseContext,
} from "./validate-release.mjs";

const packageJSON = {
  name: "zotero-gemini-notebook",
  version: "0.3.2",
  config: {
    addonName: "Zotero Gemini Notebook",
    addonID: "zotero-notebooklm@peterdresslar.com",
  },
  companionCompatibility: {
    validVersions: ["0.3.2"],
  },
  repository: {
    url: "git+https://github.com/peterdresslar/zotero-gemini-notebook.git",
  },
};

const compatibility = {
  strict_min_version: "6.999",
  strict_max_version: "9.*",
};

const chromeManifest = {
  version: "0.3.2",
  host_permissions: [
    "https://notebook.google.com/*",
    "https://notebooklm.google.com/*",
  ],
  content_scripts: [
    {
      matches: [
        "https://notebook.google.com/*",
        "https://notebooklm.google.com/*",
      ],
      js: ["upload-transfer.js", "content.js"],
    },
    {
      matches: [
        "https://notebook.google.com/*",
        "https://notebooklm.google.com/*",
      ],
      js: ["injector.js"],
      world: "MAIN",
    },
  ],
};

const popupHTML = `
  <!doctype html>
  <script src="upload-transfer.js"></script>
  <script type="module" src="popup.js"></script>
`;

const chromePackageEntries = [
  "manifest.json",
  "upload-transfer.js",
  "content.js",
  "injector.js",
  "popup.html",
  "popup.js",
];

function updateManifest(expected, overrides = {}) {
  return {
    addons: {
      [expected.addonID]: {
        updates: [
          {
            version: expected.version,
            update_link: expected.xpiURL,
            update_hash: `sha512:${"a".repeat(128)}`,
            applications: { zotero: compatibility },
            ...overrides,
          },
        ],
      },
    },
  };
}

test("release context pins the stable identity and URLs", () => {
  const context = releaseContext(packageJSON);
  nodeAssert.equal(context.addonID, packageJSON.config.addonID);
  nodeAssert.deepEqual(
    context.compatibleChromeExtensionVersions,
    packageJSON.companionCompatibility.validVersions,
  );
  nodeAssert.equal(
    context.manifestURL,
    "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/release/update.json",
  );
  nodeAssert.equal(
    context.legacyManifestURL,
    "https://github.com/peterdresslar/zotero-notebooklm/releases/download/release/update.json",
  );
  nodeAssert.equal(
    context.xpiURL,
    "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/v0.3.2/zotero-gemini-notebook.xpi",
  );
});

test("release context rejects an add-on ID change", () => {
  nodeAssert.throws(
    () =>
      releaseContext({
        ...packageJSON,
        config: { ...packageJSON.config, addonID: "renamed@example.com" },
      }),
    /must remain zotero-notebooklm@peterdresslar\.com/,
  );
});

test("release context rejects an artifact-name change", () => {
  nodeAssert.throws(
    () => releaseContext({ ...packageJSON, name: "renamed-package" }),
    /Package name must remain zotero-gemini-notebook/,
  );
});

test("release context rejects a companion excluded by its paired plugin", () => {
  nodeAssert.throws(
    () =>
      releaseContext({
        ...packageJSON,
        companionCompatibility: {
          validVersions: ["0.3.1"],
        },
      }),
    /Chrome extension 0\.3\.2 must be compatible/,
  );
});

test("release context rejects invalid companion allowlists", () => {
  for (const validVersions of [
    undefined,
    [],
    ["0.3.2", null],
    ["0.3.2", "0.3.2"],
  ]) {
    nodeAssert.throws(() =>
      releaseContext({
        ...packageJSON,
        companionCompatibility:
          validVersions === undefined ? undefined : { validVersions },
      }),
    );
  }
});

test("Chrome runtime package includes and loads the transfer helper", () => {
  nodeAssert.doesNotThrow(() =>
    assertChromeRuntimePackage(chromeManifest, popupHTML, chromePackageEntries),
  );
});

test("Chrome runtime package covers current and legacy notebook hosts", () => {
  for (const hostPattern of chromeManifest.host_permissions) {
    nodeAssert.throws(
      () =>
        assertChromeRuntimePackage(
          {
            ...chromeManifest,
            host_permissions: chromeManifest.host_permissions.filter(
              (host) => host !== hostPattern,
            ),
          },
          popupHTML,
          chromePackageEntries,
        ),
      /must grant host permission/,
    );

    for (const scriptFilename of ["content.js", "injector.js"]) {
      nodeAssert.throws(
        () =>
          assertChromeRuntimePackage(
            {
              ...chromeManifest,
              content_scripts: chromeManifest.content_scripts.map((entry) =>
                entry.js.includes(scriptFilename)
                  ? {
                      ...entry,
                      matches: entry.matches.filter(
                        (host) => host !== hostPattern,
                      ),
                    }
                  : entry,
              ),
            },
            popupHTML,
            chromePackageEntries,
          ),
        new RegExp(`must load ${scriptFilename.replace(".", "\\.")} on`),
      );
    }
  }
});

test("Chrome runtime package rejects a missing transfer helper", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        popupHTML,
        chromePackageEntries.filter((entry) => entry !== "upload-transfer.js"),
      ),
    /must include upload-transfer\.js/,
  );
});

test("Chrome runtime package includes its declared content scripts", () => {
  for (const scriptFilename of ["content.js", "injector.js"]) {
    nodeAssert.throws(
      () =>
        assertChromeRuntimePackage(
          chromeManifest,
          popupHTML,
          chromePackageEntries.filter((entry) => entry !== scriptFilename),
        ),
      new RegExp(`must include ${scriptFilename.replace(".", "\\.")}`),
    );
  }
});

test("Chrome content script loads the transfer helper before content.js", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: ["content.js"],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load upload-transfer\.js with content\.js/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: ["content.js", "upload-transfer.js"],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load upload-transfer\.js before content\.js/,
  );
});

test("Chrome popup loads the transfer helper before module popup.js", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        '<script type="module" src="popup.js"></script>',
        chromePackageEntries,
      ),
    /popup\.html must load upload-transfer\.js/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        `
          <script type="module" src="popup.js"></script>
          <script src="upload-transfer.js"></script>
        `,
        chromePackageEntries,
      ),
    /must load upload-transfer\.js before popup\.js/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        `
          <script src="upload-transfer.js"></script>
          <script src="popup.js"></script>
        `,
        chromePackageEntries,
      ),
    /must load popup\.js as a module/,
  );
});

test("update hashes accept supported SHA-512 values", () => {
  nodeAssert.deepEqual(parseUpdateHash(`sha512:${"a".repeat(128)}`), {
    algorithm: "sha512",
    digest: "a".repeat(128),
  });
  nodeAssert.throws(() => parseUpdateHash("md5:abc"), /Unsupported/);
});

test("update manifest must point to the expected versioned XPI", () => {
  const context = releaseContext(packageJSON);
  nodeAssert.doesNotThrow(() =>
    assertUpdateManifest(updateManifest(context), context, compatibility),
  );
  nodeAssert.throws(
    () =>
      assertUpdateManifest(
        updateManifest(context, {
          update_link: "https://example.com/wrong.xpi",
        }),
        context,
        compatibility,
      ),
    /Update link is/,
  );
});
