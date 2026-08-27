import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const runtimeSourcePath = new URL(
  "../src/modules/mcpLocalAuth.ts",
  import.meta.url,
);

async function loadRuntime() {
  const source = await readFile(runtimeSourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "mcpLocalAuth.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);

  const module = { exports: {} };
  const context = vm.createContext({
    ArrayBuffer,
    Error,
    IOUtils: {},
    Object,
    PathUtils: { join: path.posix.join },
    Promise,
    Services: {},
    Uint8Array,
  });
  const factory = vm.runInContext(
    `(function (exports, require, module) { ${compiled.outputText}\n })`,
    context,
  );
  factory(
    module.exports,
    () => {
      throw new Error("The local authorization module has no runtime imports");
    },
    module,
  );
  return module.exports;
}

function createMemoryIO() {
  const entries = new Map();
  const readBuffers = [];
  const calls = {
    remove: [],
    setPermissions: [],
    write: [],
  };
  let temporaryFileNumber = 0;

  return {
    entries,
    readBuffers,
    calls,
    api: {
      async createUniqueFile(parent, prefix, permissions) {
        const filePath = path.posix.join(
          parent,
          `${prefix}${++temporaryFileNumber}`,
        );
        entries.set(filePath, {
          type: "regular",
          permissions,
          bytes: new Uint8Array(),
        });
        return filePath;
      },
      async exists(filePath) {
        const entry = entries.get(filePath);
        return Boolean(
          entry && !(entry.symbolicLink && entry.targetExists === false),
        );
      },
      async isSymbolicLink(filePath) {
        return entries.get(filePath)?.symbolicLink === true;
      },
      async makeDirectory(directoryPath, options = {}) {
        if (!entries.has(directoryPath)) {
          entries.set(directoryPath, {
            type: "directory",
            permissions: options.permissions,
          });
        }
      },
      async move(sourcePath, destinationPath, options = {}) {
        if (!entries.has(sourcePath)) throw new Error("Missing source");
        if (options.noOverwrite && entries.has(destinationPath)) {
          throw new Error("Destination exists");
        }
        entries.set(destinationPath, entries.get(sourcePath));
        entries.delete(sourcePath);
      },
      async read(filePath, options = {}) {
        const entry = entries.get(filePath);
        if (!entry || entry.type !== "regular") throw new Error("Missing file");
        const bytes = entry.bytes ?? new Uint8Array();
        const result = bytes.slice(0, options.maxBytes ?? bytes.byteLength);
        readBuffers.push(result);
        return result;
      },
      async remove(filePath) {
        calls.remove.push(filePath);
        entries.delete(filePath);
      },
      async setPermissions(filePath, permissions) {
        calls.setPermissions.push(filePath);
        const entry = entries.get(filePath);
        if (!entry) throw new Error("Missing path");
        entry.permissions = permissions;
      },
      async stat(filePath) {
        const entry = entries.get(filePath);
        if (!entry) throw new Error("Missing path");
        return {
          permissions: entry.permissions,
          size: entry.bytes?.byteLength,
          type: entry.type,
        };
      },
      async write(filePath, value) {
        calls.write.push(filePath);
        const entry = entries.get(filePath);
        if (!entry || entry.type !== "regular") throw new Error("Missing file");
        entry.bytes = Uint8Array.from(value);
        return entry.bytes.byteLength;
      },
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness(overrides = {}) {
  const memory = createMemoryIO();
  const options = {
    crypto: webcrypto,
    homeDir: "/Users/researcher",
    io: memory.api,
    platform: "Darwin",
    ...overrides,
  };
  return {
    memory,
    options,
    keyPath: "/Users/researcher/.zotero-gemini-notebook/mcp/local-bridge.key",
  };
}

test("creates one raw mode-restricted key atomically and reports it ready", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();

  assert.deepEqual(
    plain(await runtime.getMcpLocalAuthorizationStatus(harness.options)),
    { status: "missing" },
  );
  await runtime.ensureMcpLocalAuthorization(harness.options);

  const stored = harness.memory.entries.get(harness.keyPath);
  assert.equal(stored.type, "regular");
  assert.equal(stored.permissions, 0o600);
  assert.equal(stored.bytes.byteLength, 32);
  for (const directory of [
    "/Users/researcher/.zotero-gemini-notebook",
    "/Users/researcher/.zotero-gemini-notebook/mcp",
  ]) {
    assert.equal(harness.memory.entries.get(directory).permissions, 0o700);
  }
  assert.equal(
    [...harness.memory.entries.keys()].some((entry) =>
      entry.includes(".local-bridge.key.tmp-"),
    ),
    false,
  );
  assert.deepEqual(
    plain(await runtime.getMcpLocalAuthorizationStatus(harness.options)),
    { status: "ready" },
  );
  const keyCopy = await runtime.readMcpLocalAuthorizationKey(harness.options);
  assert.deepEqual(keyCopy, stored.bytes);
  keyCopy.fill(0);

  assert.ok(harness.memory.readBuffers.length >= 2);
  for (const buffer of harness.memory.readBuffers) {
    assert.deepEqual(buffer, new Uint8Array(32));
  }

  const originalKey = Uint8Array.from(stored.bytes);
  await runtime.ensureMcpLocalAuthorization(harness.options);
  assert.deepEqual(stored.bytes, originalKey);
});

test("does not silently replace an invalid existing key", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  await runtime.ensureMcpLocalAuthorization(harness.options);
  const stored = harness.memory.entries.get(harness.keyPath);
  stored.bytes = new Uint8Array(31);

  assert.deepEqual(
    plain(await runtime.getMcpLocalAuthorizationStatus(harness.options)),
    { status: "invalid", errorCode: "LOCAL_AUTH_KEY_INVALID" },
  );
  await assert.rejects(
    runtime.ensureMcpLocalAuthorization(harness.options),
    (error) => error.code === "LOCAL_AUTH_KEY_INVALID",
  );
  assert.equal(stored.bytes.byteLength, 31);
});

test("rejects permissive storage on Unix and defers Windows ACL validation", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  await runtime.ensureMcpLocalAuthorization(harness.options);
  harness.memory.entries.get(harness.keyPath).permissions = 0o644;

  assert.equal(
    (await runtime.getMcpLocalAuthorizationStatus(harness.options)).status,
    "invalid",
  );
  assert.equal(
    (
      await runtime.getMcpLocalAuthorizationStatus({
        ...harness.options,
        platform: "WINNT",
      })
    ).status,
    "ready",
  );
});

test("reset removes only the exact authorization file", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  await runtime.ensureMcpLocalAuthorization(harness.options);
  const unrelatedPath =
    "/Users/researcher/.zotero-gemini-notebook/mcp/unrelated.txt";
  harness.memory.entries.set(unrelatedPath, {
    type: "regular",
    permissions: 0o600,
    bytes: new Uint8Array([1]),
  });

  await runtime.resetMcpLocalAuthorization(harness.options);

  assert.equal(harness.memory.entries.has(harness.keyPath), false);
  assert.equal(harness.memory.entries.has(unrelatedPath), true);
  assert.equal(
    (await runtime.getMcpLocalAuthorizationStatus(harness.options)).status,
    "missing",
  );
});

