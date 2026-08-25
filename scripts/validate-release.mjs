#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const buildDirectory = join(projectRoot, ".scaffold", "build");
const stableAddonID = "zotero-notebooklm@peterdresslar.com";
const stableRepository = "peterdresslar/zotero-gemini-notebook";
const stablePackageName = "zotero-gemini-notebook";
const legacyRepository = "peterdresslar/zotero-notebooklm";
const allowedHashAlgorithms = new Set(["sha256", "sha512"]);
const uploadTransferFilename = "upload-transfer.js";
const uploadHandoffFilename = "upload-handoff.js";
const dialogUploadStatusFilename = "dialog-upload-status.js";
const bridgeRequestsFilename = "bridge-requests.js";
const geminiControlsFilename = "gemini-controls.js";
const jobLifecycleFilename = "job-lifecycle.js";
const backgroundFilename = "background.js";
const zoteroRuntimeBundleEntry = "content/scripts/zoteroNotebookLM.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJSON(path, description) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${description} at ${path}`, {
      cause: error,
    });
  }
}

async function assertFile(path, description) {
  try {
    const file = await stat(path);
    assert(file.isFile(), `${description} is not a file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(description)) {
      throw error;
    }
    throw new Error(`Missing ${description}: ${path}`, { cause: error });
  }
}

function readArchiveEntry(archivePath, entryPath) {
  try {
    return execFileSync("unzip", ["-p", archivePath, entryPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Could not read ${entryPath} from ${basename(archivePath)}. ` +
        "Install the unzip command and confirm the archive is valid.",
      { cause: error },
    );
  }
}

function readArchiveJSON(archivePath, entryPath) {
  try {
    return JSON.parse(readArchiveEntry(archivePath, entryPath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${entryPath} in ${basename(archivePath)} is not valid JSON`,
        { cause: error },
      );
    }
    throw error;
  }
}

function listArchiveEntries(archivePath) {
  try {
    return execFileSync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Could not inspect ${basename(archivePath)}`, {
      cause: error,
    });
  }
}

function assertArchiveHygiene(
  archivePath,
  entries = listArchiveEntries(archivePath),
) {
  const unwanted = entries.filter(
    (entry) =>
      entry.includes("__MACOSX/") ||
      entry.endsWith(".DS_Store") ||
      entry.includes(".test.") ||
      entry.startsWith(".git/") ||
      entry.includes("/.git/"),
  );
  assert(
    unwanted.length === 0,
    `${basename(archivePath)} contains unwanted files: ${unwanted.join(", ")}`,
  );
}

function assertArchiveIntegrity(archivePath) {
  try {
    execFileSync("unzip", ["-tqq", archivePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`${basename(archivePath)} failed its ZIP integrity check`, {
      cause: error,
    });
  }
}

function repositoryFromPackage(packageJSON) {
  const repositoryURL = packageJSON.repository?.url;
  assert(
    typeof repositoryURL === "string",
    "package.json must declare repository.url",
  );

  const normalizedURL = repositoryURL.replace(/^git\+/, "");
  const parsedURL = new URL(normalizedURL);
  assert(
    parsedURL.hostname === "github.com",
    `Repository must be hosted on github.com: ${repositoryURL}`,
  );
  const parts = parsedURL.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  assert(parts.length === 2, `Unsupported repository URL: ${repositoryURL}`);
  return parts.join("/");
}

function releaseContext(packageJSON) {
  const repository = repositoryFromPackage(packageJSON);
  assert(
    repository === stableRepository,
    `Repository changed from ${stableRepository} to ${repository}. ` +
      "Update the release validator intentionally if the repository moves.",
  );
  assert(
    packageJSON.config?.addonID === stableAddonID,
    `Zotero add-on ID must remain ${stableAddonID}`,
  );
  assert(
    typeof packageJSON.version === "string" && packageJSON.version.length > 0,
    "package.json must declare a version",
  );
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJSON.version),
    `Unsupported release version: ${packageJSON.version}`,
  );
  assert(
    packageJSON.name === stablePackageName,
    `Package name must remain ${stablePackageName}`,
  );
  const compatibleChromeExtensionVersions =
    packageJSON.companionCompatibility?.validVersions;
  assert(
    Array.isArray(compatibleChromeExtensionVersions) &&
      compatibleChromeExtensionVersions.length > 0,
    "package.json must declare compatible Chrome extension versions",
  );
  assert(
    compatibleChromeExtensionVersions.every(
      (candidate) =>
        typeof candidate === "string" &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate),
    ),
    "Compatible Chrome extension versions must be valid versions",
  );
  assert(
    new Set(compatibleChromeExtensionVersions).size ===
      compatibleChromeExtensionVersions.length,
    "Compatible Chrome extension versions must not contain duplicates",
  );
  assert(
    compatibleChromeExtensionVersions.includes(packageJSON.version),
    `Chrome extension ${packageJSON.version} must be compatible with its paired Zotero plugin`,
  );

  const prerelease = packageJSON.version.includes("-");
  const updateFilename = prerelease ? "update-beta.json" : "update.json";
  const unusedUpdateFilename = prerelease ? "update.json" : "update-beta.json";
  const xpiFilename = `${packageJSON.name}.xpi`;
  const chromeFilename = `${packageJSON.name}-chrome-extension.zip`;
  const releaseBase = `https://github.com/${repository}/releases/download`;

  return {
    addonID: stableAddonID,
    addonName: packageJSON.config.addonName,
    chromeFilename,
    chromeVersion: packageJSON.version,
    compatibleChromeExtensionVersions,
    legacyManifestURL: `https://github.com/${legacyRepository}/releases/download/release/${updateFilename}`,
    manifestURL: `${releaseBase}/release/${updateFilename}`,
    prerelease,
    repository,
    updateFilename,
    unusedUpdateFilename,
    version: packageJSON.version,
    xpiFilename,
    xpiURL: `${releaseBase}/v${packageJSON.version}/${xpiFilename}`,
  };
}

