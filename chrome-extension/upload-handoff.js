(() => {
  "use strict";

  const PROTOCOL_VERSION = 2;
  const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;
  const MAX_ATTACHMENTS = 50;
  const JOB_ID_PATTERN =
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
  const CLAIM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

  function createController(options = {}) {
    const createBatch = options.createBatch;
    const claimJob = options.claimJob;
    const startUpload = options.startUpload;
    const verifyDestination = options.verifyDestination;
    const isAuthorizedSender = options.isAuthorizedSender;
    const schedule = options.setTimeout ?? globalThis.setTimeout;
    const cancelSchedule = options.clearTimeout ?? globalThis.clearTimeout;
    const expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;

    if (
      typeof createBatch !== "function" ||
      typeof claimJob !== "function" ||
      typeof startUpload !== "function" ||
      typeof verifyDestination !== "function" ||
      typeof isAuthorizedSender !== "function" ||
      typeof schedule !== "function" ||
      typeof cancelSchedule !== "function" ||
      !Number.isSafeInteger(expiryMs) ||
      expiryMs < 1
    ) {
      throw new TypeError("Upload handoff controller options are invalid");
    }

    let pending = null;
    let pendingTimer = null;
    let held = null;
    let heldTimer = null;
    let uploadInProgress = false;

    function begin(message, sender) {
      assertAuthorizedSender(sender);
      if (uploadInProgress) {
        throw new Error("An upload is already in progress");
      }
      if (held) {
        throw new Error("An upload batch is waiting for Zotero");
      }

      // Validate and construct entirely in locals. A malformed begin must not
      // leave an unscoped batch that can later take the legacy path.
      const job = normalizeJob(message);
      const batch = createBatch(message.batchId, message.fileCount);

      clearPending();
      pending = Object.freeze({ batch, job });
      schedulePendingExpiry();
    }

    function addChunk(message, sender) {
      assertAuthorizedSender(sender);
      if (!pending) {
        throw new Error("No upload batch is ready to receive data");
      }
      pending.batch.addChunk(message);
      schedulePendingExpiry();
    }

    function abort(batchId, sender) {
      assertAuthorizedSender(sender);
      if (pending?.batch.batchId === batchId) clearPending();
      if (held?.batchId === batchId) clearHeld();
    }

    async function commit(batchId, sender) {
      assertAuthorizedSender(sender);
      if (!pending) {
        throw new Error("No upload batch is ready to commit");
      }
      if (pending.batch.batchId !== batchId) {
        throw new Error("Upload batch identifier does not match");
      }

      const files = pending.batch.finalize();
      const job = pending.job;
      clearPending();
      const claimedBatch = Object.freeze({ batchId, files, job });
      held = claimedBatch;
      scheduleHeldExpiry();

      if (job) {
        let destinationMatches;
        try {
          destinationMatches = verifyDestination(job);
        } catch {
          destinationMatches = false;
        }
        if (destinationMatches !== true) {
          if (held === claimedBatch) clearHeld();
          throw new Error(
            "Gemini Notebook changed destinations before Zotero could claim the import job",
          );
        }
        try {
          await claimJob(job);
        } catch {
          if (held === claimedBatch) clearHeld();
          throw new Error("Zotero could not claim the staged import job");
        }
        if (held !== claimedBatch) {
          throw new Error("Upload batch was cancelled before it could start");
        }
      }

      clearHeld();
      uploadInProgress = true;
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        uploadInProgress = false;
      };
      try {
        startUpload({ files, job, complete });
      } catch (error) {
        complete();
        throw error;
      }
    }

    function dispose() {
      clearPending();
      clearHeld();
    }

    function assertAuthorizedSender(sender) {
      if (!isAuthorizedSender(sender)) {
        throw new Error("Upload message sender is invalid");
      }
    }

    function schedulePendingExpiry() {
      if (pendingTimer !== null) cancelSchedule(pendingTimer);
      pendingTimer = schedule(() => {
        clearPending();
      }, expiryMs);
    }

    function scheduleHeldExpiry() {
      if (heldTimer !== null) cancelSchedule(heldTimer);
      heldTimer = schedule(() => {
        clearHeld();
      }, expiryMs);
    }

    function clearPending() {
      if (pendingTimer !== null) cancelSchedule(pendingTimer);
      pendingTimer = null;
      pending = null;
    }

    function clearHeld() {
      if (heldTimer !== null) cancelSchedule(heldTimer);
      heldTimer = null;
      held = null;
    }

    return Object.freeze({
      begin,
      addChunk,
      abort,
      commit,
      dispose,
    });
  }

  function isAllowedPopupSender({ sender, extensionId, popupUrl }) {
    return (
      sender?.id === extensionId &&
      sender.tab === undefined &&
      typeof popupUrl === "string" &&
      sender.url === popupUrl
    );
  }

  function createPingResponse() {
    return Object.freeze({
      ready: true,
      lifecycleProtocolVersion: PROTOCOL_VERSION,
    });
  }

  function normalizeJob(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError("Upload batch message is invalid");
    }
    if (!CLAIM_ID_PATTERN.test(message.batchId)) {
      throw new TypeError("Upload claim identifier is invalid");
    }
    if (
      !Number.isSafeInteger(message.fileCount) ||
      message.fileCount < 1 ||
      message.fileCount > MAX_ATTACHMENTS
    ) {
      throw new TypeError("Upload file count is invalid");
    }
    if (message.jobId === null || message.jobId === undefined) return null;
    if (
      typeof message.jobId !== "string" ||
      !JOB_ID_PATTERN.test(message.jobId)
    ) {
      throw new TypeError("Upload job identifier is invalid");
    }
    if (
      !Array.isArray(message.attachmentIds) ||
      message.attachmentIds.length !== message.fileCount ||
      message.attachmentIds.some(
        (attachmentId) =>
          !Number.isSafeInteger(attachmentId) || attachmentId < 1,
      ) ||
      new Set(message.attachmentIds).size !== message.attachmentIds.length
    ) {
      throw new TypeError("Upload attachment selection is invalid");
    }
    const destinationBinding =
      globalThis.ZoteroUploadDestination.readDestinationBinding(
        message.destination,
        message.notebookPathname,
        message.createdNewNotebook,
      );
    if (!destinationBinding) {
      throw new TypeError("Upload destination binding is invalid");
    }

    return Object.freeze({
      attachmentIds: Object.freeze([...message.attachmentIds]),
      claimId: message.batchId,
      ...destinationBinding,
      jobId: message.jobId,
    });
  }

  globalThis.ZoteroUploadHandoff = Object.freeze({
    PROTOCOL_VERSION,
    createController,
    createPingResponse,
    isAllowedPopupSender,
  });
})();
