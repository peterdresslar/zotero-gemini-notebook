import { createMcpClientAutoConfigPlan } from "./mcpClientAutoConfig.js";

const GECKO_SUBPROCESS_MODULE = "resource://gre/modules/Subprocess.sys.mjs";
const GECKO_TIMER_MODULE = "resource://gre/modules/Timer.sys.mjs";
const MAX_PATH_LENGTH = 4096;
const MAX_ARGUMENT_COUNT = 256;
const MAX_ARGUMENT_LENGTH = 4096;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_PLAN_KEYS = new Set([
  "argv",
  "clientId",
  "executable",
  "launchSpec",
  "mode",
  "serverName",
]);
const ORCHESTRATOR_OPTION_KEYS = new Set([
  "classifier",
  "maxOutputBytes",
  "runner",
  "timeoutMs",
]);
const RUNNER_REQUEST_KEYS = new Set([
  "argv",
  "executable",
  "maxOutputBytes",
  "timeoutMs",
]);
const REGISTRATION_STATUSES = new Set(["absent", "exact-match", "conflict"]);

export const MCP_CLIENT_PROCESS_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
export const MCP_CLIENT_PROCESS_KILL_GRACE_MS = 300;

export function createMcpClientProcessOrchestrator(options) {
  assertPlainObjectWithAllowedKeys(
    options,
    ORCHESTRATOR_OPTION_KEYS,
    "MCP client process orchestrator options",
  );
  if (!options.runner || typeof options.runner.run !== "function") {
    throw new TypeError("An MCP client process runner is required.");
  }
  if (
    options.classifier !== undefined &&
    options.classifier !== null &&
    typeof options.classifier !== "function"
  ) {
    throw new TypeError("The MCP client result classifier must be a function.");
  }

  const runner = options.runner;
  const classifier = options.classifier ?? null;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes);

  return Object.freeze({
    async execute(planInput) {
      const plan = normalizeProcessPlan(planInput);
      const request = Object.freeze({
        executable: plan.executable,
        argv: plan.argv,
        timeoutMs,
        maxOutputBytes,
      });

      let rawResult;
      try {
        rawResult = await runner.run(request);
      } catch {
        return createProcessResult("process-error");
      }

      const normalized = normalizeRunnerResult(rawResult, maxOutputBytes);
      if (normalized === null) {
        return createProcessResult("process-error");
      }
      if (normalized.timedOut) {
        return createProcessResult("timeout", normalized);
      }
      if (normalized.exitCode !== 0) {
        return createProcessResult("nonzero-exit", normalized);
      }
      if (normalized.stdoutTruncated || normalized.stderrTruncated) {
        return createProcessResult("output-truncated", normalized);
      }

      let registrationStatus = null;
      if (classifier) {
        try {
          const classification = await classifier(
            Object.freeze({
              clientId: plan.clientId,
              mode: plan.mode,
              serverName: plan.serverName,
              desiredLaunchSpec: plan.launchSpec,
              stdout: normalized.stdout,
              stderr: normalized.stderr,
            }),
          );
          registrationStatus = readRegistrationStatus(classification);
          if (registrationStatus === null) {
            return createProcessResult("classification-error", normalized);
          }
        } catch {
          return createProcessResult("classification-error", normalized);
        }
      }

      return createProcessResult("success", normalized, registrationStatus);
    },
  });
}