test("never writes, chmods, or removes through symbolic storage paths", async () => {
  const runtime = await loadRuntime();
  for (const target of ["privateRoot", "mcpDirectory", "keyPath"]) {
    const harness = createHarness();
    const privateRoot = "/Users/researcher/.zotero-gemini-notebook";
    const mcpDirectory = `${privateRoot}/mcp`;
    harness.memory.entries.set(privateRoot, {
      type: "directory",
      permissions: 0o700,
    });
    harness.memory.entries.set(mcpDirectory, {
      type: "directory",
      permissions: 0o700,
    });
    harness.memory.entries.set(harness.keyPath, {
      type: "regular",
      permissions: 0o600,
      bytes: new Uint8Array(32),
    });
    const pathByTarget = {
      privateRoot,
      mcpDirectory,
      keyPath: harness.keyPath,
    };
    harness.memory.entries.get(pathByTarget[target]).symbolicLink = true;

    assert.equal(
      (await runtime.getMcpLocalAuthorizationStatus(harness.options)).status,
      "invalid",
    );
    await assert.rejects(runtime.ensureMcpLocalAuthorization(harness.options));
    await assert.rejects(runtime.resetMcpLocalAuthorization(harness.options));
    assert.deepEqual(harness.memory.calls.setPermissions, []);
    assert.deepEqual(harness.memory.calls.write, []);
    assert.deepEqual(harness.memory.calls.remove, []);
  }
});

test("rejects dangling symbolic links before any storage mutation", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const privateRoot = "/Users/researcher/.zotero-gemini-notebook";
  const mcpDirectory = `${privateRoot}/mcp`;
  harness.memory.entries.set(privateRoot, {
    type: "directory",
    permissions: 0o700,
  });
  harness.memory.entries.set(mcpDirectory, {
    type: "directory",
    permissions: 0o700,
  });
  harness.memory.entries.set(harness.keyPath, {
    type: "regular",
    permissions: 0o600,
    bytes: new Uint8Array(),
    symbolicLink: true,
    targetExists: false,
  });

  assert.equal(await harness.options.io.exists(harness.keyPath), false);
  assert.equal(
    (await runtime.getMcpLocalAuthorizationStatus(harness.options)).status,
    "invalid",
  );
  await assert.rejects(runtime.ensureMcpLocalAuthorization(harness.options));
  await assert.rejects(runtime.resetMcpLocalAuthorization(harness.options));
  assert.deepEqual(harness.memory.calls.setPermissions, []);
  assert.deepEqual(harness.memory.calls.write, []);
  assert.deepEqual(harness.memory.calls.remove, []);
});

test("fails closed when secure randomness or storage is unavailable", async () => {
  const runtime = await loadRuntime();
  const noCrypto = createHarness({ crypto: {} });
  await assert.rejects(
    runtime.ensureMcpLocalAuthorization(noCrypto.options),
    (error) => error.code === "LOCAL_AUTH_CRYPTO_UNAVAILABLE",
  );

  const noHome = createHarness({ homeDir: "" });
  assert.deepEqual(
    plain(await runtime.getMcpLocalAuthorizationStatus(noHome.options)),
    { status: "invalid", errorCode: "LOCAL_AUTH_STORAGE_UNAVAILABLE" },
  );
});
