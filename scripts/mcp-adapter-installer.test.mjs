import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TextDecoder, TextEncoder } from "node:util";
import { URL } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const runtimeSourcePath = new URL(
  "../src/modules/mcpAdapterInstaller.ts",
  import.meta.url,
);

const runtimeFiles = [
  "server.py",
  "zotero_control.py",
  "zotero_jobs.py",
  "zotero_status.py",
  "pyproject.toml",
  "uv.lock",
];

async function loadRuntime() {
  const source = await readFile(runtimeSourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "mcpAdapterInstaller.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);

  const module = { exports: {} };
  const context = vm.createContext({
    Error,
    IOUtils: {},
    Object,
    PathUtils: {
      filename: path.posix.basename,
      isAbsolute: path.posix.isAbsolute,
      join: path.posix.join,
      parent: path.posix.dirname,
    },
    Promise,
    Services: {},
    TextEncoder,
    Uint8Array,
  });
  const factory = vm.runInContext(
    `(function (exports, require, module) { ${compiled.outputText}\n })`,
    context,
  );
  factory(
    module.exports,
    (specifier) => {
      if (specifier === "../../package.json") {
        return {
          config: { addonRef: "zoteroNotebookLM" },
          version: "0.3.4",
        };
      }
      throw new Error(`Unexpected runtime import: ${specifier}`);
    },
    module,
  );
  return module.exports;
}

function createMemoryIO() {
  const entries = new Map();
  const calls = {
    createUniqueDirectory: [],
    move: [],
    remove: [],
    setPermissions: [],
    write: [],
  };
  let temporaryDirectoryNumber = 0;
  let writeFailureAt = null;

  function descendants(directoryPath) {
    const prefix = `${directoryPath}/`;
    return [...entries.keys()].filter((entryPath) =>
      entryPath.startsWith(prefix),
    );
  }

  const api = {
    async createUniqueDirectory(parent, prefix, permissions) {
      const directoryPath = path.posix.join(
        parent,
        `${prefix}${++temporaryDirectoryNumber}`,
      );
      calls.createUniqueDirectory.push(directoryPath);
      entries.set(directoryPath, { type: "directory", permissions });
      return directoryPath;
    },
    async exists(entryPath) {
      const entry = entries.get(entryPath);
      return Boolean(
        entry && !(entry.symbolicLink && entry.targetExists === false),
      );
    },
    async getChildren(directoryPath) {
      return [...entries.keys()].filter(
        (entryPath) =>
          entryPath !== directoryPath &&
          path.posix.dirname(entryPath) === directoryPath,
      );
    },
    async isSymbolicLink(entryPath) {
      return entries.get(entryPath)?.symbolicLink === true;
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
      calls.move.push({ sourcePath, destinationPath, options });
      if (!entries.has(sourcePath)) throw new Error("Missing source");
      if (options.noOverwrite && entries.has(destinationPath)) {
        throw new Error("Destination exists");
      }
      const sourceEntries = [sourcePath, ...descendants(sourcePath)];
      for (const entryPath of sourceEntries) {
        const suffix = entryPath.slice(sourcePath.length);
        entries.set(`${destinationPath}${suffix}`, entries.get(entryPath));
      }
      for (const entryPath of sourceEntries) entries.delete(entryPath);
    },
    async read(filePath, options = {}) {
      const entry = entries.get(filePath);
      if (!entry || entry.type !== "regular") throw new Error("Missing file");
      const bytes = entry.bytes ?? new Uint8Array();
      return bytes.slice(0, options.maxBytes ?? bytes.byteLength);
    },
    async remove(entryPath, options = {}) {
      calls.remove.push({ entryPath, options });
      if (options.recursive) {
        for (const childPath of descendants(entryPath)) {
          entries.delete(childPath);
        }
      }
      entries.delete(entryPath);
    },
    async setPermissions(entryPath, permissions) {
      calls.setPermissions.push({ entryPath, permissions });
      const entry = entries.get(entryPath);
      if (!entry) throw new Error("Missing path");
      entry.permissions = permissions;
    },
    async stat(entryPath) {
      const entry = entries.get(entryPath);
      if (!entry) throw new Error("Missing path");
      return {
        permissions: entry.permissions,
        size: entry.bytes?.byteLength,
        type: entry.type,
      };
    },
    async write(filePath, value, options = {}) {
      calls.write.push({ filePath, options });
      if (writeFailureAt === calls.write.length) {
        throw new Error("Injected write failure");
      }
      if (options.mode === "create" && entries.has(filePath)) {
        throw new Error("Destination exists");
      }
      const bytes = Uint8Array.from(value);
      entries.set(filePath, {
        type: "regular",
        bytes,
      });
      return bytes.byteLength;
    },
  };

  return {
    api,
    calls,
    entries,
    failWriteAt(number) {
      writeFailureAt = number;
    },
  };
}

function createResources(suffix = "") {
  const encoder = new TextEncoder();
  return new Map(
    runtimeFiles.map((filename) => [
      filename,
      encoder.encode(`runtime:${filename}${suffix}\n`),
    ]),
  );
}

function createHarness(overrides = {}) {
  const memory = createMemoryIO();
  const resources = createResources();
  const resourceCalls = [];
  const options = {
    crypto: webcrypto,
    homeDir: "/Users/researcher",
    io: memory.api,
    platform: "Darwin",
    pluginVersion: "0.4.0",
    async resourceReader(filename, resourceURL) {
      resourceCalls.push({ filename, resourceURL });
      const bytes = resources.get(filename);
      if (!bytes) throw new Error("Missing fixture resource");
      return Uint8Array.from(bytes);
    },
    ...overrides,
  };
  return { memory, options, resourceCalls, resources };
}

function adapterDirectories(memory) {
  const root = "/Users/researcher/.zotero-gemini-notebook/mcp/adapters/";
  return [...memory.entries.entries()]
    .filter(
      ([entryPath, entry]) =>
        entry.type === "directory" &&
        entryPath.startsWith(root) &&
        !entryPath.includes(".tmp-"),
    )
    .map(([entryPath]) => entryPath);
}

function publishDirectoryCopy(memory, sourcePath, destinationPath) {
  for (const [entryPath, entry] of [...memory.entries.entries()]) {
    if (entryPath !== sourcePath && !entryPath.startsWith(`${sourcePath}/`)) {
      continue;
    }
    memory.entries.set(
      `${destinationPath}${entryPath.slice(sourcePath.length)}`,
      {
        ...entry,
        bytes:
          entry.bytes instanceof Uint8Array
            ? Uint8Array.from(entry.bytes)
            : entry.bytes,
      },
    );
  }
}

test("publishes the exact allowlisted bundle atomically with private POSIX modes", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const result = await runtime.installBundledMcpAdapter(harness.options);

  assert.match(
    result.projectPath,
    /^\/Users\/researcher\/\.zotero-gemini-notebook\/mcp\/adapters\/0\.4\.0-[0-9a-f]{64}$/,
  );
  assert.equal(result.serverPath, `${result.projectPath}/server.py`);
  assert.equal(path.posix.isAbsolute(result.projectPath), true);
  assert.equal(Object.isFrozen(result), true);

  assert.deepEqual(
    harness.resourceCalls,
    runtimeFiles.map((filename) => ({
      filename,
      resourceURL: `chrome://zoteroNotebookLM/content/mcp-adapter/${filename}`,
    })),
  );
  assert.equal(harness.memory.calls.move.length, 1);
  assert.equal(
    harness.memory.calls.move[0].destinationPath,
    result.projectPath,
  );
  assert.equal(harness.memory.calls.move[0].options.noOverwrite, true);
  assert.equal(
    [...harness.memory.entries.keys()].some((entryPath) =>
      entryPath.includes(".tmp-"),
    ),
    false,
  );

  for (const directoryPath of [
    "/Users/researcher/.zotero-gemini-notebook",
    "/Users/researcher/.zotero-gemini-notebook/mcp",
    "/Users/researcher/.zotero-gemini-notebook/mcp/adapters",
    result.projectPath,
  ]) {
    assert.equal(harness.memory.entries.get(directoryPath).permissions, 0o700);
  }
  for (const filename of runtimeFiles) {
    const installed = harness.memory.entries.get(
      `${result.projectPath}/${filename}`,
    );
    assert.equal(installed.type, "regular");
    assert.equal(installed.permissions, 0o600);
    assert.deepEqual(installed.bytes, harness.resources.get(filename));
  }

  const manifestPath = `${result.projectPath}/.zgn-adapter-manifest.json`;
  const manifestEntry = harness.memory.entries.get(manifestPath);
  assert.equal(manifestEntry.permissions, 0o600);
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.pluginVersion, "0.4.0");
  assert.equal(result.projectPath.endsWith(manifest.contentHash), true);
  assert.deepEqual(
    manifest.files.map(({ name }) => name),
    runtimeFiles,
  );
  assert.deepEqual(
    manifest.files,
    runtimeFiles.map((name) => {
      const bytes = harness.resources.get(name);
      return {
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }),
  );
  assert.equal(
    manifest.contentHash,
    createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          files: manifest.files,
        }),
      )
      .digest("hex"),
  );
  assert.equal(
    harness.memory.calls.write
      .at(-1)
      .filePath.endsWith("/.zgn-adapter-manifest.json"),
    true,
  );
});

