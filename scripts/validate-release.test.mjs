import nodeAssert from "node:assert/strict";
import test from "node:test";

import {
  assertChromeRuntimePackage,
  assertUpdateManifest,
  assertZoteroMcpRuntimePackage,
  parseUpdateHash,
  releaseContext,
} from "./validate-release.mjs";

const zoteroPackageEntries = [
  "content/scripts/zoteroNotebookLM.js",
  "content/mcp-config-dialog.xhtml",
  "content/mcp-config-dialog.css",
];
const zoteroRuntimeBundle = [
  "ZGN-LOCAL-AUTH-V1",
  "/notebooklm/control/v1/auth-check",
  "/notebooklm/control/v1/jobs",
  "application/vnd.zotero-gemini-notebook.job+json",
  "maxByteSize",
].join("\n");

const packageJSON = {
  name: "zotero-gemini-notebook",
  version: "0.3.4",
  config: {
    addonName: "Zotero Gemini Notebook",
    addonID: "zotero-notebooklm@peterdresslar.com",
  },
  companionCompatibility: {
    validVersions: ["0.3.2", "0.3.3", "0.3.4"],
  },
  repository: {
    url: "git+https://github.com/peterdresslar/zotero-gemini-notebook.git",
  },
};

const compatibility = {
  strict_min_version: "6.999",
  strict_max_version: "10.0.*",
};

const chromeManifest = {
  version: "0.3.4",
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
      js: [
        "upload-transfer.js",
        "dialog-upload-status.js",
        "gemini-controls.js",
        "content.js",
      ],
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
  "dialog-upload-status.js",
  "bridge-requests.js",
  "gemini-controls.js",
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
    "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/v0.3.4/zotero-gemini-notebook.xpi",
  );
  nodeAssert.equal(context.updateFilename, "update.json");
  nodeAssert.equal(context.unusedUpdateFilename, "update-beta.json");
});

test("release context selects only the prerelease update manifest", () => {
  const prereleaseVersion = "0.3.5-beta.1";
  const context = releaseContext({
    ...packageJSON,
    version: prereleaseVersion,
    companionCompatibility: { validVersions: [prereleaseVersion] },
  });

  nodeAssert.equal(context.updateFilename, "update-beta.json");
  nodeAssert.equal(context.unusedUpdateFilename, "update.json");
  nodeAssert.equal(
    context.manifestURL,
    "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/release/update-beta.json",
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
    /Chrome extension 0\.3\.4 must be compatible/,
  );
});

test("release context rejects invalid companion allowlists", () => {
  for (const validVersions of [
    undefined,
    [],
    ["0.3.4", null],
    ["0.3.4", "0.3.4"],
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

test("Chrome runtime package includes and loads the content helpers", () => {
  nodeAssert.doesNotThrow(() =>
    assertChromeRuntimePackage(chromeManifest, popupHTML, chromePackageEntries),
  );
});

test("Zotero runtime package retains the MCP staging boundary", () => {
  nodeAssert.doesNotThrow(() =>
    assertZoteroMcpRuntimePackage(zoteroRuntimeBundle, zoteroPackageEntries),
  );

  for (const marker of [
    "ZGN-LOCAL-AUTH-V1",
    "/notebooklm/control/v1/jobs",
    "maxByteSize",
  ]) {
    nodeAssert.throws(
      () =>
        assertZoteroMcpRuntimePackage(
          zoteroRuntimeBundle.replace(marker, ""),
          zoteroPackageEntries,
        ),
      /runtime bundle must include/u,
    );
  }
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

test("Chrome runtime package rejects missing content helpers", () => {
  for (const helperFilename of [
    "upload-transfer.js",
    "dialog-upload-status.js",
    "bridge-requests.js",
    "gemini-controls.js",
  ]) {
    nodeAssert.throws(
      () =>
        assertChromeRuntimePackage(
          chromeManifest,
          popupHTML,
          chromePackageEntries.filter((entry) => entry !== helperFilename),
        ),
      new RegExp(`must include ${helperFilename.replace(".", "\\.")}`),
    );
  }
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

test("Chrome content script loads its helpers before content.js", () => {
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

  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: ["upload-transfer.js", "content.js"],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load dialog-upload-status\.js with content\.js/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: [
                "dialog-upload-status.js",
                "upload-transfer.js",
                "gemini-controls.js",
                "content.js",
              ],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /upload-transfer\.js, dialog-upload-status\.js, gemini-controls\.js, and content\.js in that order/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: [
                "upload-transfer.js",
                "dialog-upload-status.js",
                "content.js",
              ],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load gemini-controls\.js with content\.js/,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: [
                "upload-transfer.js",
                "dialog-upload-status.js",
                "content.js",
                "gemini-controls.js",
              ],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /upload-transfer\.js, dialog-upload-status\.js, gemini-controls\.js, and content\.js in that order/,
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
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        `
          <script src="upload-transfer.js"></script>
          <script src="dialog-upload-status.js"></script>
          <script type="module" src="popup.js"></script>
        `,
        chromePackageEntries,
      ),
    /popup\.html must not load dialog-upload-status\.js/,
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
