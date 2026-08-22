const JOB_STATES = new Set([
  "staged",
  "claimed",
  "submitted",
  "verifying",
  "verified",
  "unverified",
  "failed",
  "cancelled",
  "expired",
  "superseded",
]);

const TERMINAL_STATES = new Set([
  "verified",
  "unverified",
  "failed",
  "cancelled",
  "expired",
  "superseded",
]);

const FILE_ACCESS_STATES = new Set([
  "staged",
  "claimed",
  "submitted",
  "verifying",
]);

const ALLOWED_TRANSITIONS = new Map([
  [
    "staged",
    new Set(["claimed", "failed", "cancelled", "expired", "superseded"]),
  ],
  ["claimed", new Set(["submitted", "failed", "cancelled", "expired"])],
  [
    "submitted",
    new Set([
      "verifying",
      "verified",
      "unverified",
      "failed",
      "cancelled",
      "expired",
    ]),
  ],
  [
    "verifying",
    new Set(["verified", "unverified", "failed", "cancelled", "expired"]),
  ],
]);

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_CLAIMED_TTL_MS = 60 * 60 * 1000;
const PRIVATE_METADATA_KEYS = new Set(["filepath", "items"]);
const UNSAFE_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class BridgeJobStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeJobStoreError";
    this.code = code;
  }
}

