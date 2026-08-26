import nodeAssert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  assertChromePackageByteParity,
  assertChromePackageInventory,
  assertChromeRuntimePackage,
  assertMcpAdapterByteParity,
  assertUpdateManifest,
  assertZoteroMcpRuntimePackage,
  parseUpdateHash,
  releaseContext,
} from "./validate-release.mjs";

const zoteroPackageEntries = [
  "content/scripts/zoteroNotebookLM.js",
  "content/mcp-config-dialog.xhtml",
  "content/mcp-config-dialog.css",
  "content/mcp-adapter/",
  "content/mcp-adapter/server.py",
  "content/mcp-adapter/zotero_control.py",
  "content/mcp-adapter/zotero_jobs.py",
  "content/mcp-adapter/zotero_status.py",
  "content/mcp-adapter/pyproject.toml",
  "content/mcp-adapter/uv.lock",
];
const zoteroRuntimeBundle = [
  "ZGN-LOCAL-AUTH-V1",
  "/notebooklm/control/v1/auth-check",
  '/notebooklm/control/v1/jobs"',
  '/notebooklm/control/v1/jobs/status"',
  "application/vnd.zotero-gemini-notebook.job+json",
  "application/vnd.zotero-gemini-notebook.job-status+json",
  "/notebooklm/job-claim",
  "/notebooklm/job-event",
  "application/vnd.zotero-gemini-notebook.job-claim+json",
  "application/vnd.zotero-gemini-notebook.job-event+json",
  "maxByteSize",
].join("\n");

const packageJSON = {
  name: "zotero-gemini-notebook",
  version: "0.4.0",
  config: {
    addonName: "Zotero Gemini Notebook",
    addonID: "zotero-notebooklm@peterdresslar.com",
  },
  companionCompatibility: {
    validVersions: ["0.4.0"],
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
  version: "0.4.0",
  permissions: ["activeTab"],
  host_permissions: [
    "http://127.0.0.1:23119/*",
    "https://notebook.google.com/*",
    "https://notebooklm.google.com/*",
  ],
  background: {
    service_worker: "background.js",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "https://notebook.google.com/*",
        "https://notebooklm.google.com/*",
      ],
      js: [
        "upload-transfer.js",
        "destination.js",
        "injector-attempt.js",
        "upload-handoff.js",
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
      js: ["injector-attempt.js", "injector.js"],
      world: "MAIN",
    },
  ],
};

const popupHTML = `
  <!doctype html>
  <script src="upload-transfer.js"></script>
  <script src="destination.js"></script>
  <script type="module" src="popup.js"></script>
`;

const chromePackageEntries = [
  "background.js",
  "bridge-requests.js",
  "compatibility.js",
  "content.js",
  "destination.js",
  "dialog-upload-status.js",
  "gemini-controls.js",
  "icons/",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon48.png",
  "injector-attempt.js",
  "injector.js",
  "job-lifecycle.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "source-verification.js",
  "upload-transfer.js",
  "upload-handoff.js",
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
    "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/v0.4.0/zotero-gemini-notebook.xpi",
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
    /Chrome extension 0\.4\.0 must be compatible/,
  );
});

