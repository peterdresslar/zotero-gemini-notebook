import { companionCompatibility, config, version } from "../../package.json";
import {
  getStagedItems,
  getStagedCount,
  getStagedTimestamp,
  getCurrentStagedJob,
  getStagedAttachmentAccess,
  isReady,
  claimStagedJob,
} from "./staging";
import {
  FileReadPolicyError,
  assertStagedFileReadPolicy,
  readFileAsBase64,
} from "../utils/file";
import { getSafeFileName } from "../utils/fileName.js";
import { getPref } from "../utils/prefs";
import { SUPPORTED_CONTENT_TYPES } from "../utils/attachment";
import {
  createStatusResponse,
  PRIVATE_RESPONSE_OPTIONS,
  ZOTERO_MUTATION_METHOD,
} from "./zoteroServerContract.js";
import type { StatusResponse, PendingResponse, FileResponse } from "../types";

function sendJSON(callback: Function, status: number, data: object) {
  callback(
    status,
    "application/json",
    JSON.stringify(data),
    PRIVATE_RESPONSE_OPTIONS,
  );
}

function parseRequestBody(data: unknown): Record<string, unknown> {
  const body = typeof data === "string" ? JSON.parse(data) : data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Request body must be an object");
  }
  return body as Record<string, unknown>;
}

function readOptionalJobId(body: Record<string, unknown>): string | undefined {
  if (!("jobId" in body)) return undefined;
  if (
    typeof body.jobId !== "string" ||
    body.jobId.trim() === "" ||
    body.jobId.length > 128
  ) {
    throw new TypeError("jobId must be a nonempty string");
  }
  return body.jobId.trim();
}

function readSelectedAttachmentIds(
  body: Record<string, unknown>,
): number[] | undefined {
  if (!("attachmentIds" in body)) return undefined;
  if (
    !Array.isArray(body.attachmentIds) ||
    body.attachmentIds.length === 0 ||
    body.attachmentIds.some(
      (id) => !Number.isSafeInteger(id) || (id as number) < 1,
    ) ||
    new Set(body.attachmentIds).size !== body.attachmentIds.length
  ) {
    throw new TypeError(
      "attachmentIds must be a nonempty array of unique positive integers",
    );
  }
  return body.attachmentIds as number[];
}

