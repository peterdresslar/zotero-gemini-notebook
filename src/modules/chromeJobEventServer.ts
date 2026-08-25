import {
  ChromeJobEventConflictError,
  reportChromeJobEvent,
} from "./bridgeJobs";
import { BridgeJobStoreError } from "./bridgeJobStore.js";
import {
  CHROME_JOB_CLAIM_CONTENT_TYPE,
  ChromeJobClaimProtocolError,
  parseCanonicalChromeJobClaimBody,
  rawChromeJobClaimBodyToBytes,
  readChromeJobClaimContentLength,
} from "./chromeJobClaimProtocol.js";
import {
  CHROME_JOB_EVENT_CONTENT_TYPE,
  ChromeJobEventProtocolError,
  parseCanonicalChromeJobEventBody,
  rawChromeJobEventBodyToBytes,
  readChromeJobEventContentLength,
} from "./chromeJobEventProtocol.js";
import { claimStagedJob } from "./staging";
import { PRIVATE_RESPONSE_OPTIONS } from "./zoteroServerContract.js";

export const CHROME_JOB_CLAIM_PATH = "/notebooklm/job-claim";
export const CHROME_JOB_EVENT_PATH = "/notebooklm/job-event";

interface ChromeJobLifecycleRequest {
  method: string;
  pathname: string;
  searchParams: { toString(): string };
  headers: Record<string, string>;
  data: unknown;
}

type ChromeJobLifecycleResponse = [
  status: number,
  headers: Record<string, string>,
  body: string,
  responseOptions: typeof PRIVATE_RESPONSE_OPTIONS,
];

const RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
});

function ChromeJobClaimEndpoint() {}
ChromeJobClaimEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: [CHROME_JOB_CLAIM_CONTENT_TYPE],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: false,
  init: handleChromeJobClaim,
};

function ChromeJobEventEndpoint() {}
ChromeJobEventEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: [CHROME_JOB_EVENT_CONTENT_TYPE],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: false,
  init: handleChromeJobEvent,
};

export function registerChromeJobClaimEndpoint(): void {
  Zotero.Server.Endpoints[CHROME_JOB_CLAIM_PATH] = ChromeJobClaimEndpoint;
}

export function registerChromeJobEventEndpoint(): void {
  Zotero.Server.Endpoints[CHROME_JOB_EVENT_PATH] = ChromeJobEventEndpoint;
}

export function unregisterChromeJobClaimEndpoint(): void {
  const endpoints = Zotero.Server.Endpoints;
  if (endpoints[CHROME_JOB_CLAIM_PATH] === ChromeJobClaimEndpoint) {
    delete endpoints[CHROME_JOB_CLAIM_PATH];
  }
}

export function unregisterChromeJobEventEndpoint(): void {
  const endpoints = Zotero.Server.Endpoints;
  if (endpoints[CHROME_JOB_EVENT_PATH] === ChromeJobEventEndpoint) {
    delete endpoints[CHROME_JOB_EVENT_PATH];
  }
}

async function handleChromeJobClaim(
  request: ChromeJobLifecycleRequest,
): Promise<ChromeJobLifecycleResponse> {
  try {
    validateRequestEnvelope(
      request,
      CHROME_JOB_CLAIM_PATH,
      CHROME_JOB_CLAIM_CONTENT_TYPE,
      (message) => new ChromeJobClaimProtocolError(message),
    );
    const contentLength = readChromeJobClaimContentLength(request.headers);
    const rawBody = readRawRequestBody(
      request.data,
      contentLength,
      (message) => new ChromeJobClaimProtocolError(message),
      rawChromeJobClaimBodyToBytes,
    );
    const input = parseCanonicalChromeJobClaimBody(rawBody);

    let claimed;
    try {
      claimed = claimStagedJob(
        input.jobId,
        [...input.attachmentIds],
        input.claimId,
      );
    } catch (error) {
      if (error instanceof BridgeJobStoreError) {
        throw new ChromeJobClaimConflictError();
      }
      throw error;
    }
    if (
      !claimed ||
      claimed.jobId !== input.jobId ||
      claimed.state !== "claimed"
    ) {
      throw new ChromeJobClaimConflictError();
    }

    return jsonTextResponse(
      200,
      JSON.stringify({
        claimId: input.claimId,
        jobId: input.jobId,
        state: "claimed",
      }),
    );
  } catch (error) {
    if (error instanceof ChromeJobRequestAuthorizationError) {
      return fixedErrorResponse(
        403,
        "browser_request_rejected",
        "The Chrome job-claim request was rejected.",
      );
    }
    if (error instanceof ChromeJobClaimProtocolError) {
      return fixedErrorResponse(
        400,
        "invalid_request",
        "The Chrome job-claim request is invalid.",
      );
    }
    if (error instanceof ChromeJobClaimConflictError) {
      return fixedErrorResponse(
        409,
        "job_claim_conflict",
        "The Chrome job claim no longer matches the staged job.",
      );
    }
    return fixedErrorResponse(
      500,
      "internal_error",
      "The Chrome job claim could not be recorded.",
    );
  }
}

