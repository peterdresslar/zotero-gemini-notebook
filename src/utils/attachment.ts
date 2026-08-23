import { getSafeFileName } from "./fileName.js";

export const SUPPORTED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
]);

export interface ValidAttachment {
  attachmentId: number;
  contentType: string;
  fileName: string;
  filePath: string;
}

export async function getValidAttachment(
  item: Zotero.Item,
): Promise<ValidAttachment | null> {
  const attachmentIds = item.getAttachments();
  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId);
    if (!attachment) continue;

    const contentType = attachment.attachmentContentType;
    if (!contentType || !SUPPORTED_CONTENT_TYPES.has(contentType)) continue;

    const filePath = await attachment.getFilePathAsync();
    if (!filePath) continue;

    const fileName = getSafeFileName(attachment.attachmentFilename, filePath);

    return {
      attachmentId,
      contentType,
      fileName,
      filePath,
    };
  }
  return null;
}