test("an exact existing installation is a no-op", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const first = await runtime.installBundledMcpAdapter(harness.options);
  const writesBefore = harness.memory.calls.write.length;
  const movesBefore = harness.memory.calls.move.length;
  const removesBefore = harness.memory.calls.remove.length;

  const second = await runtime.installBundledMcpAdapter(harness.options);

  assert.deepEqual(second, first);
  assert.equal(harness.memory.calls.write.length, writesBefore);
  assert.equal(harness.memory.calls.move.length, movesBefore);
  assert.equal(harness.memory.calls.remove.length, removesBefore);
});

test("accepts an exact concurrent winner and removes only its owned stage", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  let stagedPath = null;
  let winnerPath = null;
  const io = {
    ...harness.memory.api,
    async move(sourcePath, destinationPath, options = {}) {
      harness.memory.calls.move.push({ sourcePath, destinationPath, options });
      stagedPath = sourcePath;
      winnerPath = destinationPath;
      publishDirectoryCopy(harness.memory, sourcePath, destinationPath);
      throw new Error("Concurrent installer published first");
    },
  };

  const result = await runtime.installBundledMcpAdapter({
    ...harness.options,
    io,
  });

  assert.equal(result.projectPath, winnerPath);
  assert.equal(harness.memory.entries.has(result.serverPath), true);
  assert.equal(harness.memory.calls.move[0].options.noOverwrite, true);
  assert.equal(harness.memory.calls.remove.length, 1);
  assert.equal(harness.memory.calls.remove[0].entryPath, stagedPath);
  assert.equal(harness.memory.calls.remove[0].options.ignoreAbsent, true);
  assert.equal(harness.memory.calls.remove[0].options.recursive, true);
  assert.equal(harness.memory.entries.has(stagedPath), false);
  assert.equal(harness.memory.entries.has(winnerPath), true);
  assert.equal(
    harness.memory.calls.remove.some(
      ({ entryPath }) => entryPath === winnerPath,
    ),
    false,
  );
});

