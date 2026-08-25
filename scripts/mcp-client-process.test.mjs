import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMcpClientAutoConfigRegistration,
  createMcpClientAutoConfigPlan,
} from "../src/modules/mcpClientAutoConfig.js";
import {
  createGeckoMcpClientProcessRunner,
  createMcpClientProcessOrchestrator,
  MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES,
  MCP_CLIENT_PROCESS_DEFAULT_TIMEOUT_MS,
  MCP_CLIENT_PROCESS_KILL_GRACE_MS,
} from "../src/modules/mcpClientProcess.js";

const LAUNCH_SPEC = Object.freeze({
  command: "/Users/researcher/ZGN Adapter/launcher",
  args: Object.freeze(["--stdio"]),
});
const PLAN = createMcpClientAutoConfigPlan({
  clientId: "codex",
  clientExecutable: "/Applications/Codex.app/Contents/MacOS/codex",
  mode: "add",
  launchSpec: LAUNCH_SPEC,
});

function createFakeRunner(result) {
  const calls = [];
  return {
    calls,
    runner: Object.freeze({
      async run(request) {
        calls.push(request);
        if (result instanceof Error) throw result;
        return typeof result === "function" ? result(request) : result;
      },
    }),
  };
}

function processResult(overrides = {}) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: "configured",
    stderr: "",
    ...overrides,
  };
}

test("construction is inert and explicit execution sends only frozen argv", async () => {
  const fake = createFakeRunner(processResult());
  const orchestrator = createMcpClientProcessOrchestrator({
    runner: fake.runner,
  });

  assert.equal(fake.calls.length, 0);
  assert.equal(Object.isFrozen(orchestrator), true);

  const result = await orchestrator.execute(PLAN);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    executable: PLAN.executable,
    argv: PLAN.argv,
    timeoutMs: MCP_CLIENT_PROCESS_DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES,
  });
  assert.equal(Object.isFrozen(fake.calls[0]), true);
  assert.equal(Object.isFrozen(fake.calls[0].argv), true);
  assert.deepEqual(Object.keys(fake.calls[0]), [
    "executable",
    "argv",
    "timeoutMs",
    "maxOutputBytes",
  ]);
  assert.deepEqual(result, {
    outcome: "success",
    errorCode: null,
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
  });
  assert.equal(Object.isFrozen(result), true);
});

test("returns a fixed nonzero result without exposing client output", async () => {
  const rawSecret = "private-token-and-library-path";
  const fake = createFakeRunner(
    processResult({ exitCode: 7, stdout: rawSecret, stderr: rawSecret }),
  );
  const result = await createMcpClientProcessOrchestrator({
    runner: fake.runner,
  }).execute(PLAN);

  assert.deepEqual(result, {
    outcome: "nonzero-exit",
    errorCode: "CLIENT_PROCESS_NONZERO_EXIT",
    exitCode: 7,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawSecret, "u"));
  assert.equal(Object.hasOwn(result, "stdout"), false);
  assert.equal(Object.hasOwn(result, "stderr"), false);
});

