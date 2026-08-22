import nodeAssert from "node:assert/strict";
import test from "node:test";

import {
  classifyPromotionState,
  compareStableVersions,
  executePromotion,
  manifestVersion,
  parseArgs,
  parseStableVersion,
  sha256Digest,
} from "./promote-release.mjs";

const candidateAssetName = "update-v0.3.2.candidate.json";
const previousDigest = "sha256:previous";
const targetDigest = "sha256:target";

function asset(name, digest, id = name) {
  return { apiUrl: `https://api.github.com/assets/${id}`, digest, name };
}

function classify(assets) {
  return classifyPromotionState(assets, {
    candidateAssetName,
    previousDigest,
    targetDigest,
  });
}

function fakeOperations(initialAssets, options = {}) {
  let assets = globalThis.structuredClone(initialAssets);
  const events = [];
  let deleteFailurePending = Boolean(options.failDeleteNameOnce);
  let failStableVerification = options.failStableVerification ?? false;

  const findAsset = (target) =>
    assets.find((candidate) => candidate.apiUrl === target.apiUrl);

  return {
    events,
    get assets() {
      return globalThis.structuredClone(assets);
    },
    operations: {
      deleteAsset: async (target) => {
        events.push(`delete:${target.name}`);
        if (
          deleteFailurePending &&
          target.name === options.failDeleteNameOnce
        ) {
          deleteFailurePending = false;
          throw new Error(`delete failed for ${target.name}`);
        }
        assets = assets.filter(
          (candidate) => candidate.apiUrl !== target.apiUrl,
        );
      },
      getAssets: async () => globalThis.structuredClone(assets),
      renameAsset: async (target, name) => {
        events.push(`rename:${target.name}->${name}`);
        const current = findAsset(target);
        nodeAssert(current, `missing fake asset ${target.name}`);
        if (
          options.candidateRenameFailure === "before" &&
          target.name === candidateAssetName &&
          name === "update.json"
        ) {
          throw new Error("candidate rename failed before mutation");
        }
        current.name = name;
        if (
          options.candidateRenameFailure === "after" &&
          target.name === candidateAssetName &&
          name === "update.json"
        ) {
          throw new Error("candidate rename timed out after mutation");
        }
      },
      uploadCandidate: async () => {
        events.push("uploadCandidate");
        assets.push(asset(candidateAssetName, targetDigest, "candidate"));
      },
      verifyBackup: async () => {
        events.push("verifyBackup");
      },
      verifyCandidate: async () => {
        events.push("verifyCandidate");
      },
      verifyPreviousStable: async () => {
        events.push("verifyPreviousStable");
      },
      verifyStable: async () => {
        events.push("verifyStable");
        if (failStableVerification) {
          failStableVerification = false;
          throw new Error("stable cache did not refresh");
        }
      },
    },
  };
}

function executeWith(operations, dryRun = false) {
  return executePromotion({
    candidateAssetName,
    dryRun,
    operations,
    previousDigest,
    targetDigest,
  });
}

test("stable versions compare numerically", () => {
  nodeAssert.equal(compareStableVersions("0.3.1", "0.3.2"), -1);
  nodeAssert.equal(compareStableVersions("0.10.0", "0.9.9"), 1);
  nodeAssert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
});

test("promotion rejects prerelease and partial versions", () => {
  for (const version of ["0.3", "v0.3.2", "0.3.2-beta.1"]) {
    nodeAssert.throws(() => parseStableVersion(version), /stable x\.y\.z/);
  }
});

test("manifest version requires one stable update for the add-on", () => {
  const valid = {
    addons: {
      "zotero-notebooklm@peterdresslar.com": {
        updates: [{ version: "0.3.2" }],
      },
    },
  };
  nodeAssert.equal(manifestVersion(valid), "0.3.2");
  nodeAssert.throws(
    () =>
      manifestVersion({
        addons: {
          "zotero-notebooklm@peterdresslar.com": { updates: [] },
        },
      }),
    /exactly one update/,
  );
});