export function registerEndpoints() {
  // Health check
  const statusEndpoint = (Zotero.Server.Endpoints["/notebooklm/status"] =
    function () {});
  statusEndpoint.prototype = {
    supportedMethods: ["GET", "OPTIONS"],
    supportedDataTypes: ["application/json"],
    init: function (_data: any, sendResponseCallback: Function) {
      const response: StatusResponse = createStatusResponse({
        ready: isReady(),
        count: getStagedCount(),
        zoteroVersion: Zotero.version,
        pluginVersion: config.addonName + " " + version,
        mcpOptedIn: getPref("mcp.enabled") === true,
      });
      sendJSON(sendResponseCallback, 200, response);
    },
  };

  // Get staged items metadata
  const pendingEndpoint = (Zotero.Server.Endpoints["/notebooklm/pending"] =
    function () {});
  pendingEndpoint.prototype = {
    supportedMethods: ["GET", "OPTIONS"],
    supportedDataTypes: ["application/json"],
    init: function (_data: any, sendResponseCallback: Function) {
      const activeJob = getCurrentStagedJob();
      const response: PendingResponse = {
        items: getStagedItems(),
        count: getStagedCount(),
        timestamp: getStagedTimestamp(),
        compatibleChromeExtensionVersions: companionCompatibility.validVersions,
        jobId: activeJob?.jobId ?? null,
      };
      sendJSON(sendResponseCallback, 200, response);
    },
  };

  // Get file content by attachment ID (only for staged items)
  const fileEndpoint = (Zotero.Server.Endpoints["/notebooklm/file"] =
    function () {});
  fileEndpoint.prototype = {
    supportedMethods: [ZOTERO_MUTATION_METHOD, "OPTIONS"],
    supportedDataTypes: ["application/json"],
    init: async function (data: any, sendResponseCallback: Function) {
      let attachmentId: number;
      let jobId: string | undefined;
      try {
        const body = parseRequestBody(data);
        const requestedAttachmentId = body.attachmentId;
        if (
          typeof requestedAttachmentId !== "number" ||
          !Number.isSafeInteger(requestedAttachmentId) ||
          requestedAttachmentId < 1
        ) {
          throw new TypeError("attachmentId must be a positive integer");
        }
        attachmentId = requestedAttachmentId;
        jobId = readOptionalJobId(body);
      } catch {
        sendJSON(sendResponseCallback, 400, {
          error: "Invalid staged attachment request",
        });
        return;
      }

      try {
        // Security: only serve files that are currently staged
        const access = getStagedAttachmentAccess(attachmentId, jobId);
        if (!access) {
          sendJSON(sendResponseCallback, 403, {
            error: "Attachment is not staged for export",
          });
          return;
        }

        const attachment = Zotero.Items.get(attachmentId);
        if (!attachment) {
          sendJSON(sendResponseCallback, 404, {
            error: "Attachment not found",
          });
          return;
        }

        const contentType = attachment.attachmentContentType;
        if (!contentType || !SUPPORTED_CONTENT_TYPES.has(contentType)) {
          sendJSON(sendResponseCallback, 409, {
            error: "The staged attachment type changed; stage it again",
          });
          return;
        }

        const filePath = await attachment.getFilePathAsync();
        if (!filePath) {
          sendJSON(sendResponseCallback, 404, {
            error: "File not found on disk",
          });
          return;
        }

        const maxByteSize = access.maxByteSize ?? undefined;
        const fileInfo = await IOUtils.stat(filePath);
        assertStagedFileReadPolicy(fileInfo, maxByteSize);
        const base64Data = await readFileAsBase64(filePath, maxByteSize);
        const response: FileResponse = {
          data: base64Data,
          contentType,
          fileName: getSafeFileName(attachment.attachmentFilename, filePath),
        };
        sendJSON(sendResponseCallback, 200, response);
      } catch (error) {
        if (error instanceof FileReadPolicyError) {
          sendJSON(sendResponseCallback, 409, {
            error: "The staged attachment changed; stage it again",
          });
          return;
        }
        sendJSON(sendResponseCallback, 500, {
          error: "Unable to read the staged attachment",
        });
      }
    },
  };

  // Clear staged items (called by Chrome extension after successful upload)
  const clearEndpoint = (Zotero.Server.Endpoints["/notebooklm/clear"] =
    function () {});
  clearEndpoint.prototype = {
    supportedMethods: [ZOTERO_MUTATION_METHOD, "OPTIONS"],
    supportedDataTypes: ["application/json"],
    init: function (data: any, sendResponseCallback: Function) {
      try {
        const hasBody = data !== undefined && data !== null && data !== "";
        const body = hasBody ? parseRequestBody(data) : {};
        const jobId = readOptionalJobId(body);
        const attachmentIds = readSelectedAttachmentIds(body);
        if (attachmentIds !== undefined && jobId === undefined) {
          sendJSON(sendResponseCallback, 400, {
            error: "jobId is required with attachmentIds",
          });
          return;
        }

        // Legacy Chrome companions omit jobId. Updated companions bind the
        // claim to the batch they loaded so a stale popup cannot consume a
        // newer staged job. Claiming does not imply Gemini accepted the files.
        const claimed = claimStagedJob(jobId, attachmentIds);
        if (jobId !== undefined && !claimed) {
          sendJSON(sendResponseCallback, 409, {
            error: "The staged job changed; refresh the Chrome companion",
          });
          return;
        }
        sendJSON(sendResponseCallback, 200, { cleared: true });
      } catch {
        sendJSON(sendResponseCallback, 400, {
          error: "Invalid clear request",
        });
      }
    },
  };
}