function assertZoteroManifest(manifest, expected) {
  const zotero = manifest.applications?.zotero;
  assert(zotero, "The XPI manifest must declare applications.zotero");
  assert(
    manifest.name === expected.addonName,
    `XPI name is ${manifest.name}; expected ${expected.addonName}`,
  );
  assert(
    manifest.version === expected.version,
    `XPI version is ${manifest.version}; expected ${expected.version}`,
  );
  assert(
    zotero.id === expected.addonID,
    `XPI add-on ID is ${zotero.id}; expected ${expected.addonID}`,
  );
  assert(
    zotero.update_url === expected.manifestURL,
    `XPI update URL is ${zotero.update_url}; expected ${expected.manifestURL}`,
  );
  assert(
    typeof zotero.strict_min_version === "string" &&
      zotero.strict_min_version.length > 0,
    "XPI manifest must declare strict_min_version",
  );
  assert(
    typeof zotero.strict_max_version === "string" &&
      zotero.strict_max_version.length > 0,
    "XPI manifest must declare strict_max_version",
  );
  return zotero;
}

function assertHistoricalZoteroManifest(manifest, expected) {
  const zotero = manifest.applications?.zotero;
  assert(zotero, "The XPI manifest must declare applications.zotero");
  assert(
    manifest.version === expected.version,
    `XPI version is ${manifest.version}; expected ${expected.version}`,
  );
  assert(
    zotero.id === expected.addonID,
    `XPI add-on ID is ${zotero.id}; expected ${expected.addonID}`,
  );
  assert(
    [expected.manifestURL, expected.legacyManifestURL].includes(
      zotero.update_url,
    ),
    `Historical XPI has an unexpected update URL: ${zotero.update_url}`,
  );
  assert(
    typeof zotero.strict_min_version === "string" &&
      zotero.strict_min_version.length > 0,
    "XPI manifest must declare strict_min_version",
  );
  assert(
    typeof zotero.strict_max_version === "string" &&
      zotero.strict_max_version.length > 0,
    "XPI manifest must declare strict_max_version",
  );
  return zotero;
}