test("rejects a mismatched concurrent winner without deleting its target", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const mismatchedBytes = new TextEncoder().encode("concurrent:mismatch\n");
  let stagedPath = null;
  let winnerPath = null;
  const io = {
    ...harness.memory.api,
    async move(sourcePath, destinationPath, options = {}) {
      harness.memory.calls.move.push({ sourcePath, destinationPath, options });
      stagedPath = sourcePath;
      winnerPath = destinationPath;
      publishDirectoryCopy(harness.memory, sourcePath, destinationPath);
      harness.memory.entries.get(`${destinationPath}/server.py`).bytes =
        mismatchedBytes;
      throw new Error("Concurrent installer published first");
    },
  };

  await assert.rejects(
    runtime.installBundledMcpAdapter({ ...harness.options, io }),
    (error) => error.code === "MCP_ADAPTER_INSTALL_CONFLICT",
  );

  assert.equal(harness.memory.calls.move[0].options.noOverwrite, true);
  assert.equal(harness.memory.calls.remove.length, 1);
  assert.equal(harness.memory.calls.remove[0].entryPath, stagedPath);
  assert.equal(harness.memory.calls.remove[0].options.ignoreAbsent, true);
  assert.equal(harness.memory.calls.remove[0].options.recursive, true);
  assert.equal(harness.memory.entries.has(stagedPath), false);
  assert.deepEqual(
    harness.memory.entries.get(`${winnerPath}/server.py`).bytes,
    mismatchedBytes,
  );
  assert.equal(harness.memory.entries.has(winnerPath), true);
  assert.equal(
    harness.memory.calls.remove.some(
      ({ entryPath }) => entryPath === winnerPath,
    ),
    false,
  );
});

