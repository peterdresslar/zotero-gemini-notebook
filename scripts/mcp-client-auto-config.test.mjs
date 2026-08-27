import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMcpClientAutoConfigRegistration,
  createMcpClientAutoConfigPlan,
  createMcpClientAutoConfigReceipt,
  evaluateMcpClientAutoConfigReset,
  MCP_AUTO_CONFIG_CLIENT_IDS,
  MCP_AUTO_CONFIG_MODES,
  MCP_AUTO_CONFIG_RECEIPT_VERSION,
  normalizeMcpClientAutoConfigLaunchSpec,
} from "../src/modules/mcpClientAutoConfig.js";

const SERVER_NAME = "zotero-gemini-notebook";
const LAUNCH_SPEC = Object.freeze({
  command: "/Users/researcher/Library/Application Support/ZGN/adapter/launcher",
  args: Object.freeze(["--stdio", "--adapter-version", "0.4.0"]),
});

function plan(clientId, mode = "add") {
  return createMcpClientAutoConfigPlan({
    clientId,
    clientExecutable: `/opt/clients/${clientId}`,
    mode,
    launchSpec: LAUNCH_SPEC,
  });
}

test("declares only the exact supported clients, modes, and receipt version", () => {
  assert.deepEqual(MCP_AUTO_CONFIG_CLIENT_IDS, [
    "codex",
    "claude-code",
    "gemini-cli",
  ]);
  assert.deepEqual(MCP_AUTO_CONFIG_MODES, ["add", "reset"]);
  assert.equal(MCP_AUTO_CONFIG_RECEIPT_VERSION, 1);
  assert.equal(Object.isFrozen(MCP_AUTO_CONFIG_CLIENT_IDS), true);
  assert.equal(Object.isFrozen(MCP_AUTO_CONFIG_MODES), true);
});

test("plans Codex add and reset as direct argv without quoting", () => {
  assert.deepEqual(plan("codex"), {
    clientId: "codex",
    mode: "add",
    serverName: SERVER_NAME,
    executable: "/opt/clients/codex",
    argv: [
      "mcp",
      "add",
      SERVER_NAME,
      "--",
      LAUNCH_SPEC.command,
      ...LAUNCH_SPEC.args,
    ],
    launchSpec: LAUNCH_SPEC,
  });
  assert.deepEqual(plan("codex", "reset").argv, ["mcp", "remove", SERVER_NAME]);
});

test("plans Claude Code add and reset at explicit user scope", () => {
  assert.deepEqual(plan("claude-code").argv, [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    SERVER_NAME,
    "--",
    LAUNCH_SPEC.command,
    ...LAUNCH_SPEC.args,
  ]);
  assert.deepEqual(plan("claude-code", "reset").argv, [
    "mcp",
    "remove",
    SERVER_NAME,
    "--scope",
    "user",
  ]);
});

test("plans Gemini CLI add and reset at user scope without trust", () => {
  const add = plan("gemini-cli");
  assert.deepEqual(add.argv, [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    SERVER_NAME,
    LAUNCH_SPEC.command,
    "--",
    ...LAUNCH_SPEC.args,
  ]);
  assert.equal(add.argv.includes("--trust"), false);
  assert.deepEqual(plan("gemini-cli", "reset").argv, [
    "mcp",
    "remove",
    SERVER_NAME,
    "--scope",
    "user",
  ]);
});

test("preserves spaces and shell metacharacters as inert argv tokens", () => {
  const result = createMcpClientAutoConfigPlan({
    clientId: "codex",
    clientExecutable: "/Applications/Codex Preview/bin/codex",
    mode: "add",
    launchSpec: {
      command: "/Users/researcher/Adapter Files/launcher",
      args: ["literal value", "$(touch /tmp/no)", "; not-a-command"],
    },
  });

  assert.equal(result.executable, "/Applications/Codex Preview/bin/codex");
  assert.deepEqual(result.argv.slice(-4), [
    "/Users/researcher/Adapter Files/launcher",
    "literal value",
    "$(touch /tmp/no)",
    "; not-a-command",
  ]);
});

