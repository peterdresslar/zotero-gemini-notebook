import { getPref } from "../utils/prefs";
import { createJob, getJob } from "./bridgeJobs";
import {
  MCP_AUTH_RESPONSE_SIGNATURE_HEADER,
  McpAuthProtocolError,
  assertMcpNonBrowserRequest,
  createMcpAuthResponseSignature,
  createMcpAuthReplayCache,
  hasMcpQueryParameters,
  verifyMcpAuthRequest,
} from "./mcpAuthProtocol.js";
import {
  MCP_CREATE_JOB_CONTENT_TYPE,
  McpJobControlProtocolError,
  createMcpCreateJobSuccessBody,
  parseCanonicalCreateJobBody,
  rawBinaryStringToBytes,
  readMcpCreateJobContentLength,
} from "./mcpJobControlProtocol.js";
import {
  MCP_JOB_STATUS_CONTENT_TYPE,
  McpJobStatusProtocolError,
  createMcpJobNotFoundBody,
  createMcpJobStatusSuccessBody,
  parseCanonicalJobStatusBody,
  readMcpJobStatusContentLength,
} from "./mcpJobStatusProtocol.js";
import { readMcpLocalAuthorizationKey } from "./mcpLocalAuth";
import { PRIVATE_RESPONSE_OPTIONS } from "./zoteroServerContract.js";

export const MCP_CONTROL_AUTH_CHECK_PATH = "/notebooklm/control/v1/auth-check";
export const MCP_CONTROL_CREATE_JOB_PATH = "/notebooklm/control/v1/jobs";
export const MCP_CONTROL_JOB_STATUS_PATH = "/notebooklm/control/v1/jobs/status";

const MCP_CONTROL_API_VERSION = 1;
const MCP_AUTH_CONTENT_TYPE = "application/json";
// Zotero logs other JSON request bodies before endpoint code runs. Keep this
// fixed, non-secret body exact so Zotero's built-in `{}` log omission applies.
const MCP_AUTH_BODY = "{}";

type McpControlErrorCode =
  | "invalid_request"
  | "browser_request_rejected"
  | "control_disabled"
  | "authentication_failed"
  | "library_not_found"
  | "collection_not_found"
  | "no_supported_attachments"
  | "pending_job_exists"
  | "idempotency_conflict"
  | "job_not_found"
  | "source_limit_exceeded"
  | "temporarily_unavailable"
  | "internal_error";

interface McpControlRequest {
  method: string;
  pathname: string;
  searchParams: { toString(): string };
  headers: Record<string, string>;
  data: unknown;
}

type McpControlResponse = [
  status: number,
  headers: Record<string, string>,
  body: string,
  responseOptions: typeof PRIVATE_RESPONSE_OPTIONS,
];

interface McpControlErrorDefinition {
  status: number;
  code: McpControlErrorCode;
  message: string;
  retryable: boolean;
}

const RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
});

const replayCache = createMcpAuthReplayCache({
  ttlSeconds: 120,
  maxEntries: 2048,
});

function McpControlAuthCheckEndpoint() {}
McpControlAuthCheckEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: [MCP_AUTH_CONTENT_TYPE],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: false,
  init: handleMcpControlAuthCheck,
};

function McpControlCreateJobEndpoint() {}
McpControlCreateJobEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: [MCP_CREATE_JOB_CONTENT_TYPE],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: false,
  init: handleMcpControlCreateJob,
};

function McpControlJobStatusEndpoint() {}
McpControlJobStatusEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: [MCP_JOB_STATUS_CONTENT_TYPE],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: false,
  init: handleMcpControlJobStatus,
};

export function registerMcpControlEndpoints(): void {
  Zotero.Server.Endpoints[MCP_CONTROL_AUTH_CHECK_PATH] =
    McpControlAuthCheckEndpoint;
  Zotero.Server.Endpoints[MCP_CONTROL_CREATE_JOB_PATH] =
    McpControlCreateJobEndpoint;
  Zotero.Server.Endpoints[MCP_CONTROL_JOB_STATUS_PATH] =
    McpControlJobStatusEndpoint;
}

export function resetMcpControlReplayCache(): void {
  replayCache.reset();
}