export function createBridgeJobStore(options = {}) {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? createOpaqueId;
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  const claimedTtlMs = options.claimedTtlMs ?? DEFAULT_CLAIMED_TTL_MS;

  if (typeof now !== "function") {
    throw invalidInput("now must be a function");
  }
  if (typeof createId !== "function") {
    throw invalidInput("createId must be a function");
  }
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) {
    throw invalidInput("maxHistory must be a positive integer");
  }
  if (!Number.isSafeInteger(claimedTtlMs) || claimedTtlMs < 1) {
    throw invalidInput("claimedTtlMs must be a positive integer");
  }

  const jobs = new Map();
  const requestIds = new Map();
  let pendingJobId = null;

  function activate(input) {
    const activation = normalizeActivation(input);
    const timestamp = readNow(now);
    if (activation.expiresAt !== null && activation.expiresAt <= timestamp) {
      throw invalidInput("expiresAt must be later than the activation time");
    }

    expireJobs(timestamp);

    if (activation.requestId !== undefined) {
      const existing = findIdempotentRecord(
        activation.requestId,
        activation.requestFingerprint,
      );
      if (existing) return snapshot(existing);
    }

    const pending = getPendingRecord();
    if (pending && !activation.replaceExisting) {
      throw new BridgeJobStoreError(
        "PENDING_JOB_EXISTS",
        `A staged bridge job is already pending (${pending.jobId})`,
      );
    }

    const jobId = readJobId(createId, jobs);
    const job = {
      jobId,
      state: "staged",
      origin: activation.origin,
      source: activation.source,
      destination: activation.destination,
      items: activation.items,
      itemCount: activation.items.length,
      skippedCount: activation.skippedCount,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: activation.expiresAt,
      requestId: activation.requestId,
      requestFingerprint: activation.requestFingerprint,
    };

    if (pending) {
      transitionRecord(pending, "superseded", timestamp, {
        replacementJobId: jobId,
      });
    }

    jobs.set(jobId, job);
    pendingJobId = jobId;
    if (activation.requestId !== undefined) {
      requestIds.set(activation.requestId, jobId);
    }
    pruneHistory();
    return snapshot(job);
  }

  function getIdempotentJob(requestId, identity) {
    const normalizedRequestId = normalizeRequestId(requestId);
    const requestFingerprint = fingerprintRequestIdentity(identity);
    expireJobs(readNow(now));
    const existing = findIdempotentRecord(
      normalizedRequestId,
      requestFingerprint,
    );
    return existing ? snapshot(existing) : null;
  }

  function getJob(jobId) {
    if (!isNonemptyString(jobId)) return null;
    expireJobs(readNow(now));
    const job = jobs.get(jobId);
    return job ? snapshot(job) : null;
  }

  function getActiveJob() {
    expireJobs(readNow(now));
    const pending = getPendingRecord();
    return pending ? snapshot(pending) : null;
  }

  function getPendingItems() {
    expireJobs(readNow(now));
    const pending = getPendingRecord();
    return pending ? cloneItems(pending.items) : [];
  }

  function getStagedTimestamp() {
    expireJobs(readNow(now));
    return getPendingRecord()?.createdAt ?? null;
  }

  function getStagedCount() {
    expireJobs(readNow(now));
    return getPendingRecord()?.itemCount ?? 0;
  }

  function isReady() {
    expireJobs(readNow(now));
    return getPendingRecord() !== null;
  }

  function hasPendingAttachment(attachmentId, expectedJobId) {
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) return false;
    expireJobs(readNow(now));

    let job;
    if (expectedJobId === undefined) {
      job = getPendingRecord();
    } else {
      if (!isNonemptyString(expectedJobId)) return false;
      job = jobs.get(expectedJobId) ?? null;
    }

    if (!job || !FILE_ACCESS_STATES.has(job.state)) return false;
    return job.items.some((item) => item.attachmentId === attachmentId);
  }

  function claimActive(expectedJobId, selectedAttachmentIds) {
    expireJobs(readNow(now));
    const pending = getPendingRecord();
    if (expectedJobId !== undefined && !isNonemptyString(expectedJobId)) {
      return null;
    }

    if (
      !pending ||
      (expectedJobId !== undefined && expectedJobId !== pending.jobId)
    ) {
      if (expectedJobId === undefined) return null;
      const retained = jobs.get(expectedJobId);
      if (!retained || !FILE_ACCESS_STATES.has(retained.state)) return null;
      if (selectedAttachmentIds !== undefined) {
        const selected = selectItems(retained.items, selectedAttachmentIds);
        if (selected.length !== retained.items.length) return null;
      }
      return snapshot(retained);
    }

    if (selectedAttachmentIds !== undefined) {
      pending.items = selectItems(pending.items, selectedAttachmentIds);
      pending.itemCount = pending.items.length;
    }

    return transitionJob(pending.jobId, "claimed");
  }

  function transition(jobId, state, details) {
    if (!isNonemptyString(jobId)) {
      throw invalidInput("jobId must be a nonempty string");
    }
    if (!JOB_STATES.has(state)) {
      throw invalidInput(`Unsupported bridge job state: ${String(state)}`);
    }
    const safeDetails =
      details === undefined ? undefined : sanitizeJson(details, "details");

    expireJobs(readNow(now));
    return transitionJob(jobId, state, safeDetails);
  }

  function cancel(jobId, details) {
    return transition(jobId, "cancelled", details);
  }

  function reset() {
    jobs.clear();
    requestIds.clear();
    pendingJobId = null;
  }

  function findIdempotentRecord(requestId, requestFingerprint) {
    const existingId = requestIds.get(requestId);
    const existing = existingId === undefined ? null : jobs.get(existingId);
    if (!existing) {
      if (existingId !== undefined) requestIds.delete(requestId);
      return null;
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new BridgeJobStoreError(
        "IDEMPOTENCY_CONFLICT",
        "requestId was already used with different bridge job input",
      );
    }
    return existing;
  }

  function transitionJob(jobId, state, details) {
    const job = jobs.get(jobId);
    if (!job) {
      throw new BridgeJobStoreError(
        "JOB_NOT_FOUND",
        `Bridge job was not found: ${jobId}`,
      );
    }

    if (job.state === state && TERMINAL_STATES.has(state)) {
      return snapshot(job);
    }

    const allowed = ALLOWED_TRANSITIONS.get(job.state);
    if (!allowed?.has(state)) {
      throw new BridgeJobStoreError(
        "INVALID_TRANSITION",
        `Bridge job cannot transition from ${job.state} to ${state}`,
      );
    }

    const timestamp = readNow(now);
    if (state === "claimed") {
      const claimedExpiry = timestamp + claimedTtlMs;
      job.expiresAt =
        job.expiresAt === null
          ? claimedExpiry
          : Math.min(job.expiresAt, claimedExpiry);
    }
    transitionRecord(job, state, timestamp, details);
    pruneHistory();
    return snapshot(job);
  }

  function transitionRecord(job, state, timestamp, details) {
    job.state = state;
    job.updatedAt = timestamp;
    if (details === undefined) {
      delete job.details;
    } else {
      job.details = sanitizeJson(details, "details");
    }

    if (pendingJobId === job.jobId && state !== "staged") {
      pendingJobId = null;
    }
    if (TERMINAL_STATES.has(state)) {
      job.items = [];
    }
  }

  function expireJobs(timestamp) {
    for (const job of jobs.values()) {
      if (
        !TERMINAL_STATES.has(job.state) &&
        job.expiresAt !== null &&
        job.expiresAt <= timestamp
      ) {
        transitionRecord(job, "expired", timestamp, {
          reason: "Bridge job expired before completion",
        });
      }
    }
    pruneHistory();
  }

  function getPendingRecord() {
    if (pendingJobId === null) return null;
    const job = jobs.get(pendingJobId);
    if (!job || job.state !== "staged") {
      pendingJobId = null;
      return null;
    }
    return job;
  }

  function pruneHistory() {
    const terminalJobs = Array.from(jobs.values()).filter((job) =>
      TERMINAL_STATES.has(job.state),
    );
    const excess = terminalJobs.length - maxHistory;
    for (let index = 0; index < excess; index += 1) {
      const job = terminalJobs[index];
      jobs.delete(job.jobId);
      if (job.requestId !== undefined) requestIds.delete(job.requestId);
    }
  }

  return Object.freeze({
    activate,
    getIdempotentJob,
    getJob,
    getActiveJob,
    getPendingItems,
    getStagedTimestamp,
    getStagedCount,
    isReady,
    hasPendingAttachment,
    claimActive,
    transition,
    cancel,
    reset,
  });
}