async function handleChromeJobEvent(
  request: ChromeJobLifecycleRequest,
): Promise<ChromeJobLifecycleResponse> {
  try {
    validateRequestEnvelope(
      request,
      CHROME_JOB_EVENT_PATH,
      CHROME_JOB_EVENT_CONTENT_TYPE,
      (message) => new ChromeJobEventProtocolError(message),
    );
    const contentLength = readChromeJobEventContentLength(request.headers);
    const rawBody = readRawRequestBody(
      request.data,
      contentLength,
      (message) => new ChromeJobEventProtocolError(message),
      rawChromeJobEventBodyToBytes,
    );
    const input = parseCanonicalChromeJobEventBody(rawBody);
    reportChromeJobEvent(input.jobId, input.claimId, input.event);
    return jsonTextResponse(200, '{"accepted":true}');
  } catch (error) {
    if (error instanceof ChromeJobRequestAuthorizationError) {
      return fixedErrorResponse(
        403,
        "browser_request_rejected",
        "The Chrome job-event request was rejected.",
      );
    }
    if (error instanceof ChromeJobEventProtocolError) {
      return fixedErrorResponse(
        400,
        "invalid_request",
        "The Chrome job-event request is invalid.",
      );
    }
    if (error instanceof ChromeJobEventConflictError) {
      return fixedErrorResponse(
        409,
        "job_event_conflict",
        "The Chrome job event no longer matches the claimed job.",
      );
    }
    return fixedErrorResponse(
      500,
      "internal_error",
      "The Chrome job event could not be recorded.",
    );
  }
}

function validateRequestEnvelope(
  request: ChromeJobLifecycleRequest,
  expectedPath: string,
  expectedContentType: string,
  invalidRequest: (message: string) => Error,
): void {
  if (readSingleHeader(request?.headers, "zotero-allowed-request") !== "1") {
    throw new ChromeJobRequestAuthorizationError();
  }
  if (
    request.method !== "POST" ||
    request.pathname !== expectedPath ||
    hasQueryParameters(request.searchParams) ||
    readSingleHeader(request.headers, "content-type") !== expectedContentType ||
    hasHeader(request.headers, "content-encoding") ||
    hasHeader(request.headers, "transfer-encoding")
  ) {
    throw invalidRequest(
      "The Chrome job lifecycle request envelope is invalid",
    );
  }
}

function readRawRequestBody(
  inputStream: unknown,
  contentLength: number,
  invalidRequest: (message: string) => Error,
  convertRawBody: (value: string, expectedLength: number) => Uint8Array,
): Uint8Array {
  if (!inputStream || typeof inputStream !== "object") {
    throw invalidRequest(
      "The Chrome job lifecycle request body stream is unavailable",
    );
  }

  let binary: string;
  try {
    const { NetUtil: networkUtilities } = ChromeUtils.importESModule(
      "resource://gre/modules/NetUtil.sys.mjs",
    );
    binary = networkUtilities.readInputStreamToString(
      inputStream,
      contentLength,
    );
  } catch {
    throw invalidRequest(
      "The Chrome job lifecycle request body could not be read",
    );
  }
  return convertRawBody(binary, contentLength);
}

function readSingleHeader(
  headers: Record<string, string>,
  expectedName: string,
): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const matchingNames = Object.keys(headers).filter(
    (name) => name.toLowerCase() === expectedName,
  );
  if (matchingNames.length !== 1) return undefined;
  const value = headers[matchingNames[0]];
  return typeof value === "string" ? value : undefined;
}

function hasHeader(
  headers: Record<string, string>,
  expectedName: string,
): boolean {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some(
    (name) => name.toLowerCase() === expectedName,
  );
}

function hasQueryParameters(searchParams: { toString(): string }): boolean {
  if (
    !searchParams ||
    typeof searchParams !== "object" ||
    typeof searchParams.toString !== "function"
  ) {
    return true;
  }
  try {
    return searchParams.toString() !== "";
  } catch {
    return true;
  }
}

function jsonTextResponse(
  status: number,
  body: string,
): ChromeJobLifecycleResponse {
  return [status, RESPONSE_HEADERS, body, PRIVATE_RESPONSE_OPTIONS];
}

function fixedErrorResponse(
  status: number,
  code: string,
  message: string,
): ChromeJobLifecycleResponse {
  return jsonTextResponse(
    status,
    JSON.stringify({
      error: {
        code,
        message,
        retryable: false,
      },
    }),
  );
}

class ChromeJobRequestAuthorizationError extends Error {
  constructor() {
    super("The Chrome job lifecycle request is not authorized");
    this.name = "ChromeJobRequestAuthorizationError";
  }
}

class ChromeJobClaimConflictError extends Error {
  constructor() {
    super("The Chrome job claim does not match the staged bridge job");
    this.name = "ChromeJobClaimConflictError";
  }
}