test("release context rejects invalid companion allowlists", () => {
  for (const validVersions of [
    undefined,
    [],
    ["0.4.0", null],
    ["0.4.0", "0.4.0"],
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

test("Chrome package inventory and bytes exactly match the fixed source set", () => {
  nodeAssert.doesNotThrow(() =>
    assertChromePackageInventory(chromePackageEntries),
  );
  for (const entries of [
    chromePackageEntries.slice(1),
    [...chromePackageEntries, "debug.log"],
    [...chromePackageEntries, "manifest.json"],
  ]) {
    nodeAssert.throws(
      () => assertChromePackageInventory(entries),
      /fixed Chrome package inventory|duplicate entries/u,
    );
  }

  const sourceFiles = new Map(
    chromePackageEntries
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) => [entry, Buffer.from(`source:${entry}`)]),
  );
  const packagedFiles = new Map(
    [...sourceFiles].map(([entry, bytes]) => [entry, Buffer.from(bytes)]),
  );
  assertChromePackageByteParity(packagedFiles, sourceFiles);
  packagedFiles.set("popup.js", Buffer.from("altered"));
  nodeAssert.throws(
    () => assertChromePackageByteParity(packagedFiles, sourceFiles),
    /differs from source: popup\.js/u,
  );
});

test("Zotero runtime package retains the MCP staging boundary", () => {
  nodeAssert.doesNotThrow(() =>
    assertZoteroMcpRuntimePackage(zoteroRuntimeBundle, zoteroPackageEntries),
  );

  for (const marker of [
    "ZGN-LOCAL-AUTH-V1",
    '/notebooklm/control/v1/jobs"',
    '/notebooklm/control/v1/jobs/status"',
    "application/vnd.zotero-gemini-notebook.job-status+json",
    "/notebooklm/job-claim",
    "/notebooklm/job-event",
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

test("Zotero runtime package contains only the six adapter runtime files", () => {
  for (const requiredEntry of [
    "content/mcp-adapter/server.py",
    "content/mcp-adapter/zotero_control.py",
    "content/mcp-adapter/zotero_jobs.py",
    "content/mcp-adapter/zotero_status.py",
    "content/mcp-adapter/pyproject.toml",
    "content/mcp-adapter/uv.lock",
  ]) {
    nodeAssert.throws(
      () =>
        assertZoteroMcpRuntimePackage(
          zoteroRuntimeBundle,
          zoteroPackageEntries.filter((entry) => entry !== requiredEntry),
        ),
      /must include the bundled MCP adapter files/u,
    );
  }

  for (const unexpectedEntry of [
    "content/mcp-adapter/README.md",
    "content/mcp-adapter/tests/test_server.py",
    "content/mcp-adapter/.venv/bin/python",
    "content/mcp-adapter/__pycache__/server.cpython-313.pyc",
    "content/mcp-adapter/server.pyc",
    "content/mcp-adapter/extra.py",
  ]) {
    nodeAssert.throws(
      () =>
        assertZoteroMcpRuntimePackage(zoteroRuntimeBundle, [
          ...zoteroPackageEntries,
          unexpectedEntry,
        ]),
      /contains unexpected MCP adapter files/u,
    );
  }
});

test("Zotero runtime package adapter bytes must match their source files", () => {
  const filenames = [
    "server.py",
    "zotero_control.py",
    "zotero_jobs.py",
    "zotero_status.py",
    "pyproject.toml",
    "uv.lock",
  ];
  const sourceFiles = new Map(
    filenames.map((filename) => [filename, Buffer.from(`source:${filename}`)]),
  );
  const packagedFiles = new Map(
    filenames.map((filename) => [
      `content/mcp-adapter/${filename}`,
      Buffer.from(`source:${filename}`),
    ]),
  );

  assertMcpAdapterByteParity(packagedFiles, sourceFiles);
  packagedFiles.set("content/mcp-adapter/server.py", Buffer.from("altered"));
  nodeAssert.throws(
    () => assertMcpAdapterByteParity(packagedFiles, sourceFiles),
    /differs from source: server\.py/u,
  );
});

test("Chrome runtime package covers current and legacy notebook hosts", () => {
  for (const hostPattern of [
    "https://notebook.google.com/*",
    "https://notebooklm.google.com/*",
  ]) {
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
      /must grant exactly the fixed Zotero and Gemini Notebook host permissions/u,
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

test("Chrome lifecycle retains only the fixed host and messaging boundary", () => {
  for (const hostPermissions of [
    chromeManifest.host_permissions.filter(
      (host) => host !== "http://127.0.0.1:23119/*",
    ),
    [...chromeManifest.host_permissions, "http://localhost/*"],
    [...chromeManifest.host_permissions, chromeManifest.host_permissions[0]],
  ]) {
    nodeAssert.throws(
      () =>
        assertChromeRuntimePackage(
          { ...chromeManifest, host_permissions: hostPermissions },
          popupHTML,
          chromePackageEntries,
        ),
      /must grant exactly the fixed Zotero and Gemini Notebook host permissions/u,
    );
  }

  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          externally_connectable: { matches: ["<all_urls>"] },
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must not expose externally_connectable messaging/u,
  );
});

test("Chrome runtime package rejects missing content helpers", () => {
  for (const helperFilename of [
    "upload-transfer.js",
    "destination.js",
    "injector-attempt.js",
    "upload-handoff.js",
    "dialog-upload-status.js",
    "bridge-requests.js",
    "gemini-controls.js",
    "job-lifecycle.js",
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

test("Chrome runtime package registers the lifecycle service worker", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        { ...chromeManifest, background: undefined },
        popupHTML,
        chromePackageEntries,
      ),
    /must register background\.js as its service worker/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          background: { service_worker: "background.js" },
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load background\.js as a module/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        popupHTML,
        chromePackageEntries.filter((entry) => entry !== "background.js"),
      ),
    /must include background\.js/u,
  );
});

test("Chrome lifecycle does not add extension permissions", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        { ...chromeManifest, permissions: ["activeTab", "storage"] },
        popupHTML,
        chromePackageEntries,
      ),
    /must retain only the activeTab extension permission/u,
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
              js: [
                "upload-transfer.js",
                "destination.js",
                "injector-attempt.js",
                "upload-handoff.js",
                "content.js",
              ],
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
                "upload-transfer.js",
                "destination.js",
                "injector-attempt.js",
                "dialog-upload-status.js",
                "gemini-controls.js",
                "content.js",
              ],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load upload-handoff\.js with content\.js/,
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
                "destination.js",
                "injector-attempt.js",
                "upload-handoff.js",
                "gemini-controls.js",
                "content.js",
              ],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /upload-transfer\.js, destination\.js, injector-attempt\.js, upload-handoff\.js, dialog-upload-status\.js, gemini-controls\.js, and content\.js in that order/,
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
                "destination.js",
                "injector-attempt.js",
                "upload-handoff.js",
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
                "destination.js",
                "injector-attempt.js",
                "upload-handoff.js",
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
    /upload-transfer\.js, destination\.js, injector-attempt\.js, upload-handoff\.js, dialog-upload-status\.js, gemini-controls\.js, and content\.js in that order/,
  );
});

test("Chrome destination helper is packaged and loaded before handoff", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        popupHTML,
        chromePackageEntries.filter((entry) => entry !== "destination.js"),
      ),
    /must include destination\.js/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: chromeManifest.content_scripts[0].js.filter(
                (entry) => entry !== "destination.js",
              ),
            },
            chromeManifest.content_scripts[1],
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load destination\.js with content\.js/u,
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
                "upload-handoff.js",
                "destination.js",
                "injector-attempt.js",
                "dialog-upload-status.js",
                "gemini-controls.js",
                "content.js",
              ],
            },
            chromeManifest.content_scripts[1],
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /upload-transfer\.js, destination\.js, injector-attempt\.js, upload-handoff\.js/u,
  );
});