function normalizeActivation(input) {
  if (!isPlainObject(input)) {
    throw invalidInput("Bridge job activation must be an object");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw invalidInput("Bridge job activation requires at least one item");
  }

  const items = input.items.map((item, index) => normalizeItem(item, index));
  const itemIds = new Set(items.map((item) => item.itemId));
  const attachmentIds = new Set(items.map((item) => item.attachmentId));
  if (itemIds.size !== items.length) {
    throw invalidInput("Bridge job items must have unique itemId values");
  }
  if (attachmentIds.size !== items.length) {
    throw invalidInput("Bridge job items must have unique attachmentId values");
  }
  if (!isNonemptyString(input.origin)) {
    throw invalidInput("origin must be a nonempty string");
  }
  if (!Number.isSafeInteger(input.skippedCount) || input.skippedCount < 0) {
    throw invalidInput("skippedCount must be a nonnegative integer");
  }
  const requestId =
    input.requestId === undefined
      ? undefined
      : normalizeRequestId(input.requestId);
  if (
    input.replaceExisting !== undefined &&
    typeof input.replaceExisting !== "boolean"
  ) {
    throw invalidInput("replaceExisting must be a boolean when provided");
  }
  if (
    input.expiresAt !== undefined &&
    input.expiresAt !== null &&
    (!Number.isFinite(input.expiresAt) || input.expiresAt < 0)
  ) {
    throw invalidInput("expiresAt must be a nonnegative finite number or null");
  }

  const normalized = {
    items,
    origin: input.origin.trim(),
    source: sanitizeJson(input.source, "source"),
    destination: sanitizeJson(input.destination, "destination"),
    skippedCount: input.skippedCount,
    requestId,
    replaceExisting: input.replaceExisting ?? false,
    expiresAt: input.expiresAt ?? null,
  };
  return {
    ...normalized,
    requestFingerprint: fingerprintRequestIdentity({
      origin: normalized.origin,
      source: normalized.source,
      destination: normalized.destination,
    }),
  };
}

function fingerprintRequestIdentity(identity) {
  if (!isPlainObject(identity)) {
    throw invalidInput("Bridge job request identity must be an object");
  }
  if (!isNonemptyString(identity.origin)) {
    throw invalidInput("request identity origin must be a nonempty string");
  }
  return canonicalStringify({
    origin: identity.origin.trim(),
    source: sanitizeJson(identity.source, "request identity source"),
    destination: sanitizeJson(
      identity.destination,
      "request identity destination",
    ),
  });
}