export function createGeckoMcpClientProcessRunner() {
  return Object.freeze({
    async run(requestInput) {
      const request = normalizeRunnerRequest(requestInput);
      const chromeUtils = globalThis.ChromeUtils;
      if (!chromeUtils || typeof chromeUtils.importESModule !== "function") {
        throw new Error("Gecko process support is unavailable.");
      }

      let Subprocess;
      let clearTimeout;
      let setTimeout;
      try {
        ({ Subprocess } = chromeUtils.importESModule(GECKO_SUBPROCESS_MODULE));
        ({ clearTimeout, setTimeout } =
          chromeUtils.importESModule(GECKO_TIMER_MODULE));
      } catch {
        throw geckoProcessError();
      }
      if (
        !Subprocess ||
        typeof Subprocess.call !== "function" ||
        typeof Subprocess.getEnvironment !== "function" ||
        typeof setTimeout !== "function" ||
        typeof clearTimeout !== "function"
      ) {
        throw geckoProcessError();
      }

      const environment = createExecutablePathEnvironment(
        Subprocess,
        request.executable,
      );

      let process;
      try {
        process = await Subprocess.call({
          command: request.executable,
          arguments: [...request.argv],
          stderr: "pipe",
          disclaim: true,
          environment,
          environmentAppend: true,
        });
      } catch {
        throw geckoProcessError();
      }

      let timerId = null;
      let timedOut = false;
      try {
        if (
          !process.stdout ||
          !process.stderr ||
          typeof process.wait !== "function" ||
          typeof process.kill !== "function"
        ) {
          throw new Error("Gecko returned an invalid process handle.");
        }
        if (process.stdin && typeof process.stdin.close === "function") {
          Promise.resolve(process.stdin.close()).catch(() => {});
        }

        const stdoutPromise = readBoundedPipe(
          process.stdout,
          request.maxOutputBytes,
        );
        const stderrPromise = readBoundedPipe(
          process.stderr,
          request.maxOutputBytes,
        );
        timerId = setTimeout(() => {
          timedOut = true;
          Promise.resolve(process.kill(MCP_CLIENT_PROCESS_KILL_GRACE_MS)).catch(
            () => {},
          );
        }, request.timeoutMs);

        const [waitResult, stdout, stderr] = await Promise.all([
          process.wait(),
          stdoutPromise,
          stderrPromise,
        ]);
        if (
          !isPlainObject(waitResult) ||
          !Number.isInteger(waitResult.exitCode)
        ) {
          throw new Error("Gecko returned an invalid process exit status.");
        }

        return Object.freeze({
          exitCode: waitResult.exitCode,
          timedOut,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      } catch {
        if (typeof process.kill === "function") {
          try {
            await process.kill(0);
          } catch {
            // The orchestrator converts the original failure to a fixed result.
          }
        }
        throw geckoProcessError();
      } finally {
        if (timerId !== null) clearTimeout(timerId);
      }
    },
  });
}

function geckoProcessError() {
  return new Error("MCP client process failed.");
}

function createExecutablePathEnvironment(Subprocess, executable) {
  const pathUtils = globalThis.PathUtils;
  if (!pathUtils || typeof pathUtils.parent !== "function") {
    throw geckoProcessError();
  }

  let executableDirectory;
  let inheritedEnvironment;
  try {
    executableDirectory = pathUtils.parent(executable);
    inheritedEnvironment = Subprocess.getEnvironment();
  } catch {
    throw geckoProcessError();
  }
  if (
    typeof executableDirectory !== "string" ||
    executableDirectory.length === 0 ||
    !isPlainObject(inheritedEnvironment)
  ) {
    throw geckoProcessError();
  }

  const windowsPath = /^[A-Za-z]:[\\/]/u.test(executable);
  const separator = windowsPath ? ";" : ":";
  if (executableDirectory.includes(separator)) {
    throw geckoProcessError();
  }
  const inheritedPath = inheritedEnvironment.PATH;
  if (inheritedPath !== undefined && typeof inheritedPath !== "string") {
    throw geckoProcessError();
  }

  return Object.freeze({
    PATH:
      typeof inheritedPath === "string" && inheritedPath.length > 0
        ? `${executableDirectory}${separator}${inheritedPath}`
        : executableDirectory,
  });
}

function normalizeProcessPlan(input) {
  assertPlainObjectWithExactKeys(
    input,
    PROCESS_PLAN_KEYS,
    "MCP client process plan",
  );
  const canonical = createMcpClientAutoConfigPlan({
    clientId: input.clientId,
    clientExecutable: input.executable,
    mode: input.mode,
    launchSpec: input.launchSpec,
  });
  if (
    input.serverName !== canonical.serverName ||
    !stringArraysEqual(input.argv, canonical.argv)
  ) {
    throw new TypeError("The MCP client process plan is not canonical.");
  }
  return canonical;
}

function normalizeRunnerRequest(input) {
  assertPlainObjectWithExactKeys(
    input,
    RUNNER_REQUEST_KEYS,
    "MCP client process request",
  );
  const executable = normalizeAbsolutePath(
    input.executable,
    "MCP client executable",
  );
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new TypeError("MCP client argv must be a non-empty array.");
  }
  if (input.argv.length > MAX_ARGUMENT_COUNT) {
    throw new TypeError(
      `MCP client argv must not exceed ${MAX_ARGUMENT_COUNT} entries.`,
    );
  }
  const argv = input.argv.map((argument) =>
    normalizeBoundedString(
      argument,
      "MCP client argument",
      MAX_ARGUMENT_LENGTH,
    ),
  );

  return Object.freeze({
    executable,
    argv: Object.freeze(argv),
    timeoutMs: normalizeTimeout(input.timeoutMs),
    maxOutputBytes: normalizeOutputLimit(input.maxOutputBytes),
  });
}

function normalizeRunnerResult(input, maxOutputBytes) {
  if (
    !isPlainObject(input) ||
    !Number.isInteger(input.exitCode) ||
    typeof input.timedOut !== "boolean" ||
    typeof input.stdout !== "string" ||
    typeof input.stderr !== "string" ||
    (input.stdoutTruncated !== undefined &&
      typeof input.stdoutTruncated !== "boolean") ||
    (input.stderrTruncated !== undefined &&
      typeof input.stderrTruncated !== "boolean")
  ) {
    return null;
  }

  const stdout = boundText(input.stdout, maxOutputBytes);
  const stderr = boundText(input.stderr, maxOutputBytes);
  return Object.freeze({
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: input.stdoutTruncated === true || stdout.truncated,
    stderrTruncated: input.stderrTruncated === true || stderr.truncated,
  });
}

function createProcessResult(outcome, processResult = null, status = null) {
  const errorCode = {
    success: null,
    "process-error": "CLIENT_PROCESS_ERROR",
    "nonzero-exit": "CLIENT_PROCESS_NONZERO_EXIT",
    timeout: "CLIENT_PROCESS_TIMEOUT",
    "output-truncated": "CLIENT_PROCESS_OUTPUT_TRUNCATED",
    "classification-error": "CLIENT_PROCESS_CLASSIFICATION_ERROR",
  }[outcome];

  return Object.freeze({
    outcome,
    errorCode,
    exitCode: processResult?.exitCode ?? null,
    timedOut: outcome === "timeout",
    stdoutTruncated: processResult?.stdoutTruncated ?? false,
    stderrTruncated: processResult?.stderrTruncated ?? false,
    registrationStatus: status,
  });
}

function readRegistrationStatus(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "status") ||
    !REGISTRATION_STATUSES.has(input.status)
  ) {
    return null;
  }
  return input.status;
}

