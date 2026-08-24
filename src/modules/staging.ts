import { bridgeJobStore } from "./bridgeJobStore.js";
import type { StagedItem } from "../types";

export interface HumanStagingOptions {
  skippedCount?: number;
  source?: string;
}

export function stageItems(
  items: StagedItem[],
  options: HumanStagingOptions = {},
): ReturnType<typeof bridgeJobStore.activate> | null {
  // Preserve the current staged job when a human action resolves to no files.
  if (items.length === 0) return null;

  return bridgeJobStore.activate({
    items,
    origin: "human",
    source: {
      type: options.source ?? "selection",
    },
    destination: "active-or-new",
    skippedCount: options.skippedCount ?? 0,
    replaceExisting: true,
  });
}

export function getStagedItems(): StagedItem[] {
  return bridgeJobStore.getPendingItems();
}

export function getStagedCount(): number {
  return bridgeJobStore.getStagedCount();
}

export function getStagedTimestamp(): number | null {
  return bridgeJobStore.getStagedTimestamp();
}

export function isReady(): boolean {
  return bridgeJobStore.isReady();
}

export function claimStagedJob(
  expectedJobId?: string,
  selectedAttachmentIds?: number[],
): ReturnType<typeof bridgeJobStore.claimActive> {
  return bridgeJobStore.claimActive(expectedJobId, selectedAttachmentIds);
}

export function getCurrentStagedJob(): ReturnType<
  typeof bridgeJobStore.getActiveJob
> {
  return bridgeJobStore.getActiveJob();
}

export function resetStaging(): void {
  bridgeJobStore.reset();
}

export function isStagedAttachment(
  attachmentId: number,
  expectedJobId?: string,
): boolean {
  return getStagedAttachmentAccess(attachmentId, expectedJobId) !== null;
}

export function getStagedAttachmentAccess(
  attachmentId: number,
  expectedJobId?: string,
): Readonly<{ maxByteSize: number | null }> | null {
  return bridgeJobStore.getAttachmentAccess(attachmentId, expectedJobId);
}
