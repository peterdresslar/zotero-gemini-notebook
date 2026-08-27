export class FileReadPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileReadPolicyError";
  }
}

export function assertStagedFileReadPolicy(
  info: { type?: string; size?: number },
  maxByteSize?: number,
): void {
  if (
    info?.type !== "regular" ||
    !Number.isSafeInteger(info.size) ||
    (info.size as number) < 0
  ) {
    throw new FileReadPolicyError(
      "The staged source is no longer a regular file.",
    );
  }
  if (
    maxByteSize !== undefined &&
    (!Number.isSafeInteger(maxByteSize) ||
      maxByteSize < 0 ||
      (info.size as number) > maxByteSize)
  ) {
    throw new FileReadPolicyError(
      "The staged source no longer satisfies its byte limit.",
    );
  }
}

export async function readFileAsBase64(
  filePath: string,
  maxByteSize?: number,
): Promise<string> {
  if (
    maxByteSize !== undefined &&
    (!Number.isSafeInteger(maxByteSize) || maxByteSize < 0)
  ) {
    throw new FileReadPolicyError("The staged source byte limit is invalid.");
  }

  const data = await IOUtils.read(
    filePath,
    maxByteSize === undefined ? undefined : { maxBytes: maxByteSize + 1 },
  );
  if (maxByteSize !== undefined && data.byteLength > maxByteSize) {
    throw new FileReadPolicyError(
      "The staged source changed after its byte limit was recorded.",
    );
  }
  // Convert Uint8Array to base64
  let binary = "";
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}