test("accepts POSIX and drive-rooted Windows executable paths", () => {
  assert.equal(
    createMcpClientAutoConfigPlan({
      clientId: "codex",
      clientExecutable: "C:\\Program Files\\Codex\\codex.exe",
      mode: "add",
      launchSpec: {
        command: "D:/Zotero Gemini Notebook/adapter.exe",
        args: [],
      },
    }).executable,
    "C:\\Program Files\\Codex\\codex.exe",
  );
  assert.equal(
    normalizeMcpClientAutoConfigLaunchSpec({
      command: "/opt/zgn/launcher",
      args: [],
    }).command,
    "/opt/zgn/launcher",
  );
});

test("rejects relative, UNC, empty, and control-character paths", () => {
  for (const clientExecutable of [
    "codex",
    "./codex",
    "C:codex.exe",
    "\\\\server\\share\\codex.exe",
    "",
    "/opt/codex\nspoof",
  ]) {
    assert.throws(
      () =>
        createMcpClientAutoConfigPlan({
          clientId: "codex",
          clientExecutable,
          mode: "add",
          launchSpec: LAUNCH_SPEC,
        }),
      TypeError,
    );
  }

  for (const command of [
    "launcher",
    "../launcher",
    "C:launcher.exe",
    "//server/launcher",
    "/opt/launcher\u0000suffix",
  ]) {
    assert.throws(
      () => normalizeMcpClientAutoConfigLaunchSpec({ command, args: [] }),
      TypeError,
    );
  }
});

test("rejects control characters and malformed launch argument arrays", () => {
  for (const args of [
    "--stdio",
    [1],
    [""],
    ["line\nbreak"],
    Array.from({ length: 129 }, () => "argument"),
  ]) {
    assert.throws(
      () =>
        normalizeMcpClientAutoConfigLaunchSpec({
          command: "/opt/zgn/launcher",
          args,
        }),
      TypeError,
    );
  }
});

test("rejects aliases, unsupported clients, modes, and secret-bearing fields", () => {
  for (const clientId of [
    "Codex",
    " codex",
    "claude-desktop",
    "gemini",
    "custom",
    null,
  ]) {
    assert.throws(
      () =>
        createMcpClientAutoConfigPlan({
          clientId,
          clientExecutable: "/opt/client",
          mode: "add",
          launchSpec: LAUNCH_SPEC,
        }),
      TypeError,
    );
  }

  for (const mode of ["verify", "replace", "remove", "ADD", null]) {
    assert.throws(
      () =>
        createMcpClientAutoConfigPlan({
          clientId: "codex",
          clientExecutable: "/opt/client",
          mode,
          launchSpec: LAUNCH_SPEC,
        }),
      TypeError,
    );
  }

  for (const extra of [
    { env: { TOKEN: "secret" } },
    { token: "secret" },
    { shell: true },
  ]) {
    assert.throws(
      () =>
        createMcpClientAutoConfigPlan({
          clientId: "codex",
          clientExecutable: "/opt/client",
          mode: "add",
          launchSpec: LAUNCH_SPEC,
          ...extra,
        }),
      TypeError,
    );
  }

  assert.throws(
    () =>
      normalizeMcpClientAutoConfigLaunchSpec({
        command: "/opt/zgn/launcher",
        args: [],
        env: { TOKEN: "secret" },
      }),
    TypeError,
  );
});

test("freezes plans, argv, launch specifications, and launch arguments", () => {
  const result = plan("codex");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.argv), true);
  assert.equal(Object.isFrozen(result.launchSpec), true);
  assert.equal(Object.isFrozen(result.launchSpec.args), true);
  assert.throws(() => result.argv.push("unexpected"), TypeError);
  assert.throws(() => result.launchSpec.args.push("unexpected"), TypeError);
});

