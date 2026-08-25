import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverMcpAutoConfigExecutables,
  McpExecutableDiscoveryError,
} from "../src/modules/mcpExecutableDiscovery.js";

function input(overrides = {}) {
  return {
    clientId: "codex",
    clientExecutablePath: "",
    runtimePath: "",
    homeDir: "/Users/researcher",
    platform: "darwin",
    ...overrides,
  };
}

function dependencies({ paths = [], searches = {} } = {}) {
  const calls = { isExecutableFile: [], pathSearch: [] };
  const existing = new Set(paths);
  return {
    calls,
    value: {
      async isExecutableFile(path) {
        calls.isExecutableFile.push(path);
        return existing.has(path);
      },
      async pathSearch(command) {
        calls.pathSearch.push(command);
        const result = searches[command];
        if (result instanceof Error) throw result;
        if (typeof result !== "string") throw new Error("not found");
        return result;
      },
    },
  };
}

test("prefers explicit absolute client and uv paths without searching", async () => {
  const deps = dependencies({
    paths: ["/custom/bin/codex", "/custom/bin/uv"],
  });
  const result = await discoverMcpAutoConfigExecutables(
    input({
      clientExecutablePath: " /custom/bin/codex ",
      runtimePath: " /custom/bin/uv ",
    }),
    deps.value,
  );

  assert.deepEqual(result, {
    clientExecutablePath: "/custom/bin/codex",
    runtimePath: "/custom/bin/uv",
  });
  assert.deepEqual(deps.calls.pathSearch, []);
  assert.equal(Object.isFrozen(result), true);
});

test("uses PATH results before narrow macOS fallback locations", async () => {
  const deps = dependencies({
    paths: ["/path/codex", "/path/uv"],
    searches: { codex: "/path/codex", uv: "/path/uv" },
  });
  const result = await discoverMcpAutoConfigExecutables(input(), deps.value);

  assert.deepEqual(result, {
    clientExecutablePath: "/path/codex",
    runtimePath: "/path/uv",
  });
  assert.deepEqual(deps.calls.pathSearch, ["codex", "uv"]);
});

test("finds common Finder-safe macOS paths when PATH is incomplete", async () => {
  const deps = dependencies({
    paths: ["/opt/homebrew/bin/codex", "/Users/researcher/.local/bin/uv"],
  });
  const result = await discoverMcpAutoConfigExecutables(input(), deps.value);

  assert.deepEqual(result, {
    clientExecutablePath: "/opt/homebrew/bin/codex",
    runtimePath: "/Users/researcher/.local/bin/uv",
  });
});

test("maps Claude Code and Gemini CLI to their exact executable names", async () => {
  for (const [clientId, command] of [
    ["claude-code", "claude"],
    ["gemini-cli", "gemini"],
  ]) {
    const clientPath = `/usr/local/bin/${command}`;
    const deps = dependencies({
      paths: [clientPath, "/usr/local/bin/uv"],
      searches: { [command]: clientPath, uv: "/usr/local/bin/uv" },
    });
    const result = await discoverMcpAutoConfigExecutables(
      input({ clientId }),
      deps.value,
    );
    assert.equal(result.clientExecutablePath, clientPath);
    assert.deepEqual(deps.calls.pathSearch, [command, "uv"]);
  }
});

test("uses only an executable Windows candidate and rejects UNC paths", async () => {
  const deps = dependencies({
    paths: [
      "C:\\Users\\researcher\\.local\\bin\\codex.exe",
      "C:\\Users\\researcher\\.local\\bin\\uv.exe",
    ],
  });
  assert.deepEqual(
    await discoverMcpAutoConfigExecutables(
      input({
        homeDir: "C:\\Users\\researcher",
        platform: "win32",
      }),
      deps.value,
    ),
    {
      clientExecutablePath: "C:\\Users\\researcher\\.local\\bin\\codex.exe",
      runtimePath: "C:\\Users\\researcher\\.local\\bin\\uv.exe",
    },
  );

  await assert.rejects(
    discoverMcpAutoConfigExecutables(
      input({
        clientExecutablePath: "\\\\server\\share\\codex.exe",
      }),
      deps.value,
    ),
    TypeError,
  );
  await assert.rejects(
    discoverMcpAutoConfigExecutables(
      input({
        clientExecutablePath: "C:\\Users\\researcher\\bin\\codex.cmd",
        homeDir: "C:\\Users\\researcher",
        platform: "win32",
        runtimePath: "C:\\Users\\researcher\\bin\\uv.exe",
      }),
      dependencies({
        paths: [
          "C:\\Users\\researcher\\bin\\codex.cmd",
          "C:\\Users\\researcher\\bin\\uv.exe",
        ],
      }).value,
    ),
    (error) => error?.code === "MCP_CLIENT_EXECUTABLE_NOT_FOUND",
  );
});

test("rejects search results that are not executable regular files", async () => {
  const deps = dependencies({
    paths: ["/path/uv"],
    searches: { codex: "/path/directory", uv: "/path/uv" },
  });
  await assert.rejects(
    discoverMcpAutoConfigExecutables(input(), deps.value),
    (error) => error?.code === "MCP_CLIENT_EXECUTABLE_NOT_FOUND",
  );
  assert.ok(deps.calls.isExecutableFile.includes("/path/directory"));
});

test("fails with fixed client and runtime discovery codes", async () => {
  const missingClient = dependencies();
  await assert.rejects(
    discoverMcpAutoConfigExecutables(input(), missingClient.value),
    (error) =>
      error instanceof McpExecutableDiscoveryError &&
      error.code === "MCP_CLIENT_EXECUTABLE_NOT_FOUND" &&
      !JSON.stringify(error).includes("/Users/researcher"),
  );

  const missingRuntime = dependencies({
    paths: ["/usr/local/bin/codex"],
    searches: { codex: "/usr/local/bin/codex" },
  });
  await assert.rejects(
    discoverMcpAutoConfigExecutables(input(), missingRuntime.value),
    (error) =>
      error instanceof McpExecutableDiscoveryError &&
      error.code === "MCP_RUNTIME_EXECUTABLE_NOT_FOUND",
  );
});

test("rejects malformed paths, platforms, clients, dependencies, and extras", async () => {
  const deps = dependencies();
  for (const value of [
    input({ clientId: "claude-desktop" }),
    input({ platform: "freebsd" }),
    input({ homeDir: "relative/home" }),
    input({ clientExecutablePath: "codex" }),
    { ...input(), token: "secret" },
  ]) {
    await assert.rejects(
      discoverMcpAutoConfigExecutables(value, deps.value),
      TypeError,
    );
  }
  await assert.rejects(
    discoverMcpAutoConfigExecutables(input(), {
      ...deps.value,
      env: { TOKEN: "secret" },
    }),
    TypeError,
  );
});
