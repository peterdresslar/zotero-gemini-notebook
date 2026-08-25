import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import * as mcpClientAutoConfigRuntime from "../src/modules/mcpClientAutoConfig.js";
import * as mcpConfigRuntime from "../src/modules/mcpConfig.js";
import * as mcpExecutableDiscoveryRuntime from "../src/modules/mcpExecutableDiscovery.js";

const sourceURL = new URL(
  "../src/modules/mcpAutoConfigure.ts",
  import.meta.url,
);

async function loadRuntime() {
  const source = await readFile(sourceURL, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "mcpAutoConfigure.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);

  const module = { exports: {} };
  const factory = vm.runInNewContext(
    `(function (exports, require, module) { ${compiled.outputText}\n })`,
    {
      Error,
      Object,
      Promise,
      globalThis: {},
    },
  );
  factory(
    module.exports,
    (specifier) => {
      if (specifier.endsWith("mcpConfig.js")) {
        return mcpConfigRuntime;
      }
      if (specifier.endsWith("mcpClientAutoConfig.js")) {
        return mcpClientAutoConfigRuntime;
      }
      if (specifier.endsWith("mcpClientProcess.js")) {
        return {
          MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES: 16 * 1024,
          createGeckoMcpClientProcessRunner() {
            throw new Error("default runner must not be constructed");
          },
          createMcpClientProcessOrchestrator() {
            throw new Error("default orchestrator must not be constructed");
          },
        };
      }
      if (specifier.endsWith("mcpAdapterInstaller")) {
        return { installBundledMcpAdapter() {} };
      }
      if (specifier.endsWith("mcpExecutableDiscovery.js")) {
        class McpExecutableDiscoveryError extends Error {}
        return {
          McpExecutableDiscoveryError,
          discoverMcpAutoConfigExecutables() {},
        };
      }
      if (specifier.endsWith("mcpLocalAuth")) {
        return { ensureMcpLocalAuthorization() {} };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
    module,
  );
  return module.exports;
}

function input(overrides = {}) {
  return {
    clientExecutablePath: "",
    clientId: "codex",
    homeDir: "/Users/researcher",
    platform: "darwin",
    replaceExisting: true,
    runtimePath: "",
    ...overrides,
  };
}

function successResult(overrides = {}) {
  return {
    outcome: "success",
    errorCode: null,
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = {
    authorization: 0,
    discover: [],
    execute: [],
    install: 0,
    order: [],
    preflight: [],
  };
  return {
    calls,
    dependencies: {
      async discoverExecutables(value) {
        calls.discover.push(value);
        calls.order.push("discover");
        return {
          clientExecutablePath: "/opt/homebrew/bin/codex",
          runtimePath: "/Users/researcher/.local/bin/uv",
        };
      },
      async installAdapter() {
        calls.install += 1;
        calls.order.push("install");
        return {
          projectPath: "/Users/researcher/.zgn/adapter",
          serverPath: "/Users/researcher/.zgn/adapter/server.py",
        };
      },
      async preflightAdapter(launchSpec) {
        calls.preflight.push(launchSpec);
        calls.order.push("preflight");
      },
      async executePlan(plan) {
        calls.execute.push(plan);
        calls.order.push(`execute:${plan.mode}`);
        return successResult();
      },
      async ensureLocalAuthorization() {
        calls.authorization += 1;
        calls.order.push("authorization");
      },
      ...overrides,
    },
  };
}

test("installs, preflights, authorizes, then registers after explicit invocation", async () => {
  const runtime = await loadRuntime();
  const testHarness = harness();
  assert.deepEqual(testHarness.calls, {
    authorization: 0,
    discover: [],
    execute: [],
    install: 0,
    order: [],
    preflight: [],
  });

  const result = await runtime.autoConfigureMcpClient(
    input(),
    testHarness.dependencies,
  );

  assert.equal(testHarness.calls.install, 1);
  assert.equal(testHarness.calls.preflight.length, 1);
  assert.equal(testHarness.calls.execute.length, 1);
  assert.equal(testHarness.calls.execute[0].mode, "add");
  assert.equal(testHarness.calls.authorization, 1);
  assert.deepEqual(testHarness.calls.order, [
    "discover",
    "install",
    "preflight",
    "authorization",
    "execute:add",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    adapterPath: "/Users/researcher/.zgn/adapter/server.py",
    clientExecutablePath: "/opt/homebrew/bin/codex",
    clientId: "codex",
    launchSpec: {
      serverName: "zotero-gemini-notebook",
      command: "/Users/researcher/.local/bin/uv",
      args: [
        "--no-config",
        "--no-python-downloads",
        "--no-progress",
        "run",
        "--isolated",
        "--locked",
        "--project",
        "/Users/researcher/.zgn/adapter",
        "python",
        "-E",
        "-s",
        "-B",
        "/Users/researcher/.zgn/adapter/server.py",
      ],
    },
    runtimePath: "/Users/researcher/.local/bin/uv",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("composes the exact strict executable-discovery request", async () => {
  const runtime = await loadRuntime();
  const request = runtime.createMcpExecutableDiscoveryInput(input());

  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    clientExecutablePath: "",
    clientId: "codex",
    homeDir: "/Users/researcher",
    platform: "darwin",
    runtimePath: "",
  });
  assert.equal(Object.isFrozen(request), true);

  const discovered =
    await mcpExecutableDiscoveryRuntime.discoverMcpAutoConfigExecutables(
      request,
      {
        async isExecutableFile(path) {
          return ["/opt/homebrew/bin/codex", "/usr/local/bin/uv"].includes(
            path,
          );
        },
        async pathSearch(command) {
          return command === "codex"
            ? "/opt/homebrew/bin/codex"
            : "/usr/local/bin/uv";
        },
      },
    );
  assert.deepEqual(discovered, {
    clientExecutablePath: "/opt/homebrew/bin/codex",
    runtimePath: "/usr/local/bin/uv",
  });
});

test("builds the exact bounded import preflight from the real launch spec", async () => {
  const runtime = await loadRuntime();
  const launchSpec = mcpConfigRuntime.createMcpStdioLaunchSpec(
    {
      enabled: true,
      clientPreset: "codex",
      clientExecutablePath: "",
      runtimePath: "/Users/researcher/.local/bin/uv",
      adapterPath: "/Users/researcher/.zgn/adapter/server.py",
      clientConfigPath: "",
    },
    "darwin",
  );

  const request = runtime.createMcpAdapterPreflightRequest(launchSpec);
  assert.equal(request.executable, "/Users/researcher/.local/bin/uv");
  assert.deepEqual(Array.from(request.argv), [
    "--no-config",
    "--no-python-downloads",
    "--no-progress",
    "run",
    "--isolated",
    "--locked",
    "--project",
    "/Users/researcher/.zgn/adapter",
    "python",
    "-E",
    "-s",
    "-B",
    "-c",
    "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='zgn_preflight')",
    "/Users/researcher/.zgn/adapter",
    "/Users/researcher/.zgn/adapter/server.py",
  ]);
  assert.equal(request.timeoutMs, 120_000);
  assert.equal(request.maxOutputBytes, 16 * 1024);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.argv), true);
});

test("rejects a custom adapter path before installing or executing it", async () => {
  const runtime = await loadRuntime();
  const testHarness = harness();

  await assert.rejects(
    runtime.autoConfigureMcpClient(
      { ...input(), adapterPath: "/opt/zgn/custom/server.py" },
      testHarness.dependencies,
    ),
    (error) => error.code === "MCP_AUTO_CONFIG_INVALID",
  );

  assert.equal(testHarness.calls.install, 0);
  assert.equal(testHarness.calls.execute.length, 0);
  assert.equal(testHarness.calls.authorization, 0);
});

test("fails adapter preflight before client mutation or authorization", async () => {
  const runtime = await loadRuntime();
  const testHarness = harness({
    async preflightAdapter(launchSpec) {
      testHarness.calls.preflight.push(launchSpec);
      throw new Error("private adapter failure");
    },
  });

  await assert.rejects(
    runtime.autoConfigureMcpClient(input(), testHarness.dependencies),
    (error) =>
      error?.code === "MCP_ADAPTER_PREFLIGHT_FAILED" &&
      !JSON.stringify(error).includes("private adapter failure"),
  );
  assert.equal(testHarness.calls.preflight.length, 1);
  assert.equal(testHarness.calls.execute.length, 0);
  assert.equal(testHarness.calls.authorization, 0);
});

test("authorization failure occurs before any client mutation", async () => {
  const runtime = await loadRuntime();
  const testHarness = harness({
    async ensureLocalAuthorization() {
      testHarness.calls.authorization += 1;
      testHarness.calls.order.push("authorization");
      throw new Error("private key path");
    },
  });

  await assert.rejects(
    runtime.autoConfigureMcpClient(input(), testHarness.dependencies),
    (error) =>
      error?.code === "MCP_LOCAL_AUTHORIZATION_FAILED" &&
      !JSON.stringify(error).includes("private key path"),
  );
  assert.deepEqual(testHarness.calls.order, [
    "discover",
    "install",
    "preflight",
    "authorization",
  ]);
  assert.equal(testHarness.calls.execute.length, 0);
});

test("Claude resets only the fixed registration before adding it", async () => {
  const runtime = await loadRuntime();
  const outcomes = [successResult(), successResult()];
  const testHarness = harness({
    async discoverExecutables() {
      return {
        clientExecutablePath: "/Users/researcher/.local/bin/claude",
        runtimePath: "/Users/researcher/.local/bin/uv",
      };
    },
    async executePlan(plan) {
      testHarness.calls.execute.push(plan);
      return outcomes.shift();
    },
  });

  await runtime.autoConfigureMcpClient(
    input({ clientId: "claude-code" }),
    testHarness.dependencies,
  );
  assert.deepEqual(
    testHarness.calls.execute.map(({ mode }) => mode),
    ["reset", "add"],
  );
});

test("requires explicit registration-change confirmation for every client", async () => {
  const runtime = await loadRuntime();
  for (const clientId of ["codex", "claude-code", "gemini-cli"]) {
    const testHarness = harness();
    await assert.rejects(
      runtime.autoConfigureMcpClient(
        input({ clientId, replaceExisting: false }),
        testHarness.dependencies,
      ),
      (error) => error.code === "MCP_CLIENT_CHANGE_NOT_CONFIRMED",
    );
    assert.deepEqual(testHarness.calls.order, []);
    assert.equal(testHarness.calls.execute.length, 0);
    assert.equal(testHarness.calls.authorization, 0);
  }
});

test("Claude still adds when its fixed registration was absent", async () => {
  const runtime = await loadRuntime();
  const outcomes = [
    successResult({
      outcome: "nonzero-exit",
      errorCode: "CLIENT_PROCESS_NONZERO_EXIT",
      exitCode: 1,
    }),
    successResult(),
  ];
  const testHarness = harness({
    async executePlan(plan) {
      testHarness.calls.execute.push(plan);
      return outcomes.shift();
    },
  });

  await runtime.autoConfigureMcpClient(
    input({ clientId: "claude-code" }),
    testHarness.dependencies,
  );
  assert.deepEqual(
    testHarness.calls.execute.map(({ mode }) => mode),
    ["reset", "add"],
  );
});

test("reports every unconfirmed Claude replacement after the reset attempt", async () => {
  const runtime = await loadRuntime();
  for (const replacementResult of [
    successResult({
      outcome: "nonzero-exit",
      errorCode: "CLIENT_PROCESS_NONZERO_EXIT",
      exitCode: 1,
    }),
    successResult({
      outcome: "timeout",
      errorCode: "CLIENT_PROCESS_TIMEOUT",
      exitCode: -15,
      timedOut: true,
    }),
    successResult({
      outcome: "process-error",
      errorCode: "CLIENT_PROCESS_ERROR",
      exitCode: null,
    }),
    successResult({
      outcome: "output-truncated",
      errorCode: "CLIENT_PROCESS_OUTPUT_TRUNCATED",
      exitCode: 0,
      stdoutTruncated: true,
    }),
    successResult({
      outcome: "classification-error",
      errorCode: "CLIENT_PROCESS_CLASSIFICATION_ERROR",
      exitCode: 0,
    }),
  ]) {
    const outcomes = [successResult(), replacementResult];
    const testHarness = harness({
      async executePlan(plan) {
        testHarness.calls.execute.push(plan);
        return outcomes.shift();
      },
    });

    await assert.rejects(
      runtime.autoConfigureMcpClient(
        input({ clientId: "claude-code" }),
        testHarness.dependencies,
      ),
      (error) =>
        error.code === "MCP_CLIENT_REPLACEMENT_INCOMPLETE" &&
        /could not confirm a usable replacement/u.test(error.message) &&
        !/accepted|private|secret/u.test(error.message),
    );
    assert.deepEqual(
      testHarness.calls.execute.map(({ mode }) => mode),
      ["reset", "add"],
    );
  }
});

test("fails closed and redacts adapter, client, timeout, and auth failures", async () => {
  const runtime = await loadRuntime();
  for (const [dependencies, code] of [
    [
      harness({
        async installAdapter() {
          throw new Error("private adapter path");
        },
      }).dependencies,
      "MCP_ADAPTER_INSTALL_FAILED",
    ],
    [
      harness({
        async executePlan() {
          throw new Error("secret process output");
        },
      }).dependencies,
      "MCP_CLIENT_CONFIGURATION_UNCERTAIN",
    ],
    [
      harness({
        async executePlan() {
          return successResult({
            outcome: "timeout",
            errorCode: "CLIENT_PROCESS_TIMEOUT",
            exitCode: -15,
            timedOut: true,
          });
        },
      }).dependencies,
      "MCP_CLIENT_CONFIGURATION_UNCERTAIN",
    ],
    [
      harness({
        async ensureLocalAuthorization() {
          throw new Error("private key path");
        },
      }).dependencies,
      "MCP_LOCAL_AUTHORIZATION_FAILED",
    ],
  ]) {
    await assert.rejects(
      runtime.autoConfigureMcpClient(input(), dependencies),
      (error) =>
        error.code === code &&
        !/private|secret|\/Users\/researcher/u.test(JSON.stringify(error)),
    );
  }
});

test("rejects malformed or manual-client requests before any side effect", async () => {
  const runtime = await loadRuntime();
  for (const invalid of [
    input({ clientId: "claude-desktop" }),
    input({ platform: "other" }),
    input({ replaceExisting: "yes" }),
    { ...input(), adapterPath: "/opt/zgn/custom/server.py" },
    { ...input(), token: "secret" },
  ]) {
    const testHarness = harness();
    await assert.rejects(
      runtime.autoConfigureMcpClient(invalid, testHarness.dependencies),
      (error) =>
        error.code === "MCP_AUTO_CONFIG_INVALID" ||
        error.code === "MCP_CLIENT_CHANGE_NOT_CONFIRMED",
    );
    assert.equal(testHarness.calls.install, 0);
    assert.equal(testHarness.calls.execute.length, 0);
    assert.equal(testHarness.calls.authorization, 0);
  }
});
