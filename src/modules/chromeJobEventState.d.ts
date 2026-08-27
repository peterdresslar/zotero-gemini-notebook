import type { BridgeJobSnapshot, BridgeJobStore } from "./bridgeJobStore.js";
import type { ChromeJobEvent } from "./chromeJobEventProtocol.js";

export class ChromeJobEventConflictError extends Error {
  readonly code: "CHROME_JOB_EVENT_CONFLICT";
}

export function reportChromeJobEventToStore(
  store: BridgeJobStore,
  jobId: string,
  claimId: string,
  event: ChromeJobEvent,
): BridgeJobSnapshot;