export function unregisterMcpControlEndpoints(): void {
  const endpoints = Zotero.Server.Endpoints;
  if (endpoints[MCP_CONTROL_AUTH_CHECK_PATH] === McpControlAuthCheckEndpoint) {
    delete endpoints[MCP_CONTROL_AUTH_CHECK_PATH];
  }
  if (endpoints[MCP_CONTROL_CREATE_JOB_PATH] === McpControlCreateJobEndpoint) {
    delete endpoints[MCP_CONTROL_CREATE_JOB_PATH];
  }
  if (endpoints[MCP_CONTROL_JOB_STATUS_PATH] === McpControlJobStatusEndpoint) {
    delete endpoints[MCP_CONTROL_JOB_STATUS_PATH];
  }
  resetMcpControlReplayCache();
}

async function handleMcpControlAuthCheck(
  request: McpControlRequest,
): Promise<McpControlResponse> {
  try {
    validateRequestEnvelope(request, MCP_CONTROL_AUTH_CHECK_PATH);
    if (
      readHeader(request.headers, "content-type") !== MCP_AUTH_CONTENT_TYPE ||
      readHeader(request.headers, "content-length") !==
        String(MCP_AUTH_BODY.length)
    ) {
      throw new McpAuthProtocolError(
        "INVALID_REQUEST",
        "The request content type is invalid",
      );
    }
    if (!isEmptyJsonObject(request.data)) {
      throw new McpAuthProtocolError(
        "INVALID_REQUEST",
        "The request body is invalid",
      );
    }
    if (getPref("mcp.enabled") !== true) {
      return controlError({
        status: 403,
        code: "control_disabled",
        message: "MCP support is disabled in Zotero.",
        retryable: false,
      });
    }

    const key = await readMcpLocalAuthorizationKey();
    let responseBody: string;
    let responseSignature: string;
    try {
      const authenticatedRequest = await verifyMcpAuthRequest({
        method: "POST",
        pathname: MCP_CONTROL_AUTH_CHECK_PATH,
        contentType: MCP_AUTH_CONTENT_TYPE,
        body: MCP_AUTH_BODY,
        headers: request.headers,
        key,
        replayCache,
        cryptoApi: getMcpControlCrypto(),
      });
      responseBody = JSON.stringify({
        apiVersion: MCP_CONTROL_API_VERSION,
        authenticated: true,
      });
      responseSignature = await createMcpAuthResponseSignature({
        timestamp: authenticatedRequest.timestamp,
        nonce: authenticatedRequest.nonce,
        method: "POST",
        pathname: MCP_CONTROL_AUTH_CHECK_PATH,
        status: 200,
        body: responseBody,
        key,
        cryptoApi: getMcpControlCrypto(),
      });
    } finally {
      key.fill(0);
    }

    return jsonTextResponse(200, responseBody, {
      [MCP_AUTH_RESPONSE_SIGNATURE_HEADER]: responseSignature,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleMcpControlCreateJob(
  request: McpControlRequest,
): Promise<McpControlResponse> {
  let key: Uint8Array | null = null;
  try {
    validateRequestEnvelope(request, MCP_CONTROL_CREATE_JOB_PATH);
    if (
      readHeader(request.headers, "content-type") !==
        MCP_CREATE_JOB_CONTENT_TYPE ||
      hasUnsupportedBodyEncoding(request.headers)
    ) {
      throw new McpJobControlProtocolError(
        "The create-job request representation is invalid",
      );
    }

    const contentLength = readMcpCreateJobContentLength(request.headers);
    const rawBody = readMcpRawRequestBody(request.data, contentLength);
    if (getPref("mcp.enabled") !== true) {
      return controlError({
        status: 403,
        code: "control_disabled",
        message: "MCP support is disabled in Zotero.",
        retryable: false,
      });
    }

    key = await readMcpLocalAuthorizationKey();
    const authenticatedRequest = await verifyMcpAuthRequest({
      method: "POST",
      pathname: MCP_CONTROL_CREATE_JOB_PATH,
      contentType: MCP_CREATE_JOB_CONTENT_TYPE,
      body: rawBody,
      headers: request.headers,
      key,
      replayCache,
      cryptoApi: getMcpControlCrypto(),
    });

    const input = parseCanonicalCreateJobBody(rawBody);
    let job;
    try {
      job = await createJob(input);
    } catch (error) {
      return createJobErrorResponse(error);
    }

    const responseBody = createMcpCreateJobSuccessBody(job);
    const responseSignature = await createMcpAuthResponseSignature({
      timestamp: authenticatedRequest.timestamp,
      nonce: authenticatedRequest.nonce,
      method: "POST",
      pathname: MCP_CONTROL_CREATE_JOB_PATH,
      status: 200,
      body: responseBody,
      key,
      cryptoApi: getMcpControlCrypto(),
    });
    return jsonTextResponse(200, responseBody, {
      [MCP_AUTH_RESPONSE_SIGNATURE_HEADER]: responseSignature,
    });
  } catch (error) {
    return createJobProtocolErrorResponse(error);
  } finally {
    key?.fill(0);
  }
}

async function handleMcpControlJobStatus(
  request: McpControlRequest,
): Promise<McpControlResponse> {
  let key: Uint8Array | null = null;
  try {
    validateRequestEnvelope(request, MCP_CONTROL_JOB_STATUS_PATH);
    if (
      readHeader(request.headers, "content-type") !==
        MCP_JOB_STATUS_CONTENT_TYPE ||
      hasUnsupportedBodyEncoding(request.headers)
    ) {
      throw new McpJobStatusProtocolError(
        "The job-status request representation is invalid",
      );
    }

    const contentLength = readMcpJobStatusContentLength(request.headers);
    const rawBody = readMcpRawRequestBody(request.data, contentLength);
    if (getPref("mcp.enabled") !== true) {
      return controlError({
        status: 403,
        code: "control_disabled",
        message: "MCP support is disabled in Zotero.",
        retryable: false,
      });
    }

    key = await readMcpLocalAuthorizationKey();
    const authenticatedRequest = await verifyMcpAuthRequest({
      method: "POST",
      pathname: MCP_CONTROL_JOB_STATUS_PATH,
      contentType: MCP_JOB_STATUS_CONTENT_TYPE,
      body: rawBody,
      headers: request.headers,
      key,
      replayCache,
      cryptoApi: getMcpControlCrypto(),
    });

    const input = parseCanonicalJobStatusBody(rawBody);
    const job = getJob(input.jobId);
    if (!job) {
      const responseBody = createMcpJobNotFoundBody();
      const responseSignature = await createMcpAuthResponseSignature({
        timestamp: authenticatedRequest.timestamp,
        nonce: authenticatedRequest.nonce,
        method: "POST",
        pathname: MCP_CONTROL_JOB_STATUS_PATH,
        status: 404,
        body: responseBody,
        key,
        cryptoApi: getMcpControlCrypto(),
      });
      return jsonTextResponse(404, responseBody, {
        [MCP_AUTH_RESPONSE_SIGNATURE_HEADER]: responseSignature,
      });
    }

    const responseBody = createMcpJobStatusSuccessBody(job);
    const responseSignature = await createMcpAuthResponseSignature({
      timestamp: authenticatedRequest.timestamp,
      nonce: authenticatedRequest.nonce,
      method: "POST",
      pathname: MCP_CONTROL_JOB_STATUS_PATH,
      status: 200,
      body: responseBody,
      key,
      cryptoApi: getMcpControlCrypto(),
    });
    return jsonTextResponse(200, responseBody, {
      [MCP_AUTH_RESPONSE_SIGNATURE_HEADER]: responseSignature,
    });
  } catch (error) {
    return jobStatusProtocolErrorResponse(error);
  } finally {
    key?.fill(0);
  }
}

function validateRequestEnvelope(
  request: McpControlRequest,
  expectedPathname: string,
): void {
  assertMcpNonBrowserRequest(request?.headers);
  if (
    request.method !== "POST" ||
    request.pathname !== expectedPathname ||
    hasMcpQueryParameters(request.searchParams)
  ) {
    throw new McpAuthProtocolError(
      "INVALID_REQUEST",
      "The MCP control request is invalid",
    );
  }
}

function hasUnsupportedBodyEncoding(headers: Record<string, string>): boolean {
  return (
    readHeader(headers, "content-encoding") !== undefined ||
    readHeader(headers, "transfer-encoding") !== undefined
  );
}

function readMcpRawRequestBody(
  inputStream: unknown,
  contentLength: number,
): Uint8Array {
  if (!inputStream || typeof inputStream !== "object") {
    throw new McpJobControlProtocolError(
      "The create-job request body stream is unavailable",
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
    throw new McpJobControlProtocolError(
      "The create-job request body could not be read",
    );
  }
  return rawBinaryStringToBytes(binary, contentLength);
}

function isEmptyJsonObject(value: unknown): boolean {
  if (value === MCP_AUTH_BODY) return true;
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function readHeader(
  headers: Record<string, string>,
  expectedName: string,
): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const names = Object.keys(headers).filter(
    (candidate) => candidate.toLowerCase() === expectedName,
  );
  return names.length !== 1 || typeof headers[names[0]] !== "string"
    ? undefined
    : headers[names[0]];
}

function getMcpControlCrypto(): Crypto {
  let cryptoApi: Crypto;
  try {
    cryptoApi = (Services.appShell.hiddenDOMWindow as unknown as Window).crypto;
  } catch {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "Web Crypto is unavailable",
    );
  }
  if (
    !cryptoApi?.subtle ||
    typeof cryptoApi.subtle.digest !== "function" ||
    typeof cryptoApi.subtle.importKey !== "function" ||
    typeof cryptoApi.subtle.verify !== "function"
  ) {
    throw new McpAuthProtocolError(
      "CRYPTO_UNAVAILABLE",
      "Web Crypto is unavailable",
    );
  }
  return cryptoApi;
}

function jsonTextResponse(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): McpControlResponse {
  return [
    status,
    { ...RESPONSE_HEADERS, ...extraHeaders },
    body,
    PRIVATE_RESPONSE_OPTIONS,
  ];
}

function controlError(
  definition: McpControlErrorDefinition,
): McpControlResponse {
  return jsonTextResponse(
    definition.status,
    createControlErrorBody(definition),
  );
}

function createControlErrorBody(definition: McpControlErrorDefinition): string {
  return JSON.stringify({
    apiVersion: MCP_CONTROL_API_VERSION,
    error: {
      code: definition.code,
      message: definition.message,
      retryable: definition.retryable,
    },
  });
}

function authenticationFailed(): McpControlResponse {
  return controlError({
    status: 403,
    code: "authentication_failed",
    message: "MCP authentication failed.",
    retryable: false,
  });
}

function temporarilyUnavailable(): McpControlResponse {
  return controlError({
    status: 503,
    code: "temporarily_unavailable",
    message: "MCP authentication is temporarily unavailable.",
    retryable: true,
  });
}

function createJobErrorResponse(error: unknown): McpControlResponse {
  if (hasErrorCode(error, "PENDING_JOB_EXISTS")) {
    return controlError({
      status: 409,
      code: "pending_job_exists",
      message: "A Zotero bridge job is already pending.",
      retryable: false,
    });
  }
  if (hasErrorCode(error, "IDEMPOTENCY_CONFLICT")) {
    return controlError({
      status: 409,
      code: "idempotency_conflict",
      message: "The request identifier was already used for another job.",
      retryable: false,
    });
  }
  if (hasErrorCode(error, "SECURE_RANDOM_UNAVAILABLE")) {
    return temporarilyUnavailable();
  }
  if (hasErrorCode(error, "LIBRARY_NOT_FOUND")) {
    return controlError({
      status: 404,
      code: "library_not_found",
      message: "The requested Zotero library was not found.",
      retryable: false,
    });
  }
  if (hasErrorCode(error, "COLLECTION_NOT_FOUND")) {
    return controlError({
      status: 404,
      code: "collection_not_found",
      message: "The requested Zotero collection was not found.",
      retryable: false,
    });
  }
  if (hasErrorCode(error, "NO_SUPPORTED_ATTACHMENTS")) {
    return controlError({
      status: 400,
      code: "no_supported_attachments",
      message: "No supported local attachments were found.",
      retryable: false,
    });
  }
  if (hasErrorCode(error, "SOURCE_LIMIT_EXCEEDED")) {
    return controlError({
      status: 400,
      code: "source_limit_exceeded",
      message: "The Zotero source selection exceeds the supported limit.",
      retryable: false,
    });
  }

  return controlError({
    status: 500,
    code: "internal_error",
    message: "The MCP control endpoint encountered an internal error.",
    retryable: true,
  });
}

function createJobProtocolErrorResponse(error: unknown): McpControlResponse {
  if (error instanceof McpJobControlProtocolError) {
    if (error.code === "SOURCE_LIMIT_EXCEEDED") {
      return controlError({
        status: 400,
        code: "source_limit_exceeded",
        message: "The Zotero source selection exceeds the supported limit.",
        retryable: false,
      });
    }
    return controlError({
      status: 400,
      code: "invalid_request",
      message: "The job request is invalid.",
      retryable: false,
    });
  }

  if (error instanceof McpAuthProtocolError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return controlError({
          status: 400,
          code: "invalid_request",
          message: "The job request is invalid.",
          retryable: false,
        });
      case "BROWSER_REQUEST_REJECTED":
      case "AUTHENTICATION_FAILED":
        return authenticationFailed();
      case "CRYPTO_UNAVAILABLE":
        return temporarilyUnavailable();
    }
  }

  if (
    hasErrorCode(error, "LOCAL_AUTH_CRYPTO_UNAVAILABLE") ||
    hasErrorCode(error, "LOCAL_AUTH_STORAGE_UNAVAILABLE")
  ) {
    return temporarilyUnavailable();
  }
  if (
    hasErrorCode(error, "LOCAL_AUTH_KEY_MISSING") ||
    hasErrorCode(error, "LOCAL_AUTH_KEY_INVALID")
  ) {
    return authenticationFailed();
  }

  return controlError({
    status: 500,
    code: "internal_error",
    message: "The MCP control endpoint encountered an internal error.",
    retryable: true,
  });
}

function jobStatusProtocolErrorResponse(error: unknown): McpControlResponse {
  if (
    error instanceof McpJobStatusProtocolError ||
    error instanceof McpJobControlProtocolError
  ) {
    return controlError({
      status: 400,
      code: "invalid_request",
      message: "The job-status request is invalid.",
      retryable: false,
    });
  }

  if (error instanceof McpAuthProtocolError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return controlError({
          status: 400,
          code: "invalid_request",
          message: "The job-status request is invalid.",
          retryable: false,
        });
      case "BROWSER_REQUEST_REJECTED":
      case "AUTHENTICATION_FAILED":
        return authenticationFailed();
      case "CRYPTO_UNAVAILABLE":
        return temporarilyUnavailable();
    }
  }

  if (
    hasErrorCode(error, "LOCAL_AUTH_CRYPTO_UNAVAILABLE") ||
    hasErrorCode(error, "LOCAL_AUTH_STORAGE_UNAVAILABLE")
  ) {
    return temporarilyUnavailable();
  }
  if (
    hasErrorCode(error, "LOCAL_AUTH_KEY_MISSING") ||
    hasErrorCode(error, "LOCAL_AUTH_KEY_INVALID")
  ) {
    return authenticationFailed();
  }

  return controlError({
    status: 500,
    code: "internal_error",
    message: "The MCP control endpoint encountered an internal error.",
    retryable: true,
  });
}

function errorResponse(error: unknown): McpControlResponse {
  if (error instanceof McpAuthProtocolError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return controlError({
          status: 400,
          code: "invalid_request",
          message: "The MCP control request is invalid.",
          retryable: false,
        });
      case "BROWSER_REQUEST_REJECTED":
        return controlError({
          status: 403,
          code: "browser_request_rejected",
          message:
            "Browser requests are not allowed on the MCP control endpoint.",
          retryable: false,
        });
      case "AUTHENTICATION_FAILED":
        return authenticationFailed();
      case "CRYPTO_UNAVAILABLE":
        return temporarilyUnavailable();
    }
  }

  if (
    hasErrorCode(error, "LOCAL_AUTH_CRYPTO_UNAVAILABLE") ||
    hasErrorCode(error, "LOCAL_AUTH_STORAGE_UNAVAILABLE")
  ) {
    return temporarilyUnavailable();
  }
  if (
    hasErrorCode(error, "LOCAL_AUTH_KEY_MISSING") ||
    hasErrorCode(error, "LOCAL_AUTH_KEY_INVALID")
  ) {
    return authenticationFailed();
  }

  return controlError({
    status: 500,
    code: "internal_error",
    message: "The MCP control endpoint encountered an internal error.",
    retryable: true,
  });
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === expectedCode,
  );
}
