import { BridgeJobStoreError } from "./bridgeJobStore.js";

const CHROME_JOB_EVENTS = new Set(["submitted", "unverified", "failed"]);
const CHROME_TERMINAL_DETAILS = Object.freeze({
  unverified: Object.freeze({
    code: "chrome_upload_unverified",
    message:
      "Chrome could not confirm that Gemini Notebook accepted the staged sources.",
    retryable: false,
  }),
  failed: Object.freeze({
    code: "chrome_upload_failed",
    message: "Chrome could not submit the staged sources to Gemini Notebook.",
    retryable: false,
  }),
});

export class ChromeJobEventConflictError extends Error {
  constructor() {
    super("The Chrome job event does not match a claimed bridge job.");
    this.name = "ChromeJobEventConflictError";
    this.code = "CHROME_JOB_EVENT_CONFLICT";
  }
}

export function reportChromeJobEventToStore(store, jobId, claimId, event) {
  if (!store || typeof store.reportClaimedEvent !== "function") {
    throw new TypeError("A bridge job store is required.");
  }
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new ChromeJobEventConflictError();
  }
  if (typeof claimId !== "string" || claimId.trim() === "") {
    throw new ChromeJobEventConflictError();
  }
  if (!CHROME_JOB_EVENTS.has(event)) {
    throw new ChromeJobEventConflictError();
  }

  const details =
    event === "unverified" || event === "failed"
      ? CHROME_TERMINAL_DETAILS[event]
      : undefined;
  try {
    return store.reportClaimedEvent(jobId, claimId, event, details);
  } catch (error) {
    if (error instanceof BridgeJobStoreError) {
      throw new ChromeJobEventConflictError();
    }
    throw error;
  }
}
