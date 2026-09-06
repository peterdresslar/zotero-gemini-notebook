import { bridgeJobStore } from "./bridgeJobStore.js";
import { normalizeCreateBridgeJobInput } from "./bridgeJobInput.js";
import {
  BridgeJobCreationError,
  MAX_AGENT_CANDIDATE_ITEMS,
  MAX_AGENT_COLLECTIONS_SCANNED,
  getAgentJobExpiresAt,
  prepareAgentStagedItems,
} from "./bridgeJobPolicy.js";
import { toSizedStagedItem } from "./items";
import type { CreateBridgeJobInput } from "../types";
import type { BridgeJobJson, BridgeJobSnapshot } from "./bridgeJobStore.js";
import type { ChromeJobEvent } from "./chromeJobEventProtocol.js";
import {
  ChromeJobEventConflictError,
  reportChromeJobEventToStore,
} from "./chromeJobEventState.js";

interface ResolvedItems {
  items: Zotero.Item[];
  skippedCount: number;
}

export { ChromeJobEventConflictError } from "./chromeJobEventState.js";

export async function createJob(
  input: CreateBridgeJobInput,
): Promise<BridgeJobSnapshot> {
  const request = normalizeCreateBridgeJobInput(input);

  let source: BridgeJobJson;
  let resolveItems: () => Promise<ResolvedItems>;
  if ("itemKeys" in request) {
    const itemKeys = [...request.itemKeys];
    source = {
      type: "items",
      libraryID: request.libraryID,
      itemKeys,
    };
    resolveItems = () => resolveItemKeys(request.libraryID, itemKeys);
  } else {
    source = {
      type: "collection",
      libraryID: request.libraryID,
      collectionKey: request.collectionKey,
      recursive: request.recursive,
    };
    resolveItems = () =>
      resolveCollection(
        request.libraryID,
        request.collectionKey,
        request.recursive,
      );
  }

  const requestId = request.requestId;
  if (requestId !== undefined) {
    const existing = bridgeJobStore.getIdempotentJob(requestId, {
      origin: "agent",
      source,
      destination: request.destination,
      studioPrompt: request.studioPrompt,
    });
    if (existing) return existing;
  }

  if (!Zotero.Libraries.exists(request.libraryID)) {
    throw new BridgeJobCreationError(
      "LIBRARY_NOT_FOUND",
      "The requested Zotero library was not found.",
    );
  }

  const resolved = await resolveItems();
  const prepared = await prepareAgentStagedItems(
    resolved.items,
    toSizedStagedItem,
  );
  const stagedItems = [...prepared.stagedItems];
  const skippedCount = resolved.skippedCount + prepared.skippedCount;

  if (stagedItems.length === 0) {
    throw new BridgeJobCreationError(
      "NO_SUPPORTED_ATTACHMENTS",
      "No supported local attachments were found for the requested Zotero items.",
    );
  }

  return bridgeJobStore.activate({
    items: stagedItems,
    origin: "agent",
    source,
    destination: request.destination,
    studioPrompt: request.studioPrompt,
    skippedCount,
    requestId,
    replaceExisting: request.replace,
    expiresAt: getAgentJobExpiresAt(),
  });
}

export function getJob(jobId: string): BridgeJobSnapshot | null {
  assertJobId(jobId);
  return bridgeJobStore.getJob(jobId);
}

export function getActiveJob(): BridgeJobSnapshot | null {
  return bridgeJobStore.getActiveJob();
}

export function cancelJob(jobId: string): BridgeJobSnapshot {
  assertJobId(jobId);
  return bridgeJobStore.cancel(jobId);
}

export function reportChromeJobEvent(
  jobId: string,
  claimId: string,
  event: ChromeJobEvent,
): BridgeJobSnapshot {
  return reportChromeJobEventToStore(bridgeJobStore, jobId, claimId, event);
}

export const bridgeApi = Object.freeze({
  createJob,
  getJob,
  getActiveJob,
  cancelJob,
});

async function resolveItemKeys(
  libraryID: number,
  itemKeys: string[],
): Promise<ResolvedItems> {
  if (itemKeys.length > MAX_AGENT_CANDIDATE_ITEMS) {
    throw new BridgeJobCreationError(
      "SOURCE_LIMIT_EXCEEDED",
      "The requested Zotero item selection exceeds the candidate limit.",
    );
  }

  const items: Zotero.Item[] = [];
  let skippedCount = 0;

  for (const key of itemKeys) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (!item || item.deleted || !item.isRegularItem()) {
      skippedCount += 1;
      continue;
    }
    items.push(item);
  }

  return { items, skippedCount };
}

async function resolveCollection(
  libraryID: number,
  collectionKey: string,
  recursive: boolean,
): Promise<ResolvedItems> {
  const root = await Zotero.Collections.getByLibraryAndKeyAsync(
    libraryID,
    collectionKey,
  );
  if (!root || root.deleted) {
    throw new BridgeJobCreationError(
      "COLLECTION_NOT_FOUND",
      "The requested Zotero collection was not found.",
    );
  }

  const collections = [root];
  const seenCollectionIds = new Set<number>();
  const itemsById = new Map<number, Zotero.Item>();

  while (collections.length > 0) {
    const collection = collections.shift()!;
    if (seenCollectionIds.has(collection.id)) continue;
    if (seenCollectionIds.size >= MAX_AGENT_COLLECTIONS_SCANNED) {
      throw new BridgeJobCreationError(
        "SOURCE_LIMIT_EXCEEDED",
        "The requested Zotero collection tree exceeds the scan limit.",
      );
    }
    seenCollectionIds.add(collection.id);

    for (const item of collection.getChildItems()) {
      if (item.isRegularItem() && !item.deleted) {
        if (
          !itemsById.has(item.id) &&
          itemsById.size >= MAX_AGENT_CANDIDATE_ITEMS
        ) {
          throw new BridgeJobCreationError(
            "SOURCE_LIMIT_EXCEEDED",
            "The requested Zotero collection exceeds the candidate limit.",
          );
        }
        itemsById.set(item.id, item);
      }
    }

    if (recursive) {
      collections.push(
        ...collection.getChildCollections().filter((child) => !child.deleted),
      );
    }
  }

  const items = Array.from(itemsById.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  return { items, skippedCount: 0 };
}

function assertNonemptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function assertJobId(jobId: string): void {
  assertNonemptyString(jobId, "jobId");
}
