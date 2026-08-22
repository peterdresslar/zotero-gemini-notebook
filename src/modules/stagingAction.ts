import { config } from "../../package.json";
import { toStagedItem } from "./items";
import { stageItems } from "./staging";
import type { StagedItem } from "../types";

export interface StagingActionResult {
  stagedCount: number;
  skippedCount: number;
}

export async function stageSelectedZoteroItems(
  items: Zotero.Item[],
): Promise<StagingActionResult> {
  const regularItems = items.filter((item) => item.isRegularItem());
  const stagedItems: StagedItem[] = [];

  for (const item of regularItems) {
    const stagedItem = await toStagedItem(item);
    if (stagedItem) stagedItems.push(stagedItem);
  }

  const result = {
    stagedCount: stagedItems.length,
    skippedCount: regularItems.length - stagedItems.length,
  };

  if (stagedItems.length === 0) {
    showStagingFailure();
    return result;
  }

  stageItems(stagedItems, {
    skippedCount: result.skippedCount,
    source: "context-menu",
  });
  showStagingSuccess(result.stagedCount, result.skippedCount);
  return result;
}

export function showStagingSuccess(
  stagedCount: number,
  skippedCount = 0,
): void {
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: 10000,
  }).createLine({
    text: `${stagedCount} item${stagedCount === 1 ? "" : "s"} staged. Open Gemini Notebook in Chrome, then open the Zotero → Gemini Notebook extension and click Import to Gemini Notebook.`,
    type: "success",
    progress: 100,
  });

  if (skippedCount > 0) {
    progress.createLine({
      text: `${skippedCount} selected item${skippedCount === 1 ? " was" : "s were"} skipped because no supported local attachment was found.`,
      progress: 100,
    });
  }

  progress.show();
}

export function showStagingFailure(message?: string): void {
  new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: 8000,
  })
    .createLine({
      text:
        message ??
        "No items were staged. Select regular Zotero items with a supported local PDF, DOCX, Markdown, or text attachment.",
      type: "fail",
      progress: 100,
    })
    .show();
}