test("rejects every unexpected top-level executable or environment path", async () => {
  for (const childName of ["sitecustomize.py", ".venv", "__pycache__"]) {
    const runtime = await loadRuntime();
    const harness = createHarness();
    const installed = await runtime.installBundledMcpAdapter(harness.options);
    const unexpectedPath = `${installed.projectPath}/${childName}`;
    harness.memory.entries.set(unexpectedPath, {
      type: childName.endsWith(".py") ? "regular" : "directory",
      permissions: childName.endsWith(".py") ? 0o600 : 0o700,
      bytes: childName.endsWith(".py") ? new Uint8Array([1]) : undefined,
    });
    const removesBefore = harness.memory.calls.remove.length;

    await assert.rejects(
      runtime.installBundledMcpAdapter(harness.options),
      (error) => error.code === "MCP_ADAPTER_INSTALL_CONFLICT",
    );

    assert.equal(harness.memory.entries.has(unexpectedPath), true);
    assert.equal(harness.memory.calls.remove.length, removesBefore);
  }
});

test("changed signed content installs side by side and leaves the old path intact", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const first = await runtime.installBundledMcpAdapter(harness.options);
  harness.resources.set(
    "server.py",
    new TextEncoder().encode("runtime:server.py:new\n"),
  );

  const second = await runtime.installBundledMcpAdapter(harness.options);

  assert.notEqual(second.projectPath, first.projectPath);
  assert.deepEqual(
    adapterDirectories(harness.memory).sort(),
    [first.projectPath, second.projectPath].sort(),
  );
  assert.equal(
    harness.memory.entries.has(`${first.projectPath}/server.py`),
    true,
  );
  assert.equal(
    harness.memory.entries.has(`${second.projectPath}/server.py`),
    true,
  );
});

test("a mismatched immutable target fails closed without replacement", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const installed = await runtime.installBundledMcpAdapter(harness.options);
  const serverPath = installed.serverPath;
  const original = harness.memory.entries.get(serverPath).bytes;
  harness.memory.entries.get(serverPath).bytes = Uint8Array.from(
    original,
    (byte, index) => (index === 0 ? byte ^ 0xff : byte),
  );
  const writesBefore = harness.memory.calls.write.length;

  await assert.rejects(
    runtime.installBundledMcpAdapter(harness.options),
    (error) => error.code === "MCP_ADAPTER_INSTALL_CONFLICT",
  );

  assert.equal(harness.memory.calls.write.length, writesBefore);
  assert.notDeepEqual(harness.memory.entries.get(serverPath).bytes, original);
  assert.equal(
    [...harness.memory.entries.keys()].some((entryPath) =>
      entryPath.includes(".tmp-"),
    ),
    false,
  );
});