function normalizeRequestId(value) {
  if (!isNonemptyString(value)) {
    throw invalidInput("requestId must be a nonempty string when provided");
  }
  const requestId = value.trim();
  if (requestId.length > 128) {
    throw invalidInput("requestId must not exceed 128 characters");
  }
  return requestId;
}

function normalizeItem(item, index) {
  if (!isPlainObject(item)) {
    throw invalidInput(`items[${index}] must be an object`);
  }
  for (const key of ["itemId", "attachmentId"]) {
    if (!Number.isSafeInteger(item[key]) || item[key] < 1) {
      throw invalidInput(`items[${index}].${key} must be a positive integer`);
    }
  }
  for (const key of ["title", "creators", "year", "contentType", "fileName"]) {
    if (typeof item[key] !== "string") {
      throw invalidInput(`items[${index}].${key} must be a string`);
    }
  }
  if (!item.fileName) {
    throw invalidInput(`items[${index}] must include a fileName`);
  }

  return {
    itemId: item.itemId,
    title: item.title,
    creators: item.creators,
    year: item.year,
    attachmentId: item.attachmentId,
    contentType: item.contentType,
    fileName: item.fileName,
  };
}

function selectItems(items, selectedAttachmentIds) {
  if (
    !Array.isArray(selectedAttachmentIds) ||
    selectedAttachmentIds.length === 0
  ) {
    throw invalidInput("selectedAttachmentIds must be a nonempty array");
  }
  const selected = new Set();
  for (const attachmentId of selectedAttachmentIds) {
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      throw invalidInput(
        "selectedAttachmentIds must contain positive integers",
      );
    }
    if (selected.has(attachmentId)) {
      throw invalidInput("selectedAttachmentIds must not contain duplicates");
    }
    selected.add(attachmentId);
  }

  const itemsByAttachmentId = new Map(
    items.map((item) => [item.attachmentId, item]),
  );
  return selectedAttachmentIds.map((attachmentId) => {
    const item = itemsByAttachmentId.get(attachmentId);
    if (!item) {
      throw invalidInput(
        "selectedAttachmentIds must be within the staged attachment allowlist",
      );
    }
    return item;
  });
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeJson(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw invalidInput(`${label} must contain only JSON-compatible values`);
  }
  if (ancestors.has(value)) {
    throw invalidInput(`${label} must not contain circular references`);
  }

  ancestors.add(value);
  let safeValue;
  if (Array.isArray(value)) {
    safeValue = value.map((entry, index) =>
      sanitizeJson(entry, `${label}[${index}]`, ancestors),
    );
  } else {
    if (!isPlainObject(value)) {
      ancestors.delete(value);
      throw invalidInput(`${label} must contain only plain JSON objects`);
    }
    safeValue = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        PRIVATE_METADATA_KEYS.has(key.toLowerCase()) ||
        UNSAFE_METADATA_KEYS.has(key)
      ) {
        continue;
      }
      safeValue[key] = sanitizeJson(entry, `${label}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return safeValue;
}

function snapshot(job) {
  const result = {
    jobId: job.jobId,
    state: job.state,
    origin: job.origin,
    source: sanitizeJson(job.source, "source"),
    destination: sanitizeJson(job.destination, "destination"),
    itemCount: job.itemCount,
    skippedCount: job.skippedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
  if (job.details !== undefined) {
    result.details = sanitizeJson(job.details, "details");
  }
  return result;
}

function cloneItems(items) {
  return items.map((item) => ({ ...item }));
}

function readNow(now) {
  const timestamp = now();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw invalidInput("now must return a nonnegative finite number");
  }
  return timestamp;
}

function readJobId(createId, jobs) {
  const jobId = createId();
  if (!isNonemptyString(jobId)) {
    throw invalidInput("createId must return a nonempty string");
  }
  if (jobs.has(jobId)) {
    throw invalidInput("createId returned a duplicate bridge job ID");
  }
  return jobId;
}

function createOpaqueId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  throw new BridgeJobStoreError(
    "SECURE_RANDOM_UNAVAILABLE",
    "Secure randomness is unavailable for bridge job IDs",
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidInput(message) {
  return new BridgeJobStoreError("INVALID_INPUT", message);
}

export const bridgeJobStore = createBridgeJobStore();

export default bridgeJobStore;
