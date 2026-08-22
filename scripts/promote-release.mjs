#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = "peterdresslar/zotero-gemini-notebook";
const addonID = "zotero-notebooklm@peterdresslar.com";
const manifestReleaseTag = "release";
const stableAssetName = "update.json";
const backupAssetName = "update.backup.json";
const betaAssetName = "update-beta.json";
const legacyBackupPattern = /^update-v\d+\.\d+\.\d+\.backup\.json$/u;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseStableVersion(version, description = "version") {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  assert(match, `${description} must use stable x.y.z form: ${version}`);
  return match.slice(1).map(Number);
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left, "left version");
  const rightParts = parseStableVersion(right, "right version");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function manifestVersion(manifest, description = "update manifest") {
  const updates = manifest.addons?.[addonID]?.updates;
  assert(
    Array.isArray(updates) && updates.length === 1,
    `${description} must contain exactly one update for ${addonID}`,
  );
  const version = updates[0]?.version;
  parseStableVersion(version, `${description} version`);
  return version;
}

function uniqueAsset(assets, name, { required = true } = {}) {
  const matches = assets.filter((asset) => asset.name === name);
  assert(matches.length <= 1, `Release contains duplicate ${name} assets`);
  if (required) {
    assert(matches.length === 1, `Release is missing ${name}`);
  }
  return matches[0];
}

function classifyPromotionState(
  assets,
  { candidateAssetName, previousDigest, targetDigest },
) {
  const stable = uniqueAsset(assets, stableAssetName, { required: false });
  const candidate = uniqueAsset(assets, candidateAssetName, {
    required: false,
  });
  const backup = uniqueAsset(assets, backupAssetName, { required: false });
  const beta = uniqueAsset(assets, betaAssetName, { required: false });
  const obsoleteBackups = assets.filter((asset) =>
    legacyBackupPattern.test(asset.name),
  );
  if (candidate) {
    assert(
      candidate.digest === targetDigest,
      `${candidateAssetName} does not match the target manifest`,
    );
  }

  let state;
  if (stable?.digest === previousDigest && !candidate) {
    state = "initial";
  } else if (stable?.digest === previousDigest && candidate) {
    state = "staged";
  } else if (
    !stable &&
    backup?.digest === previousDigest &&
    candidate?.digest === targetDigest
  ) {
    state = "renaming";
  } else if (
    stable?.digest === targetDigest &&
    backup?.digest === previousDigest &&
    !candidate
  ) {
    state = "promoted";
  } else {
    const topology = [stable, backup, candidate]
      .filter(Boolean)
      .map((asset) => `${asset.name}=${asset.digest ?? "no digest"}`)
      .join(", ");
    throw new Error(
      `Updater assets are not in a safe promotion state: ${topology || "none"}`,
    );
  }

  return {
    backup,
    beta,
    candidate,
    obsoleteBackups,
    stable,
    state,
  };
}

function sha256Digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }
}

function releaseAssets() {
  return JSON.parse(
    run("gh", [
      "release",
      "view",
      manifestReleaseTag,
      "--repo",
      repository,
      "--json",
      "assets",
      "--jq",
      "[.assets[] | {name: .name, apiUrl: .apiUrl, digest: .digest}]",
    ]),
  );
}

function assetAPIEndpoint(asset) {
  const url = new URL(asset.apiUrl);
  assert(
    url.origin === "https://api.github.com",
    `Unexpected GitHub asset API URL: ${asset.apiUrl}`,
  );
  return url.pathname.replace(/^\//u, "");
}

function renameAsset(asset, name) {
  run("gh", [
    "api",
    "--method",
    "PATCH",
    assetAPIEndpoint(asset),
    "-f",
    `name=${name}`,
  ]);
}

function deleteAsset(asset) {
  run("gh", ["api", "--method", "DELETE", assetAPIEndpoint(asset)]);
}

function verifyPublished(manifestURL, expectedVersion) {
  const args = [
    join(projectRoot, "scripts", "validate-release.mjs"),
    "--published",
  ];
  if (manifestURL) {
    args.push("--manifest-url", manifestURL);
  }
  if (expectedVersion) {
    args.push("--expected-version", expectedVersion);
  }
  const output = run(process.execPath, args);
  if (output) {
    console.log(output);
  }
}

async function verifyWithRetries(
  manifestURL,
  expectedVersion,
  description,
  attempts = 6,
  delayMilliseconds = 5000,
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      verifyPublished(manifestURL, expectedVersion);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          `${description} has not refreshed yet ` +
            `(attempt ${attempt}/${attempts}); retrying...`,
        );
        await new Promise((resolveDelay) =>
          globalThis.setTimeout(resolveDelay, delayMilliseconds),
        );
      }
    }
  }
  throw lastError;
}