test("classifies absent, exact, and conflicting registrations exactly", () => {
  assert.deepEqual(
    classifyMcpClientAutoConfigRegistration({
      desiredLaunchSpec: LAUNCH_SPEC,
      currentLaunchSpec: null,
    }),
    { status: "absent" },
  );
  assert.deepEqual(
    classifyMcpClientAutoConfigRegistration({
      desiredLaunchSpec: LAUNCH_SPEC,
      currentLaunchSpec: {
        command: LAUNCH_SPEC.command,
        args: [...LAUNCH_SPEC.args],
      },
    }),
    { status: "exact-match" },
  );

  for (const currentLaunchSpec of [
    { command: "/different/launcher", args: [...LAUNCH_SPEC.args] },
    { command: LAUNCH_SPEC.command, args: ["--stdio"] },
    {
      command: LAUNCH_SPEC.command,
      args: ["--adapter-version", "0.4.0", "--stdio"],
    },
  ]) {
    assert.deepEqual(
      classifyMcpClientAutoConfigRegistration({
        desiredLaunchSpec: LAUNCH_SPEC,
        currentLaunchSpec,
      }),
      { status: "conflict" },
    );
  }
});

test("creates a deeply immutable non-secret managed receipt", () => {
  const receipt = createMcpClientAutoConfigReceipt({
    clientId: "claude-code",
    launchSpec: LAUNCH_SPEC,
  });
  assert.deepEqual(receipt, {
    version: 1,
    clientId: "claude-code",
    serverName: SERVER_NAME,
    launchSpec: LAUNCH_SPEC,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.launchSpec), true);
  assert.equal(Object.isFrozen(receipt.launchSpec.args), true);
  assert.deepEqual(Object.keys(receipt), [
    "version",
    "clientId",
    "serverName",
    "launchSpec",
  ]);
});

test("authorizes reset only for the receipt client and exact current entry", () => {
  const receipt = createMcpClientAutoConfigReceipt({
    clientId: "codex",
    launchSpec: LAUNCH_SPEC,
  });
  const decision = evaluateMcpClientAutoConfigReset({
    clientId: "codex",
    currentLaunchSpec: {
      command: LAUNCH_SPEC.command,
      args: [...LAUNCH_SPEC.args],
    },
    receipt,
  });

  assert.deepEqual(decision, {
    allowed: true,
    reason: "managed-exact-match",
  });
  assert.equal(Object.isFrozen(decision), true);
});

test("reset fails closed for missing, invalid, mismatched, or changed state", () => {
  const receipt = createMcpClientAutoConfigReceipt({
    clientId: "codex",
    launchSpec: LAUNCH_SPEC,
  });
  const evaluate = (overrides) =>
    evaluateMcpClientAutoConfigReset({
      clientId: "codex",
      currentLaunchSpec: LAUNCH_SPEC,
      receipt,
      ...overrides,
    });

  assert.deepEqual(evaluate({ receipt: null }), {
    allowed: false,
    reason: "missing-receipt",
  });
  assert.deepEqual(evaluate({ receipt: { ...receipt, version: 2 } }), {
    allowed: false,
    reason: "invalid-receipt",
  });
  assert.deepEqual(evaluate({ receipt: { ...receipt, unexpected: true } }), {
    allowed: false,
    reason: "invalid-receipt",
  });
  assert.deepEqual(evaluate({ clientId: "claude-code" }), {
    allowed: false,
    reason: "client-mismatch",
  });
  assert.deepEqual(evaluate({ currentLaunchSpec: null }), {
    allowed: false,
    reason: "registration-missing",
  });
  assert.deepEqual(
    evaluate({
      currentLaunchSpec: {
        command: LAUNCH_SPEC.command,
        args: ["--stdio", "--adapter-version", "0.4.1"],
      },
    }),
    { allowed: false, reason: "registration-changed" },
  );
  assert.deepEqual(
    evaluate({
      currentLaunchSpec: {
        command: "not-an-absolute-command",
        args: [],
      },
    }),
    { allowed: false, reason: "registration-changed" },
  );
});
