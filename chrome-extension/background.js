import {
  JOB_CLAIM_ACTION,
  JOB_LIFECYCLE_ACTION,
  JobLifecycleProtocolError,
  isAllowedJobClaimSender,
  isAllowedJobLifecycleSender,
  postJobClaim,
  postJobLifecycleEvent,
  readJobClaimMessage,
  readJobLifecycleMessage,
} from "./job-lifecycle.js";

const REPORT_FAILURE = Object.freeze({
  success: false,
  error: "Zotero job status could not be updated.",
  category: "invalid_request",
  retryable: false,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.action !== JOB_CLAIM_ACTION &&
    message?.action !== JOB_LIFECYCLE_ACTION
  ) {
    return false;
  }

  void handleJobControlMessage(message, sender).then(sendResponse);
  return true;
});

async function handleJobControlMessage(message, sender) {
  try {
    if (message.action === JOB_CLAIM_ACTION) {
      if (
        !isAllowedJobClaimSender({
          sender,
          extensionId: chrome.runtime.id,
        })
      ) {
        return REPORT_FAILURE;
      }
      const { attachmentIds, claimId, jobId } = readJobClaimMessage(message);
      await postJobClaim({
        fetchImpl: fetch,
        attachmentIds,
        claimId,
        jobId,
      });
      return { success: true };
    }

    if (
      !isAllowedJobLifecycleSender({
        sender,
        extensionId: chrome.runtime.id,
      })
    ) {
      return REPORT_FAILURE;
    }
    const { claimId, event, jobId } = readJobLifecycleMessage(message);
    await postJobLifecycleEvent({
      fetchImpl: fetch,
      claimId,
      event,
      jobId,
    });
    return { success: true };
  } catch (error) {
    return {
      ...REPORT_FAILURE,
      category:
        error instanceof JobLifecycleProtocolError
          ? error.category
          : "internal_error",
      retryable:
        error instanceof JobLifecycleProtocolError && error.retryable === true,
    };
  }
}
