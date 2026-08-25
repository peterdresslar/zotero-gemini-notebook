export const JOB_LIFECYCLE_ACTION = "reportJobLifecycle";
export const JOB_CLAIM_ACTION = "claimZoteroJob";
export const JOB_LIFECYCLE_ENDPOINT =
  "http://127.0.0.1:23119/notebooklm/job-event";
export const JOB_CLAIM_ENDPOINT = "http://127.0.0.1:23119/notebooklm/job-claim";
export const JOB_LIFECYCLE_CONTENT_TYPE =
  "application/vnd.zotero-gemini-notebook.job-event+json";
export const JOB_CLAIM_CONTENT_TYPE =
  "application/vnd.zotero-gemini-notebook.job-claim+json";
export const JOB_CONTROL_RESPONSE_MAX_BYTES = 1024;
export const JOB_CLAIM_MAX_BODY_BYTES = 4096;
export const JOB_CONTROL_TIMEOUT_MS = 5000;
export const JOB_CONTROL_MAX_ATTEMPTS = 2;
export const JOB_LIFECYCLE_REPORT_WARNING =
  "Gemini Notebook received the files, but Zotero could not update the import status.";

const JOB_LIFECYCLE_EVENTS = new Set(["submitted", "unverified", "failed"]);
const JOB_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const GEMINI_NOTEBOOK_HOSTS = new Set([
  "notebook.google.com",
  "notebooklm.google.com",
]);
const SUCCESS_BODY = '{"accepted":true}';
const MAX_CLAIM_ATTACHMENTS = 50;

export class JobLifecycleProtocolError extends Error {
  constructor(
    message,
    { category = "invalid_request", retryable = false } = {},
  ) {
    super(message);
    this.name = "JobLifecycleProtocolError";
    this.category = category;
    this.retryable = retryable;
  }
}

export function createJobLifecycleBody(jobId, claimId, event) {
  assertJobId(jobId);
  assertClaimId(claimId);
  if (!JOB_LIFECYCLE_EVENTS.has(event)) {
    throw new JobLifecycleProtocolError("Job lifecycle event is invalid");
  }

  // Property insertion order is the canonical wire order agreed with Zotero.
  return JSON.stringify({ claimId, event, jobId });
}

export function createJobClaimBody(jobId, claimId, attachmentIds) {
  assertJobId(jobId);
  assertClaimId(claimId);
  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.length < 1 ||
    attachmentIds.length > MAX_CLAIM_ATTACHMENTS
  ) {
    throw new JobLifecycleProtocolError("Claim attachment IDs are invalid");
  }
  const normalizedIds = attachmentIds.map((attachmentId) => {
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      throw new JobLifecycleProtocolError("Claim attachment IDs are invalid");
    }
    return attachmentId;
  });
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new JobLifecycleProtocolError("Claim attachment IDs are invalid");
  }
  normalizedIds.sort((left, right) => left - right);

  const body = JSON.stringify({ attachmentIds: normalizedIds, claimId, jobId });
  if (
    new globalThis.TextEncoder().encode(body).byteLength >
    JOB_CLAIM_MAX_BODY_BYTES
  ) {
    throw new JobLifecycleProtocolError("Claim body is too large");
  }
  return body;
}

export function readJobLifecycleMessage(message) {
  if (!isPlainObject(message)) {
    throw new JobLifecycleProtocolError("Lifecycle message is invalid");
  }
  const keys = Object.keys(message).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "action" ||
    keys[1] !== "claimId" ||
    keys[2] !== "event" ||
    keys[3] !== "jobId" ||
    message.action !== JOB_LIFECYCLE_ACTION
  ) {
    throw new JobLifecycleProtocolError("Lifecycle message is invalid");
  }
  createJobLifecycleBody(message.jobId, message.claimId, message.event);
  return Object.freeze({
    claimId: message.claimId,
    event: message.event,
    jobId: message.jobId,
  });
}

export function readJobClaimMessage(message) {
  if (!isPlainObject(message)) {
    throw new JobLifecycleProtocolError("Claim message is invalid");
  }
  const keys = Object.keys(message).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "action" ||
    keys[1] !== "attachmentIds" ||
    keys[2] !== "claimId" ||
    keys[3] !== "jobId" ||
    message.action !== JOB_CLAIM_ACTION
  ) {
    throw new JobLifecycleProtocolError("Claim message is invalid");
  }
  createJobClaimBody(message.jobId, message.claimId, message.attachmentIds);
  return Object.freeze({
    attachmentIds: [...message.attachmentIds],
    claimId: message.claimId,
    jobId: message.jobId,
  });
}

export function isAllowedJobLifecycleSender({ sender, extensionId }) {
  if (
    !sender ||
    typeof sender !== "object" ||
    typeof extensionId !== "string" ||
    sender.id !== extensionId
  ) {
    return false;
  }

  if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  return isGeminiNotebookUrl(sender.url ?? sender.tab.url);
}