async function fetchText(url, description) {
  let response;
  try {
    response = await globalThis.fetch(url, {
      cache: "no-store",
      headers: { "user-agent": "zotero-gemini-notebook-release-promoter" },
      redirect: "follow",
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Could not download ${description} from ${url}`, {
      cause: error,
    });
  }
  assert(response.ok, `${description} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchManifest(url, description) {
  const text = await fetchText(url, description);
  try {
    return { manifest: JSON.parse(text), text };
  } catch (error) {
    throw new Error(`${description} is not valid JSON`, { cause: error });
  }
}

function releaseURL(version, filename) {
  const tag = version ? `v${version}` : manifestReleaseTag;
  return `https://github.com/${repository}/releases/download/${tag}/${filename}`;
}

async function executePromotion({
  candidateAssetName,
  dryRun,
  operations,
  previousDigest,
  targetDigest,
}) {
  const classify = async () =>
    classifyPromotionState(await operations.getAssets(), {
      candidateAssetName,
      previousDigest,
      targetDigest,
    });

  let topology = await classify();
  let candidateVerified = false;
  let promotionVerified = false;

  if (["initial", "staged"].includes(topology.state)) {
    await operations.verifyPreviousStable();
  }
  if (["staged", "renaming"].includes(topology.state)) {
    await operations.verifyCandidate();
    candidateVerified = true;
  }
  if (topology.state === "promoted") {
    await operations.verifyStable();
    await operations.verifyBackup();
    promotionVerified = true;
  }

  if (dryRun) {
    return topology.state;
  }

  if (topology.state === "initial") {
    await operations.uploadCandidate();
    topology = await classify();
    assert(
      topology.state === "staged",
      `Candidate upload left unexpected ${topology.state} state`,
    );
  }

  if (topology.state === "staged") {
    if (!candidateVerified) {
      await operations.verifyCandidate();
    }
    if (topology.backup) {
      await operations.deleteAsset(topology.backup);
    }
    await operations.renameAsset(topology.stable, backupAssetName);
    topology = await classify();
    assert(
      topology.state === "renaming",
      `Stable backup rename left unexpected ${topology.state} state`,
    );
  }

  if (topology.state === "renaming") {
    // The API digest proves the backup contents. Complete the second rename
    // promptly so the permanent stable URL is not left without an asset.
    try {
      await operations.renameAsset(topology.candidate, stableAssetName);
    } catch (promotionError) {
      topology = await classify();
      if (topology.state !== "promoted") {
        assert(
          topology.state === "renaming",
          `Candidate rename failed in unexpected ${topology.state} state`,
        );
        let restorationError;
        try {
          await operations.renameAsset(topology.backup, stableAssetName);
        } catch (error) {
          restorationError = error;
        }
        topology = await classify();
        if (topology.state === "staged") {
          throw new Error(
            `Could not promote ${candidateAssetName}; restored ${stableAssetName}. ` +
              "Rerun the promotion command to continue safely.",
            { cause: promotionError },
          );
        }
        throw new Error(
          `CRITICAL: ${stableAssetName} could not be restored. Inspect the ` +
            `release assets and rename ${backupAssetName} to ${stableAssetName} ` +
            `immediately. ${restorationError?.message ?? promotionError.message}`,
          { cause: promotionError },
        );
      }
    }
    topology = await classify();
    assert(
      topology.state === "promoted",
      `Candidate promotion left unexpected ${topology.state} state`,
    );
  }

  assert(
    topology.state === "promoted",
    `Cannot verify promotion from ${topology.state} state`,
  );
  if (!promotionVerified) {
    await operations.verifyStable();
    await operations.verifyBackup();
  }

  topology = await classify();
  for (const obsoleteBackup of topology.obsoleteBackups) {
    await operations.deleteAsset(obsoleteBackup);
  }
  if (topology.beta) {
    await operations.deleteAsset(topology.beta);
  }

  topology = await classify();
  assert(
    !topology.beta && topology.obsoleteBackups.length === 0,
    "Retired updater assets remain after cleanup",
  );
  return topology.state;
}

async function promote(fromVersion, { dryRun = false } = {}) {
  const packageJSON = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const toVersion = packageJSON.version;
  parseStableVersion(fromVersion, "--from-version");
  parseStableVersion(toVersion, "package version");
  assert(
    compareStableVersions(fromVersion, toVersion) < 0,
    `Package version ${toVersion} must be newer than ${fromVersion}`,
  );

  const sourceURL = releaseURL(toVersion, stableAssetName);
  const previousURL = releaseURL(fromVersion, stableAssetName);
  const backupURL = releaseURL(undefined, backupAssetName);
  const candidateAssetName = `update-v${toVersion}.candidate.json`;
  const candidateURL = releaseURL(undefined, candidateAssetName);

  console.log(`Verifying public v${toVersion} release assets...`);
  verifyPublished(sourceURL);
  const source = await fetchManifest(sourceURL, "versioned update manifest");
  assert(
    manifestVersion(source.manifest, "versioned update manifest") === toVersion,
    `Versioned manifest does not describe v${toVersion}`,
  );
  console.log(`Verifying rollback source for v${fromVersion}...`);
  verifyPublished(previousURL, fromVersion);
  const previous = await fetchManifest(
    previousURL,
    "previous versioned update manifest",
  );
  assert(
    manifestVersion(previous.manifest, "previous versioned update manifest") ===
      fromVersion,
    `Previous versioned manifest does not describe v${fromVersion}`,
  );

  const operations = {
    deleteAsset: async (asset) => {
      console.log(`Removing retired ${asset.name}...`);
      deleteAsset(asset);
    },
    getAssets: async () => releaseAssets(),
    renameAsset: async (asset, name) => {
      console.log(`Renaming ${asset.name} to ${name}...`);
      renameAsset(asset, name);
    },
    uploadCandidate: async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "zotero-gemini-promote-"),
      );
      try {
        const candidatePath = join(temporaryDirectory, candidateAssetName);
        await writeFile(candidatePath, source.text);
        run("gh", [
          "release",
          "upload",
          manifestReleaseTag,
          candidatePath,
          "--repo",
          repository,
        ]);
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
    verifyBackup: async () =>
      verifyWithRetries(backupURL, fromVersion, "Rolling backup URL"),
    verifyCandidate: async () => verifyPublished(candidateURL),
    verifyPreviousStable: async () => verifyPublished(undefined, fromVersion),
    verifyStable: async () =>
      verifyWithRetries(undefined, undefined, "Stable updater URL"),
  };

  let finalState;
  try {
    finalState = await executePromotion({
      candidateAssetName,
      dryRun,
      operations,
      previousDigest: sha256Digest(previous.text),
      targetDigest: sha256Digest(source.text),
    });
  } catch (error) {
    throw new Error(
      `${error.message} Do not announce the release. Inspect the live assets ` +
        "and rerun the same command once the reported condition is safe.",
      { cause: error },
    );
  }

  if (dryRun) {
    console.log(
      `Dry run passed in ${finalState} state: v${fromVersion} can be promoted ` +
        `to v${toVersion}. No GitHub assets were changed.`,
    );
  } else {
    console.log(
      `Stable updater promoted from v${fromVersion} to v${toVersion}. ` +
        `${backupAssetName} is the single rolling rollback copy.`,
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/promote-release.mjs --from-version VERSION [--dry-run]

Promote the package version's already-published versioned update.json to the
permanent stable updater release. The command validates the public candidate,
preserves the current manifest as update.backup.json, verifies the new stable
URL, and removes the retired beta and older backup assets only after
verification passes.`);
}

function parseArgs(args) {
  if (args.includes("--help")) {
    return { help: true };
  }
  let fromVersion;
  let dryRun = false;
  const unknown = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--from-version") {
      fromVersion = args[index + 1];
      assert(
        fromVersion && !fromVersion.startsWith("--"),
        "--from-version requires a version",
      );
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else {
      unknown.push(argument);
    }
  }
  assert(unknown.length === 0, `Unknown option(s): ${unknown.join(", ")}`);
  assert(fromVersion, "--from-version is required");
  return { dryRun, fromVersion, help: false };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await promote(options.fromVersion, { dryRun: options.dryRun });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Release promotion failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  classifyPromotionState,
  compareStableVersions,
  executePromotion,
  manifestVersion,
  parseArgs,
  parseStableVersion,
  sha256Digest,
};
