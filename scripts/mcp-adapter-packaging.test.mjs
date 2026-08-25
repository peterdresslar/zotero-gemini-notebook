import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const configSourcePath = new URL("../zotero-plugin.config.ts", import.meta.url);

const runtimeFiles = [
  "server.py",
  "zotero_control.py",
  "zotero_jobs.py",
  "zotero_status.py",
  "pyproject.toml",
  "uv.lock",
];

async function loadBuildConfig() {
  const source = await readFile(configSourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "zotero-plugin.config.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);

  const calls = { copyFile: [], mkdir: [], rm: [] };
  const module = { exports: {} };
  const factory = vm.runInNewContext(
    `(function (exports, require, module) { ${compiled.outputText}\n })`,
    { process: { env: {} } },
  );
  factory(
    module.exports,
    (specifier) => {
      if (specifier === "node:fs/promises") {
        return {
          async copyFile(source, destination) {
            calls.copyFile.push({ source, destination });
          },
          async mkdir(destination, options) {
            calls.mkdir.push({ destination, options });
          },
          async rm(destination, options) {
            calls.rm.push({ destination, options });
          },
        };
      }
      if (specifier === "node:path") return path.posix;
      if (specifier === "zotero-plugin-scaffold") {
        return { defineConfig: (config) => config };
      }
      if (specifier === "./package.json") {
        return {
          name: "zotero-gemini-notebook",
          version: "0.3.4",
          author: "researcher",
          description: "test",
          homepage: "https://example.invalid",
          config: {
            addonID: "addon@example.invalid",
            addonInstance: "ZoteroNotebookLM",
            addonName: "Zotero Gemini Notebook",
            addonRef: "zoteroNotebookLM",
            prefsPrefix: "extensions.zotero.zoteroNotebookLM",
          },
        };
      }
      throw new Error(`Unexpected config import: ${specifier}`);
    },
    module,
  );
  return { calls, config: module.exports.default };
}

test("the XPI build hook copies only the six adapter runtime files", async () => {
  const { calls, config } = await loadBuildConfig();

  assert.deepEqual([...config.build.assets], ["addon/**/*.*"]);
  await config.build.hooks["build:copyAssets"]({ dist: "/build" });

  assert.equal(calls.mkdir.length, 1);
  assert.equal(calls.mkdir[0].destination, "/build/addon/content/mcp-adapter");
  assert.equal(calls.mkdir[0].options.recursive, true);
  assert.deepEqual(
    calls.copyFile,
    runtimeFiles.map((filename) => ({
      source: `mcp-adapter/${filename}`,
      destination: `/build/addon/content/mcp-adapter/${filename}`,
    })),
  );
  assert.equal(
    calls.copyFile.some(({ source }) =>
      /(?:README|tests|\.venv|__pycache__|\.pyc)/.test(source),
    ),
    false,
  );
});