export function isAllowedJobClaimSender({ sender, extensionId }) {
  return isAllowedJobLifecycleSender({ sender, extensionId });
}

export async function postJobLifecycleEvent({
  fetchImpl,
  jobId,
  claimId,
  event,
}) {
  const body = createJobLifecycleBody(jobId, claimId, event);
  return postFixedJobControlRequestWithRetry({
    fetchImpl,
    endpoint: JOB_LIFECYCLE_ENDPOINT,
    contentType: JOB_LIFECYCLE_CONTENT_TYPE,
    body,
    expectedResponseBody: SUCCESS_BODY,
  });
}

export async function postJobClaim({
  fetchImpl,
  jobId,
  claimId,
  attachmentIds,
}) {
  const body = createJobClaimBody(jobId, claimId, attachmentIds);
  return postFixedJobControlRequestWithRetry({
    fetchImpl,
    endpoint: JOB_CLAIM_ENDPOINT,
    contentType: JOB_CLAIM_CONTENT_TYPE,
    body,
    expectedResponseBody: JSON.stringify({
      claimId,
      jobId,
      state: "claimed",
    }),
  });
}

async function postFixedJobControlRequestWithRetry(options) {
  let lastError;
  for (let attempt = 1; attempt <= JOB_CONTROL_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await postFixedJobControlRequest(options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof JobLifecycleProtocolError) || !error.retryable) {
        throw error;
      }
      if (attempt < JOB_CONTROL_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  throw lastError;
}

async function postFixedJobControlRequest({
  fetchImpl,
  endpoint,
  contentType,
  body,
  expectedResponseBody,
}) {
  if (typeof fetchImpl !== "function") {
    throw new JobLifecycleProtocolError("Fetch implementation is unavailable");
  }
  const abortController = new globalThis.AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    JOB_CONTROL_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "zotero-allowed-request": "1",
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: abortController.signal,
    });

    if (
      !response ||
      typeof response !== "object" ||
      response.redirected ||
      response.url !== endpoint
    ) {
      throw invalidResponse("Job response is invalid");
    }
    let responseBody;
    try {
      responseBody = await readBoundedResponseText(
        response,
        JOB_CONTROL_RESPONSE_MAX_BYTES,
      );
    } catch (error) {
      if (response.status >= 500 && response.status <= 599) {
        throw new JobLifecycleProtocolError("Job endpoint is unavailable", {
          category: "temporarily_unavailable",
          retryable: true,
        });
      }
      throw error;
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new JobLifecycleProtocolError("Job endpoint is unavailable", {
        category: "temporarily_unavailable",
        retryable: true,
      });
    }
    if (!response.ok || response.status !== 200) {
      throw new JobLifecycleProtocolError("Job request was rejected", {
        category: "rejected",
        retryable: false,
      });
    }
    const responseContentType = response.headers?.get?.("content-type");
    if (
      responseContentType !== "application/json" &&
      responseContentType !== "application/json; charset=utf-8"
    ) {
      throw invalidResponse("Job response content type is invalid");
    }
    if (responseBody !== expectedResponseBody) {
      throw invalidResponse("Job response body is invalid");
    }
    return Object.freeze({ accepted: true });
  } catch (error) {
    if (error instanceof JobLifecycleProtocolError) throw error;
    throw new JobLifecycleProtocolError("Job request failed", {
      category: "temporarily_unavailable",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response, maxBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw invalidResponse("Lifecycle response length is invalid");
    }
    if (Number(declaredLength) > maxBytes) {
      throw invalidResponse("Lifecycle response is too large");
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw invalidResponse("Lifecycle response body is invalid");
        }
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw invalidResponse("Lifecycle response is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decodeAscii(bytes);
  }

  if (typeof response.text !== "function") {
    throw invalidResponse("Lifecycle response body is unavailable");
  }
  const text = await response.text();
  const bytes = new globalThis.TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) {
    throw invalidResponse("Lifecycle response is too large");
  }
  return decodeAscii(bytes);
}

function decodeAscii(bytes) {
  for (const byte of bytes) {
    if (byte > 0x7f) {
      throw invalidResponse("Lifecycle response is not canonical ASCII");
    }
  }
  return new globalThis.TextDecoder("ascii", { fatal: true }).decode(bytes);
}

function isGeminiNotebookUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      GEMINI_NOTEBOOK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobLifecycleProtocolError("Job ID is invalid");
  }
}

function assertClaimId(claimId) {
  if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) {
    throw new JobLifecycleProtocolError("Claim ID is invalid");
  }
}

function invalidResponse(message) {
  return new JobLifecycleProtocolError(message, {
    category: "invalid_response",
    retryable: false,
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