function assertHistoricalXPIURL(url, version) {
  const parsedURL = new URL(url);
  assert(parsedURL.protocol === "https:", "Historical XPI URL must use HTTPS");
  assert(
    parsedURL.hostname === "github.com",
    "Historical XPI URL must use github.com",
  );
  const parts = parsedURL.pathname.replace(/^\//, "").split("/");
  assert(
    parts.length === 6 &&
      parts[0] === "peterdresslar" &&
      ["zotero-gemini-notebook", "zotero-notebooklm"].includes(parts[1]) &&
      parts[2] === "releases" &&
      parts[3] === "download" &&
      parts[4] === `v${version}` &&
      parts[5].endsWith(".xpi"),
    `Historical update link is not a recognized v${version} XPI URL: ${url}`,
  );
}

function assertChromeManifest(manifest, expected) {
  assert(
    manifest.version === expected.chromeVersion,
    `Chrome extension version is ${manifest.version}; ` +
      `expected ${expected.chromeVersion}`,
  );
}

function assertChromeRuntimePackage(
  manifest,
  popupHTML,
  packageEntries,
  description = "Chrome extension",
) {
  const notebookHostPatterns = [
    "https://notebook.google.com/*",
    "https://notebooklm.google.com/*",
  ];
  const requiredHostPatterns = [
    "http://127.0.0.1:23119/*",
    ...notebookHostPatterns,
  ];
  const requiredRuntimeFilenames = [
    uploadTransferFilename,
    uploadHandoffFilename,
    dialogUploadStatusFilename,
    bridgeRequestsFilename,
    geminiControlsFilename,
    jobLifecycleFilename,
    backgroundFilename,
    "content.js",
    "injector.js",
  ];

  for (const filename of requiredRuntimeFilenames) {
    assert(
      packageEntries.includes(filename),
      `${description} must include ${filename}`,
    );
  }

  assert(
    Array.isArray(manifest.host_permissions) &&
      manifest.host_permissions.length === requiredHostPatterns.length &&
      requiredHostPatterns.every((pattern) =>
        manifest.host_permissions.includes(pattern),
      ) &&
      new Set(manifest.host_permissions).size === requiredHostPatterns.length,
    `${description} manifest must grant exactly the fixed Zotero and Gemini Notebook host permissions`,
  );

  assert(
    Array.isArray(manifest.permissions) &&
      manifest.permissions.length === 1 &&
      manifest.permissions[0] === "activeTab",
    `${description} manifest must retain only the activeTab extension permission`,
  );
  assert(
    manifest.externally_connectable === undefined,
    `${description} manifest must not expose externally_connectable messaging`,
  );

  assert(
    manifest.background?.service_worker === backgroundFilename,
    `${description} manifest must register ${backgroundFilename} as its service worker`,
  );
  assert(
    manifest.background?.type === "module",
    `${description} manifest must load ${backgroundFilename} as a module`,
  );

  const contentScript = manifest.content_scripts?.find((entry) =>
    entry.js?.includes("content.js"),
  );
  assert(
    contentScript,
    `${description} manifest must load content.js as a content script`,
  );
  const contentScriptIndex = contentScript.js.indexOf("content.js");
  const transferScriptIndex = contentScript.js.indexOf(uploadTransferFilename);
  const handoffScriptIndex = contentScript.js.indexOf(uploadHandoffFilename);
  const dialogStatusScriptIndex = contentScript.js.indexOf(
    dialogUploadStatusFilename,
  );
  const geminiControlsScriptIndex = contentScript.js.indexOf(
    geminiControlsFilename,
  );
  assert(
    transferScriptIndex !== -1,
    `${description} manifest must load ${uploadTransferFilename} with content.js`,
  );
  assert(
    transferScriptIndex < contentScriptIndex,
    `${description} manifest must load ${uploadTransferFilename} before content.js`,
  );
  assert(
    handoffScriptIndex !== -1,
    `${description} manifest must load ${uploadHandoffFilename} with content.js`,
  );
  assert(
    dialogStatusScriptIndex !== -1,
    `${description} manifest must load ${dialogUploadStatusFilename} with content.js`,
  );
  assert(
    geminiControlsScriptIndex !== -1,
    `${description} manifest must load ${geminiControlsFilename} with content.js`,
  );
  assert(
    transferScriptIndex < handoffScriptIndex &&
      handoffScriptIndex < dialogStatusScriptIndex &&
      dialogStatusScriptIndex < geminiControlsScriptIndex &&
      geminiControlsScriptIndex < contentScriptIndex,
    `${description} manifest must load ${uploadTransferFilename}, ` +
      `${uploadHandoffFilename}, ${dialogUploadStatusFilename}, ` +
      `${geminiControlsFilename}, and content.js ` +
      "in that order",
  );
  for (const hostPattern of notebookHostPatterns) {
    assert(
      contentScript.matches?.includes(hostPattern),
      `${description} manifest must load content.js on ${hostPattern}`,
    );
  }

  const injectorScript = manifest.content_scripts?.find((entry) =>
    entry.js?.includes("injector.js"),
  );
  assert(
    injectorScript,
    `${description} manifest must load injector.js as a content script`,
  );
  assert(
    injectorScript.world === "MAIN",
    `${description} manifest must load injector.js in the MAIN world`,
  );
  for (const hostPattern of notebookHostPatterns) {
    assert(
      injectorScript.matches?.includes(hostPattern),
      `${description} manifest must load injector.js on ${hostPattern}`,
    );
  }

  const scriptTags = Array.from(
    popupHTML.matchAll(/<script\b(?<attributes>[^>]*)>/giu),
    (match) => {
      const attributes = match.groups?.attributes ?? "";
      const source = /\bsrc\s*=\s*["'](?<source>[^"']+)["']/iu.exec(attributes)
        ?.groups?.source;
      const type = /\btype\s*=\s*["'](?<type>[^"']+)["']/iu.exec(attributes)
        ?.groups?.type;
      return { source, type };
    },
  );
  const popupScriptIndex = scriptTags.findIndex(
    ({ source }) => source === "popup.js",
  );
  const popupTransferIndex = scriptTags.findIndex(
    ({ source }) => source === uploadTransferFilename,
  );
  const popupDialogStatusIndex = scriptTags.findIndex(
    ({ source }) => source === dialogUploadStatusFilename,
  );
  assert(
    popupTransferIndex !== -1,
    `${description} popup.html must load ${uploadTransferFilename}`,
  );
  assert(
    popupScriptIndex !== -1,
    `${description} popup.html must load popup.js`,
  );
  assert(
    scriptTags[popupScriptIndex].type?.toLowerCase() === "module",
    `${description} popup.html must load popup.js as a module`,
  );
  assert(
    popupTransferIndex < popupScriptIndex,
    `${description} popup.html must load ${uploadTransferFilename} before popup.js`,
  );
  assert(
    popupDialogStatusIndex === -1,
    `${description} popup.html must not load ${dialogUploadStatusFilename}`,
  );
}

function assertZoteroMcpRuntimePackage(
  bundle,
  packageEntries,
  description = "Zotero XPI",
) {
  for (const entry of [
    zoteroRuntimeBundleEntry,
    "content/mcp-config-dialog.xhtml",
    "content/mcp-config-dialog.css",
  ]) {
    assert(
      packageEntries.includes(entry),
      `${description} must include ${entry}`,
    );
  }

  for (const marker of [
    "ZGN-LOCAL-AUTH-V1",
    "/notebooklm/control/v1/auth-check",
    "/notebooklm/control/v1/jobs",
    "application/vnd.zotero-gemini-notebook.job+json",
    "/notebooklm/job-claim",
    "/notebooklm/job-event",
    "application/vnd.zotero-gemini-notebook.job-claim+json",
    "application/vnd.zotero-gemini-notebook.job-event+json",
    "maxByteSize",
  ]) {
    assert(
      bundle.includes(marker),
      `${description} runtime bundle must include ${marker}`,
    );
  }
}

function parseUpdateHash(updateHash) {
  assert(
    typeof updateHash === "string",
    "Update entry must declare update_hash",
  );
  const match = /^(sha256|sha512):([0-9a-f]+)$/i.exec(updateHash);
  assert(match, `Unsupported update_hash: ${updateHash}`);
  const algorithm = match[1].toLowerCase();
  const digest = match[2].toLowerCase();
  assert(
    allowedHashAlgorithms.has(algorithm),
    `Unsupported update hash algorithm: ${algorithm}`,
  );
  const expectedLength = createHash(algorithm).digest("hex").length;
  assert(
    digest.length === expectedLength,
    `${algorithm} digest has ${digest.length} characters; ` +
      `expected ${expectedLength}`,
  );
  return { algorithm, digest };
}

function assertUpdateManifest(manifest, expected, zoteroCompatibility) {
  const addonKeys = Object.keys(manifest.addons ?? {});
  assert(
    addonKeys.length === 1 && addonKeys[0] === expected.addonID,
    `Update manifest must contain only ${expected.addonID}`,
  );

  const updates = manifest.addons[expected.addonID]?.updates;
  assert(
    Array.isArray(updates),
    "Update manifest must contain an updates array",
  );
  const matches = updates.filter(
    (update) => update.version === expected.version,
  );
  assert(
    matches.length === 1,
    `Update manifest must contain exactly one ${expected.version} entry`,
  );

  const update = matches[0];
  assert(
    update.update_link === expected.xpiURL,
    `Update link is ${update.update_link}; expected ${expected.xpiURL}`,
  );

  const compatibility = update.applications?.zotero;
  assert(
    compatibility?.strict_min_version ===
      zoteroCompatibility.strict_min_version,
    "Update manifest strict_min_version does not match the XPI manifest",
  );
  assert(
    compatibility?.strict_max_version ===
      zoteroCompatibility.strict_max_version,
    "Update manifest strict_max_version does not match the XPI manifest",
  );

  return { hash: parseUpdateHash(update.update_hash), update };
}

async function hashFile(path, algorithm) {
  return createHash(algorithm)
    .update(await readFile(path))
    .digest("hex");
}

async function assertUpdateHash(path, parsedHash) {
  const actual = await hashFile(path, parsedHash.algorithm);
  assert(
    actual === parsedHash.digest,
    `${basename(path)} ${parsedHash.algorithm} hash does not match update_hash`,
  );
}

async function validateLocalRelease(packageJSON) {
  const expected = releaseContext(packageJSON);
  const chromeSourceDirectory = join(projectRoot, "chrome-extension");
  const sourceChromeManifest = await readJSON(
    join(chromeSourceDirectory, "manifest.json"),
    "Chrome extension source manifest",
  );
  assertChromeManifest(sourceChromeManifest, expected);
  const sourcePopupHTML = await readFile(
    join(chromeSourceDirectory, "popup.html"),
    "utf8",
  );
  const sourceChromeEntries = await readdir(chromeSourceDirectory);
  assertChromeRuntimePackage(
    sourceChromeManifest,
    sourcePopupHTML,
    sourceChromeEntries,
    "Chrome extension source",
  );

  const xpiPath = join(buildDirectory, expected.xpiFilename);
  const chromePath = join(buildDirectory, expected.chromeFilename);
  const updatePath = join(buildDirectory, expected.updateFilename);
  await assertFile(xpiPath, "Zotero XPI");
  await assertFile(chromePath, "Chrome extension package");
  await assertFile(updatePath, "update manifest");
  const buildEntries = await readdir(buildDirectory);
  assert(
    !buildEntries.includes(expected.unusedUpdateFilename),
    `Release build must not retain unused ${expected.unusedUpdateFilename}`,
  );
  assertArchiveIntegrity(xpiPath);
  assertArchiveIntegrity(chromePath);
  const xpiArchiveEntries = listArchiveEntries(xpiPath);
  assertArchiveHygiene(xpiPath, xpiArchiveEntries);
  const chromeArchiveEntries = listArchiveEntries(chromePath);
  assertArchiveHygiene(chromePath, chromeArchiveEntries);

  const xpiManifest = readArchiveJSON(xpiPath, "manifest.json");
  const zoteroRuntimeBundle = readArchiveEntry(
    xpiPath,
    zoteroRuntimeBundleEntry,
  );
  const chromeManifest = readArchiveJSON(chromePath, "manifest.json");
  const chromePopupHTML = readArchiveEntry(chromePath, "popup.html");
  const zoteroCompatibility = assertZoteroManifest(xpiManifest, expected);
  assertZoteroMcpRuntimePackage(zoteroRuntimeBundle, xpiArchiveEntries);
  assertChromeManifest(chromeManifest, expected);
  assertChromeRuntimePackage(
    chromeManifest,
    chromePopupHTML,
    chromeArchiveEntries,
    "Chrome extension package",
  );

  const updateManifest = await readJSON(
    updatePath,
    "generated update manifest",
  );
  const { hash } = assertUpdateManifest(
    updateManifest,
    expected,
    zoteroCompatibility,
  );
  await assertUpdateHash(xpiPath, hash);

  console.log(
    `Release preflight passed for v${expected.version}: ` +
      `${expected.xpiFilename}, ${expected.chromeFilename}, and ` +
      `${expected.updateFilename}`,
  );
}

async function fetchPublic(url, description) {
  let response;
  try {
    response = await globalThis.fetch(url, {
      cache: "no-store",
      headers: { "user-agent": "zotero-gemini-notebook-release-validator" },
      redirect: "follow",
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Could not download ${description} from ${url}`, {
      cause: error,
    });
  }
  assert(
    response.ok,
    `${description} returned HTTP ${response.status} from ${url}`,
  );
  return response;
}

async function validatePublishedRelease(
  packageJSON,
  manifestURLOverride,
  expectedVersionOverride,
) {
  const expected = releaseContext(packageJSON);
  const expectedVersion = expectedVersionOverride ?? expected.version;
  const historicalMode = expectedVersion !== expected.version;
  const downloadManifestURL = manifestURLOverride ?? expected.manifestURL;
  const manifestResponse = await fetchPublic(
    downloadManifestURL,
    "published update manifest",
  );
  let updateManifest;
  try {
    updateManifest = JSON.parse(await manifestResponse.text());
  } catch (error) {
    throw new Error("Published update manifest is not valid JSON", {
      cause: error,
    });
  }

  if (!manifestURLOverride && !expected.prerelease) {
    const legacyResponse = await fetchPublic(
      expected.legacyManifestURL,
      "legacy update-manifest redirect",
    );
    let legacyManifest;
    try {
      legacyManifest = JSON.parse(await legacyResponse.text());
    } catch (error) {
      throw new Error("Legacy update-manifest redirect did not return JSON", {
        cause: error,
      });
    }
    assert(
      JSON.stringify(legacyManifest) === JSON.stringify(updateManifest),
      "Legacy repository URL does not resolve to the current update manifest",
    );
  }

  const update = updateManifest.addons?.[expected.addonID]?.updates?.find(
    (candidate) => candidate.version === expectedVersion,
  );
  assert(update, `Published update manifest has no ${expectedVersion} entry`);
  if (historicalMode) {
    assertHistoricalXPIURL(update.update_link, expectedVersion);
  } else {
    assert(
      update.update_link === expected.xpiURL,
      `Published update link is ${update.update_link}; expected ${expected.xpiURL}`,
    );
  }
  const parsedHash = parseUpdateHash(update.update_hash);

  const xpiResponse = await fetchPublic(update.update_link, "published XPI");
  const xpiBytes = Buffer.from(await xpiResponse.arrayBuffer());
  const actualHash = createHash(parsedHash.algorithm)
    .update(xpiBytes)
    .digest("hex");
  assert(
    actualHash === parsedHash.digest,
    `Published XPI ${parsedHash.algorithm} hash does not match update_hash`,
  );

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "zotero-gemini-release-"),
  );
  const temporaryXPI = join(
    temporaryDirectory,
    basename(new URL(update.update_link).pathname),
  );
  try {
    await writeFile(temporaryXPI, xpiBytes);
    assertArchiveIntegrity(temporaryXPI);
    assertArchiveHygiene(temporaryXPI);
    const xpiManifest = readArchiveJSON(temporaryXPI, "manifest.json");
    const publishedExpectation = {
      ...expected,
      version: expectedVersion,
      xpiURL: update.update_link,
    };
    const zoteroCompatibility = historicalMode
      ? assertHistoricalZoteroManifest(xpiManifest, publishedExpectation)
      : assertZoteroManifest(xpiManifest, publishedExpectation);
    assertUpdateManifest(
      updateManifest,
      publishedExpectation,
      zoteroCompatibility,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }

  console.log(
    `Published update verified anonymously for v${expectedVersion}: ` +
      `${downloadManifestURL}`,
  );
}

function printHelp() {
  console.log(`Usage: node scripts/validate-release.mjs [--published] [--manifest-url URL] [--expected-version VERSION]

Without options, validate locally built release packages and update manifests.
With --published, anonymously download and validate the current version's
public update manifest and XPI. Use --manifest-url with --published to validate
a candidate manifest before promoting it to the stable URL. Use
--expected-version with --published to verify a restored historical manifest.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    printHelp();
    return;
  }

  let published = false;
  let manifestURLOverride;
  let expectedVersionOverride;
  const unknownOptions = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--published") {
      published = true;
    } else if (argument === "--manifest-url") {
      manifestURLOverride = args[index + 1];
      assert(
        manifestURLOverride && !manifestURLOverride.startsWith("--"),
        "--manifest-url requires a URL",
      );
      index += 1;
    } else if (argument === "--expected-version") {
      expectedVersionOverride = args[index + 1];
      assert(
        expectedVersionOverride && !expectedVersionOverride.startsWith("--"),
        "--expected-version requires a version",
      );
      index += 1;
    } else {
      unknownOptions.push(argument);
    }
  }
  assert(
    unknownOptions.length === 0,
    `Unknown option(s): ${unknownOptions.join(", ")}`,
  );
  assert(
    published || !manifestURLOverride,
    "--manifest-url can only be used with --published",
  );
  assert(
    published || !expectedVersionOverride,
    "--expected-version can only be used with --published",
  );
  if (manifestURLOverride) {
    const parsedManifestURL = new URL(manifestURLOverride);
    assert(
      parsedManifestURL.protocol === "https:",
      "--manifest-url must use HTTPS",
    );
  }
  if (expectedVersionOverride) {
    assert(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersionOverride),
      `Unsupported expected version: ${expectedVersionOverride}`,
    );
  }

  const packageJSON = await readJSON(
    join(projectRoot, "package.json"),
    "package.json",
  );
  if (published) {
    await validatePublishedRelease(
      packageJSON,
      manifestURLOverride,
      expectedVersionOverride,
    );
  } else {
    await validateLocalRelease(packageJSON);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  assertChromeRuntimePackage,
  assertZoteroMcpRuntimePackage,
  assertUpdateManifest,
  parseUpdateHash,
  releaseContext,
};