test("manifest digests use GitHub's sha256 form", () => {
  nodeAssert.equal(
    sha256Digest("hello"),
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("asset topology recognizes every resumable promotion state", () => {
  const stable = asset("update.json", previousDigest, "stable");
  const candidate = asset(candidateAssetName, targetDigest, "candidate");
  const backup = asset("update.backup.json", previousDigest, "backup");

  nodeAssert.equal(classify([stable]).state, "initial");
  nodeAssert.equal(classify([stable, candidate]).state, "staged");
  nodeAssert.equal(classify([backup, candidate]).state, "renaming");
  nodeAssert.equal(
    classify([asset("update.json", targetDigest, "candidate"), backup]).state,
    "promoted",
  );
});

test("asset topology rejects mismatched and ambiguous assets", () => {
  nodeAssert.throws(() => classify([]), /not in a safe promotion state/);
  nodeAssert.throws(
    () =>
      classify([
        asset("update.json", previousDigest, "one"),
        asset("update.json", previousDigest, "two"),
      ]),
    /duplicate update\.json/,
  );
  nodeAssert.throws(
    () =>
      classify([
        asset("update.json", previousDigest),
        asset(candidateAssetName, "sha256:wrong"),
      ]),
    /does not match the target manifest/,
  );
});

test("dry run validates but never mutates assets", async () => {
  const fake = fakeOperations([
    asset("update.json", previousDigest),
    asset("update-beta.json", "sha256:retired"),
  ]);
  const before = fake.assets;
  nodeAssert.equal(await executeWith(fake.operations, true), "initial");
  nodeAssert.deepEqual(fake.assets, before);
  nodeAssert.deepEqual(fake.events, ["verifyPreviousStable"]);
});

test("promotion orders validation, renames, and retired-asset cleanup safely", async () => {
  const fake = fakeOperations([
    asset("update.json", previousDigest, "stable"),
    asset("update.backup.json", "sha256:older", "old-backup"),
    asset("update-beta.json", "sha256:retired", "beta"),
    asset("update-v0.2.0.backup.json", "sha256:older", "legacy"),
  ]);

  nodeAssert.equal(await executeWith(fake.operations), "promoted");
  nodeAssert.deepEqual(
    fake.assets.map(({ digest, name }) => ({ digest, name })),
    [
      { digest: previousDigest, name: "update.backup.json" },
      { digest: targetDigest, name: "update.json" },
    ],
  );
  nodeAssert(
    fake.events.indexOf("verifyCandidate") <
      fake.events.indexOf("delete:update.backup.json"),
  );
  nodeAssert(
    fake.events.indexOf("verifyStable") <
      fake.events.indexOf("delete:update-beta.json"),
  );
  nodeAssert(
    fake.events.indexOf("verifyBackup") <
      fake.events.indexOf("delete:update-v0.2.0.backup.json"),
  );
});

test("candidate rename failure restores the stable name", async () => {
  const fake = fakeOperations([asset("update.json", previousDigest)], {
    candidateRenameFailure: "before",
  });

  await nodeAssert.rejects(
    executeWith(fake.operations),
    /restored update\.json/,
  );
  nodeAssert.equal(classify(fake.assets).state, "staged");
  nodeAssert(fake.events.includes("rename:update.backup.json->update.json"));
});

test("candidate rename timeout recognizes a completed promotion", async () => {
  const fake = fakeOperations([asset("update.json", previousDigest)], {
    candidateRenameFailure: "after",
  });

  nodeAssert.equal(await executeWith(fake.operations), "promoted");
  nodeAssert.equal(classify(fake.assets).state, "promoted");
  nodeAssert.equal(
    fake.events.includes("rename:update.backup.json->update.json"),
    false,
  );
});

test("a verification failure retains rollback state and can resume cleanup", async () => {
  const fake = fakeOperations(
    [
      asset("update.json", previousDigest),
      asset("update-beta.json", "sha256:retired"),
      asset("update-v0.2.0.backup.json", "sha256:older"),
    ],
    { failStableVerification: true },
  );

  await nodeAssert.rejects(
    executeWith(fake.operations),
    /cache did not refresh/,
  );
  nodeAssert.equal(classify(fake.assets).state, "promoted");
  nodeAssert(fake.assets.some(({ name }) => name === "update-beta.json"));

  nodeAssert.equal(await executeWith(fake.operations), "promoted");
  nodeAssert.deepEqual(fake.assets.map(({ name }) => name).sort(), [
    "update.backup.json",
    "update.json",
  ]);
});

test("a cleanup failure resumes without repeating promotion", async () => {
  const fake = fakeOperations(
    [
      asset("update.json", previousDigest),
      asset("update-beta.json", "sha256:retired"),
    ],
    { failDeleteNameOnce: "update-beta.json" },
  );

  await nodeAssert.rejects(
    executeWith(fake.operations),
    /delete failed for update-beta\.json/,
  );
  nodeAssert.equal(classify(fake.assets).state, "promoted");

  nodeAssert.equal(await executeWith(fake.operations), "promoted");
  nodeAssert.deepEqual(fake.assets.map(({ name }) => name).sort(), [
    "update.backup.json",
    "update.json",
  ]);
});

test("promotion arguments require an explicit previous version", () => {
  nodeAssert.deepEqual(parseArgs(["--from-version", "0.3.1", "--dry-run"]), {
    dryRun: true,
    fromVersion: "0.3.1",
    help: false,
  });
  nodeAssert.deepEqual(parseArgs(["--from-version", "0.3.1"]), {
    dryRun: false,
    fromVersion: "0.3.1",
    help: false,
  });
  nodeAssert.throws(() => parseArgs([]), /--from-version is required/);
  nodeAssert.throws(() => parseArgs(["--wat"]), /Unknown option/);
});
