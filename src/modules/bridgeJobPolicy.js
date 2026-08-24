export const MAX_AGENT_STAGED_SOURCES = 50;
export const MAX_AGENT_CANDIDATE_ITEMS = 256;
export const MAX_AGENT_COLLECTIONS_SCANNED = 1_000;
export const MAX_AGENT_SOURCE_BYTES = 200_000_000;
export const MAX_AGENT_TOTAL_BYTES = 200_000_000;
export const AGENT_JOB_TTL_MS = 60 * 60 * 1000;

export class BridgeJobCreationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeJobCreationError";
    this.code = code;
  }
}

export async function prepareAgentStagedItems(
  items,
  resolveStagedItem,
  limits = {},
) {
  if (!Array.isArray(items)) {
    throw invalidPolicyInput("items must be an array");
  }
  if (typeof resolveStagedItem !== "function") {
    throw invalidPolicyInput("resolveStagedItem must be a function");
  }

  const maxStagedSources = limits.maxStagedSources ?? MAX_AGENT_STAGED_SOURCES;
  const maxSourceBytes = limits.maxSourceBytes ?? MAX_AGENT_SOURCE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_AGENT_TOTAL_BYTES;
  for (const [name, value] of Object.entries({
    maxStagedSources,
    maxSourceBytes,
    maxTotalBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidPolicyInput(`${name} must be a positive safe integer`);
    }
  }

  const stagedItems = [];
  let totalBytes = 0;
  for (const item of items) {
    const resolved = await resolveStagedItem(item);
    if (resolved === null) continue;
    if (
      !resolved ||
      typeof resolved !== "object" ||
      !("stagedItem" in resolved) ||
      !Number.isSafeInteger(resolved.byteSize) ||
      resolved.byteSize < 0
    ) {
      throw new BridgeJobCreationError(
        "SOURCE_LIMIT_EXCEEDED",
        "Zotero could not determine a safe source size.",
      );
    }
    if (stagedItems.length >= maxStagedSources) {
      throw new BridgeJobCreationError(
        "SOURCE_LIMIT_EXCEEDED",
        `The requested Zotero sources exceed the ${maxStagedSources}-source limit.`,
      );
    }
    if (resolved.byteSize > maxSourceBytes) {
      throw new BridgeJobCreationError(
        "SOURCE_LIMIT_EXCEEDED",
        "A requested Zotero source exceeds the per-source size limit.",
      );
    }
    if (resolved.byteSize > maxTotalBytes - totalBytes) {
      throw new BridgeJobCreationError(
        "SOURCE_LIMIT_EXCEEDED",
        "The requested Zotero sources exceed the total size limit.",
      );
    }

    // Keep the admitted size only inside the Zotero job authority. Public
    // pending and MCP DTOs explicitly strip this field, while the file endpoint
    // uses it to cap a later read if the attachment changes after staging.
    stagedItems.push({
      ...resolved.stagedItem,
      maxByteSize: resolved.byteSize,
    });
    totalBytes += resolved.byteSize;
  }

  return Object.freeze({
    stagedItems: Object.freeze(stagedItems),
    skippedCount: items.length - stagedItems.length,
  });
}

export function getAgentJobExpiresAt(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw invalidPolicyInput("now must be a nonnegative safe integer");
  }
  const expiresAt = now + AGENT_JOB_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw invalidPolicyInput("agent job expiry exceeds the safe integer range");
  }
  return expiresAt;
}

function invalidPolicyInput(message) {
  return new BridgeJobCreationError("INVALID_POLICY_INPUT", message);
}
