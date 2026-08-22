export const STAGED_CLEAR_METHOD = "POST";

export function createStagedFileRequest(attachmentId, jobId) {
  assertAttachmentId(attachmentId);
  const request = { attachmentId };
  if (jobId) request.jobId = assertJobId(jobId);
  return request;
}

export function createStagedClearRequest(jobId, attachmentIds) {
  if (!jobId) return null;
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    throw new TypeError("A job-bound clear requires attachment IDs");
  }
  const normalizedIds = attachmentIds.map((attachmentId) => {
    assertAttachmentId(attachmentId);
    return attachmentId;
  });
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new TypeError("Clear attachment IDs must be unique");
  }
  return {
    jobId: assertJobId(jobId),
    attachmentIds: normalizedIds,
  };
}

function assertAttachmentId(attachmentId) {
  if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
    throw new TypeError("Attachment ID must be a positive integer");
  }
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new TypeError("Job ID must be a nonempty string");
  }
  return jobId;
}