async function readBoundedPipe(pipe, maxOutputBytes) {
  if (!pipe || typeof pipe.read !== "function") {
    throw new Error("Gecko returned an invalid process pipe.");
  }

  const retained = [];
  let retainedBytes = 0;
  let truncated = false;
  while (true) {
    const buffer = await pipe.read();
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error("Gecko returned invalid process output.");
    }
    if (buffer.byteLength === 0) break;

    const remaining = maxOutputBytes - retainedBytes;
    if (remaining > 0) {
      const take = Math.min(remaining, buffer.byteLength);
      retained.push(new Uint8Array(buffer.slice(0, take)));
      retainedBytes += take;
      if (take < buffer.byteLength) truncated = true;
    } else {
      truncated = true;
    }
  }

  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of retained) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({
    text: new globalThis.TextDecoder().decode(bytes),
    truncated,
  });
}

function boundText(value, maxOutputBytes) {
  const encoded = new globalThis.TextEncoder().encode(value);
  if (encoded.byteLength <= maxOutputBytes) {
    return Object.freeze({ text: value, truncated: false });
  }
  return Object.freeze({
    text: new globalThis.TextDecoder().decode(encoded.slice(0, maxOutputBytes)),
    truncated: true,
  });
}

function normalizeTimeout(value) {
  const timeout = value ?? MCP_CLIENT_PROCESS_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_TIMEOUT_MS ||
    timeout > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `MCP client process timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeout;
}

function normalizeOutputLimit(value) {
  const limit = value ?? MCP_CLIENT_PROCESS_DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_OUTPUT_LIMIT_BYTES
  ) {
    throw new TypeError(
      `MCP client output limit must be between 1 and ${MAX_OUTPUT_LIMIT_BYTES} bytes.`,
    );
  }
  return limit;
}

function normalizeAbsolutePath(value, field) {
  const path = normalizeBoundedString(value, field, MAX_PATH_LENGTH);
  if (
    !(
      (path.startsWith("/") && !path.startsWith("//")) ||
      /^[A-Za-z]:[\\/]/u.test(path)
    )
  ) {
    throw new TypeError(`${field} must be an absolute local path.`);
  }
  return path;
}

function normalizeBoundedString(value, field, maxLength) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new TypeError(`${field} must not exceed ${maxLength} characters.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${field} must not contain control characters.`);
    }
  }
  return value;
}

function stringArraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertPlainObjectWithAllowedKeys(input, allowedKeys, name) {
  if (!isPlainObject(input)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${name} does not accept the field ${key}.`);
    }
  }
}

function assertPlainObjectWithExactKeys(input, allowedKeys, name) {
  assertPlainObjectWithAllowedKeys(input, allowedKeys, name);
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw new TypeError(`${name} requires the field ${key}.`);
    }
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
