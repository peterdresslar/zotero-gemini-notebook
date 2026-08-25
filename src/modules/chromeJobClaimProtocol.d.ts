export const CHROME_JOB_CLAIM_CONTENT_TYPE: string;
export const CHROME_JOB_CLAIM_MAX_BODY_BYTES: number;
export const CHROME_JOB_CLAIM_MAX_ATTACHMENTS: number;

export interface ChromeJobClaimInput {
  attachmentIds: readonly number[];
  claimId: string;
  jobId: string;
}

export class ChromeJobClaimProtocolError extends Error {}

export function readChromeJobClaimContentLength(
  headers: Record<string, string>,
): number;

export function rawChromeJobClaimBodyToBytes(
  value: string,
  expectedLength: number,
): Uint8Array;

export function parseCanonicalChromeJobClaimBody(
  value: Uint8Array | ArrayBuffer | ArrayBufferView,
): Readonly<ChromeJobClaimInput>;