test("returns a fixed timeout result and never classifies it", async () => {
  let classifierCalls = 0;
  const fake = createFakeRunner(
    processResult({
      exitCode: -15,
      timedOut: true,
      stdout: "partial-private-output",
    }),
  );
  const result = await createMcpClientProcessOrchestrator({
    runner: fake.runner,
    classifier() {
      classifierCalls += 1;
      return { status: "exact-match" };
    },
  }).execute(PLAN);

  assert.equal(classifierCalls, 0);
  assert.deepEqual(result, {
    outcome: "timeout",
    errorCode: "CLIENT_PROCESS_TIMEOUT",
    exitCode: -15,
    timedOut: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /partial-private-output/u);
});

test("caps UTF-8 output, reports truncation, and skips classification", async () => {
  let classifierCalls = 0;
  const fake = createFakeRunner(
    processResult({
      stdout: "é".repeat(20),
      stderr: "private-error-output",
    }),
  );
  const result = await createMcpClientProcessOrchestrator({
    runner: fake.runner,
    maxOutputBytes: 7,
    classifier() {
      classifierCalls += 1;
      return { status: "exact-match" };
    },
  }).execute(PLAN);

  assert.equal(classifierCalls, 0);
  assert.deepEqual(result, {
    outcome: "output-truncated",
    errorCode: "CLIENT_PROCESS_OUTPUT_TRUNCATED",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: true,
    stderrTruncated: true,
    registrationStatus: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-error-output/u);
});

test("supports an exact mcpClientAutoConfig post-call classifier", async () => {
  const observed = JSON.stringify(LAUNCH_SPEC);
  const fake = createFakeRunner(processResult({ stdout: observed }));
  const result = await createMcpClientProcessOrchestrator({
    runner: fake.runner,
    classifier(input) {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(input.clientId, "codex");
      assert.equal(input.mode, "add");
      return classifyMcpClientAutoConfigRegistration({
        desiredLaunchSpec: input.desiredLaunchSpec,
        currentLaunchSpec: JSON.parse(input.stdout),
      });
    },
  }).execute(PLAN);

  assert.deepEqual(result, {
    outcome: "success",
    errorCode: null,
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: "exact-match",
  });
  assert.doesNotMatch(JSON.stringify(result), /ZGN Adapter/u);
});

test("redacts thrown process and classifier failures", async () => {
  const processFailure = await createMcpClientProcessOrchestrator({
    runner: createFakeRunner(new Error("secret launch details")).runner,
  }).execute(PLAN);
  assert.deepEqual(processFailure, {
    outcome: "process-error",
    errorCode: "CLIENT_PROCESS_ERROR",
    exitCode: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
  });
  assert.doesNotMatch(JSON.stringify(processFailure), /secret/u);

  const classifierFailure = await createMcpClientProcessOrchestrator({
    runner: createFakeRunner(processResult()).runner,
    classifier() {
      throw new Error("secret classifier details");
    },
  }).execute(PLAN);
  assert.deepEqual(classifierFailure, {
    outcome: "classification-error",
    errorCode: "CLIENT_PROCESS_CLASSIFICATION_ERROR",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    registrationStatus: null,
  });
  assert.doesNotMatch(JSON.stringify(classifierFailure), /secret/u);
});

test("rejects altered plans before invoking the runner", async () => {
  const fake = createFakeRunner(processResult());
  const orchestrator = createMcpClientProcessOrchestrator({
    runner: fake.runner,
  });
  await assert.rejects(
    orchestrator.execute({
      ...PLAN,
      argv: [...PLAN.argv, "--unexpected"],
    }),
    TypeError,
  );
  assert.equal(fake.calls.length, 0);
});

test("Gecko runner imports lazily and appends only a derived PATH", async () => {
  const originalChromeUtils = globalThis.ChromeUtils;
  const restorePathUtils = installFakePathUtils();
  const imports = [];
  const subprocessCalls = [];
  let stdinClosed = false;
  let timerCleared = false;
  try {
    globalThis.ChromeUtils = {
      importESModule(uri) {
        imports.push(uri);
        if (uri.endsWith("Subprocess.sys.mjs")) {
          return {
            Subprocess: {
              getEnvironment() {
                return {
                  PATH: "/usr/bin:/bin",
                  OTHER_VARIABLE: "inherited",
                };
              },
              async call(options) {
                subprocessCalls.push(options);
                return {
                  stdin: {
                    async close() {
                      stdinClosed = true;
                    },
                  },
                  stdout: createPipe(["configured"]),
                  stderr: createPipe([]),
                  async wait() {
                    return { exitCode: 0 };
                  },
                  async kill() {
                    throw new Error("kill should not be called");
                  },
                };
              },
            },
          };
        }
        return {
          setTimeout() {
            return 17;
          },
          clearTimeout(id) {
            assert.equal(id, 17);
            timerCleared = true;
          },
        };
      },
    };

    const runner = createGeckoMcpClientProcessRunner();
    assert.equal(imports.length, 0);
    const result = await runner.run({
      executable: PLAN.executable,
      argv: PLAN.argv,
      timeoutMs: 1_000,
      maxOutputBytes: 32,
    });

    assert.deepEqual(imports, [
      "resource://gre/modules/Subprocess.sys.mjs",
      "resource://gre/modules/Timer.sys.mjs",
    ]);
    assert.deepEqual(subprocessCalls, [
      {
        command: PLAN.executable,
        arguments: [...PLAN.argv],
        stderr: "pipe",
        disclaim: true,
        environment: {
          PATH: "/Applications/Codex.app/Contents/MacOS:/usr/bin:/bin",
        },
        environmentAppend: true,
      },
    ]);
    assert.equal(Object.hasOwn(subprocessCalls[0], "shell"), false);
    assert.equal(
      Object.hasOwn(subprocessCalls[0].environment, "OTHER_VARIABLE"),
      false,
    );
    assert.equal(stdinClosed, true);
    assert.equal(timerCleared, true);
    assert.deepEqual(result, {
      ...processResult(),
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  } finally {
    if (originalChromeUtils === undefined) {
      delete globalThis.ChromeUtils;
    } else {
      globalThis.ChromeUtils = originalChromeUtils;
    }
    restorePathUtils();
  }
});

test("Gecko runner timeout invokes graceful-then-forced kill contract", async () => {
  const originalChromeUtils = globalThis.ChromeUtils;
  const restorePathUtils = installFakePathUtils();
  let timeoutCallback;
  let resolveWait;
  const waitPromise = new Promise((resolve) => {
    resolveWait = resolve;
  });
  const killCalls = [];
  try {
    globalThis.ChromeUtils = {
      importESModule(uri) {
        if (uri.endsWith("Subprocess.sys.mjs")) {
          return {
            Subprocess: {
              getEnvironment() {
                return { PATH: "/usr/bin:/bin" };
              },
              async call() {
                return {
                  stdin: { async close() {} },
                  stdout: createPipe([]),
                  stderr: createPipe([]),
                  wait() {
                    return waitPromise;
                  },
                  async kill(graceMs) {
                    killCalls.push(graceMs);
                    resolveWait({ exitCode: -15 });
                    return { exitCode: -15 };
                  },
                };
              },
            },
          };
        }
        return {
          setTimeout(callback) {
            timeoutCallback = callback;
            return 23;
          },
          clearTimeout() {},
        };
      },
    };

    const pending = createGeckoMcpClientProcessRunner().run({
      executable: PLAN.executable,
      argv: PLAN.argv,
      timeoutMs: 1_000,
      maxOutputBytes: 32,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(typeof timeoutCallback, "function");
    timeoutCallback();

    const result = await pending;
    assert.deepEqual(killCalls, [MCP_CLIENT_PROCESS_KILL_GRACE_MS]);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -15);
  } finally {
    if (originalChromeUtils === undefined) {
      delete globalThis.ChromeUtils;
    } else {
      globalThis.ChromeUtils = originalChromeUtils;
    }
    restorePathUtils();
  }
});

test("Gecko runner drains but retains only the configured byte cap", async () => {
  const originalChromeUtils = globalThis.ChromeUtils;
  const restorePathUtils = installFakePathUtils();
  try {
    globalThis.ChromeUtils = {
      importESModule(uri) {
        if (uri.endsWith("Subprocess.sys.mjs")) {
          return {
            Subprocess: {
              getEnvironment() {
                return { PATH: "/usr/bin:/bin" };
              },
              async call() {
                return {
                  stdin: { async close() {} },
                  stdout: createPipe(["12345", "67890", "drained"]),
                  stderr: createPipe(["error"]),
                  async wait() {
                    return { exitCode: 0 };
                  },
                  async kill() {},
                };
              },
            },
          };
        }
        return {
          setTimeout() {
            return 31;
          },
          clearTimeout() {},
        };
      },
    };

    const result = await createGeckoMcpClientProcessRunner().run({
      executable: PLAN.executable,
      argv: PLAN.argv,
      timeoutMs: 1_000,
      maxOutputBytes: 7,
    });
    assert.equal(result.stdout, "1234567");
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderr, "error");
    assert.equal(result.stderrTruncated, false);
  } finally {
    if (originalChromeUtils === undefined) {
      delete globalThis.ChromeUtils;
    } else {
      globalThis.ChromeUtils = originalChromeUtils;
    }
    restorePathUtils();
  }
});

test("Gecko runner redacts raw launch failures", async () => {
  const originalChromeUtils = globalThis.ChromeUtils;
  const restorePathUtils = installFakePathUtils();
  try {
    globalThis.ChromeUtils = {
      importESModule(uri) {
        if (uri.endsWith("Subprocess.sys.mjs")) {
          return {
            Subprocess: {
              getEnvironment() {
                return { PATH: "/usr/bin:/bin" };
              },
              async call() {
                throw new Error("private executable path and environment");
              },
            },
          };
        }
        return {
          setTimeout() {
            return 1;
          },
          clearTimeout() {},
        };
      },
    };

    await assert.rejects(
      createGeckoMcpClientProcessRunner().run({
        executable: PLAN.executable,
        argv: PLAN.argv,
        timeoutMs: 1_000,
        maxOutputBytes: 32,
      }),
      (error) => {
        assert.equal(error.message, "MCP client process failed.");
        assert.doesNotMatch(error.message, /private|environment/u);
        return true;
      },
    );
  } finally {
    if (originalChromeUtils === undefined) {
      delete globalThis.ChromeUtils;
    } else {
      globalThis.ChromeUtils = originalChromeUtils;
    }
    restorePathUtils();
  }
});

function installFakePathUtils() {
  const originalPathUtils = globalThis.PathUtils;
  globalThis.PathUtils = {
    parent(path) {
      const separatorIndex = Math.max(
        path.lastIndexOf("/"),
        path.lastIndexOf("\\"),
      );
      return separatorIndex > 0 ? path.slice(0, separatorIndex) : null;
    },
  };
  return () => {
    if (originalPathUtils === undefined) {
      delete globalThis.PathUtils;
    } else {
      globalThis.PathUtils = originalPathUtils;
    }
  };
}

function createPipe(chunks) {
  const encoder = new globalThis.TextEncoder();
  const pending = chunks.map((chunk) => encoder.encode(chunk).buffer);
  pending.push(new ArrayBuffer(0));
  return {
    async read() {
      return pending.shift();
    },
  };
}