test("Chrome injector attempt guard is loaded in both execution worlds", () => {
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        popupHTML,
        chromePackageEntries.filter((entry) => entry !== "injector-attempt.js"),
      ),
    /must include injector-attempt\.js/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            {
              ...chromeManifest.content_scripts[0],
              js: chromeManifest.content_scripts[0].js.filter(
                (entry) => entry !== "injector-attempt.js",
              ),
            },
            chromeManifest.content_scripts[1],
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load injector-attempt\.js with content\.js/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        {
          ...chromeManifest,
          content_scripts: [
            chromeManifest.content_scripts[0],
            {
              ...chromeManifest.content_scripts[1],
              js: ["injector.js", "injector-attempt.js"],
            },
          ],
        },
        popupHTML,
        chromePackageEntries,
      ),
    /must load injector-attempt\.js before injector\.js in the MAIN world/u,
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
          <script type="module" src="popup.js"></script>
        `,
        chromePackageEntries,
      ),
    /popup\.html must load destination\.js/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        `
          <script src="destination.js"></script>
          <script src="upload-transfer.js"></script>
          <script type="module" src="popup.js"></script>
        `,
        chromePackageEntries,
      ),
    /upload-transfer\.js, destination\.js, and popup\.js in that order/u,
  );
  nodeAssert.throws(
    () =>
      assertChromeRuntimePackage(
        chromeManifest,
        `
          <script src="upload-transfer.js"></script>
          <script src="destination.js"></script>
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
