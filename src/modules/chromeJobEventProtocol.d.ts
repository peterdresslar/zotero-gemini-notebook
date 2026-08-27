export const CHROME_JOB_EVENT_CONTENT_TYPE: string;
export const CHROME_JOB_EVENT_MAX_BODY_BYTES: number;

export type ChromeJobEvent =
  | "submitted"
  | "verifying"
  | "verified"
  | "unverified"
  | "failed";

export interface ChromeJobEventInput {
  claimId: string;
  event: ChromeJobEvent;
  jobId: string;
}

export class ChromeJobEventProtocolError extends Error {}

export function readChromeJobEventContentLength(
  headers: Record<string, string>,
): number;

export function rawChromeJobEventBodyToBytes(
  value: string,
  expectedLength: number,
): Uint8Array;

export function parseCanonicalChromeJobEventBody(
  value: Uint8Array | ArrayBuffer | ArrayBufferView,
): Readonly<ChromeJobEventInput>;