test("rejects symbolic storage and managed files before mutation", async () => {
  const runtime = await loadRuntime();

  const symbolicRoot = createHarness();
  const privateRoot = "/Users/researcher/.zotero-gemini-notebook";
  symbolicRoot.memory.entries.set(privateRoot, {
    type: "directory",
    permissions: 0o700,
    symbolicLink: true,
  });
  await assert.rejects(
    runtime.installBundledMcpAdapter(symbolicRoot.options),
    (error) => error.code === "MCP_ADAPTER_STORAGE_UNAVAILABLE",
  );
  assert.deepEqual(symbolicRoot.memory.calls.write, []);
  assert.deepEqual(symbolicRoot.memory.calls.remove, []);
  assert.deepEqual(symbolicRoot.memory.calls.setPermissions, []);

  const symbolicFile = createHarness();
  const installed = await runtime.installBundledMcpAdapter(
    symbolicFile.options,
  );
  symbolicFile.memory.entries.get(installed.serverPath).symbolicLink = true;
  const writesBefore = symbolicFile.memory.calls.write.length;
  await assert.rejects(
    runtime.installBundledMcpAdapter(symbolicFile.options),
    (error) => error.code === "MCP_ADAPTER_INSTALL_CONFLICT",
  );
  assert.equal(symbolicFile.memory.calls.write.length, writesBefore);
});

test("an interrupted stage removes only its owned temporary directory", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const adaptersDirectory =
    "/Users/researcher/.zotero-gemini-notebook/mcp/adapters";
  const unrelatedPath = `${adaptersDirectory}/unrelated.txt`;
  harness.memory.entries.set(unrelatedPath, {
    type: "regular",
    permissions: 0o600,
    bytes: new Uint8Array([1]),
  });
  harness.memory.failWriteAt(3);

  await assert.rejects(
    runtime.installBundledMcpAdapter(harness.options),
    (error) => error.code === "MCP_ADAPTER_STORAGE_UNAVAILABLE",
  );

  assert.equal(harness.memory.entries.has(unrelatedPath), true);
  assert.equal(adapterDirectories(harness.memory).length, 0);
  assert.equal(harness.memory.calls.remove.length, 1);
  assert.equal(harness.memory.calls.remove[0].options.recursive, true);
  assert.equal(
    harness.memory.calls.remove[0].entryPath.includes(".tmp-"),
    true,
  );
});

test("an invalid unique-directory result is never adopted or removed", async () => {
  const runtime = await loadRuntime();
  const harness = createHarness();
  const protectedPath =
    "/Users/researcher/.zotero-gemini-notebook/mcp/adapters/protected";
  harness.memory.entries.set(protectedPath, {
    type: "directory",
    permissions: 0o700,
  });
  const io = {
    ...harness.memory.api,
    async createUniqueDirectory() {
      return protectedPath;
    },
  };

  await assert.rejects(
    runtime.installBundledMcpAdapter({ ...harness.options, io }),
    (error) => error.code === "MCP_ADAPTER_STORAGE_UNAVAILABLE",
  );

  assert.equal(harness.memory.entries.has(protectedPath), true);
  assert.deepEqual(harness.memory.calls.remove, []);
  assert.deepEqual(harness.memory.calls.write, []);
});

test("Windows installation defers POSIX mode enforcement", async () => {
  const runtime = await loadRuntime();
  for (const platform of ["WINNT", "win32"]) {
    const harness = createHarness({ platform });
    const result = await runtime.installBundledMcpAdapter(harness.options);

    assert.equal(harness.memory.entries.has(result.serverPath), true);
    assert.deepEqual(harness.memory.calls.setPermissions, []);
  }
});

test("invalid resources and relative home paths fail before storage mutation", async () => {
  const runtime = await loadRuntime();
  const invalidResource = createHarness({
    async resourceReader() {
      return new Uint8Array();
    },
  });
  await assert.rejects(
    runtime.installBundledMcpAdapter(invalidResource.options),
    (error) => error.code === "MCP_ADAPTER_RESOURCE_UNAVAILABLE",
  );
  assert.equal(invalidResource.memory.entries.size, 0);

  const relativeHome = createHarness({ homeDir: "relative/profile" });
  await assert.rejects(
    runtime.installBundledMcpAdapter(relativeHome.options),
    (error) => error.code === "MCP_ADAPTER_STORAGE_UNAVAILABLE",
  );
  assert.equal(relativeHome.memory.entries.size, 0);
});
