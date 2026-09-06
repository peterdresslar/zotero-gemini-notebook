const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/i;
const JOB_INPUT_KEYS = new Set([
  "libraryID",
  "itemKeys",
  "collectionKey",
  "recursive",
  "destination",
  "requestId",
  "replace",
  "studioPrompt",
]);

export const MAX_STUDIO_PROMPT_BYTES = 4000;

export function normalizeStudioPrompt(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    // eslint-disable-next-line no-control-regex -- Permit text whitespace while rejecting other C0 controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\ud800-\udfff]/u.test(value) ||
    new globalThis.TextEncoder().encode(value).byteLength >
      MAX_STUDIO_PROMPT_BYTES
  ) {
    throw new TypeError(
      "studioPrompt must be nonblank text of at most 4000 UTF-8 bytes without unsupported control characters.",
    );
  }
  return value;
}

export function normalizeCreateBridgeJobInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("createJob requires a plain input object.");
  }

  for (const key of Object.keys(input)) {
    if (!JOB_INPUT_KEYS.has(key)) {
      throw new TypeError(`createJob does not accept the field ${key}.`);
    }
  }

  if (!Number.isSafeInteger(input.libraryID) || input.libraryID <= 0) {
    throw new TypeError("libraryID must be a positive integer.");
  }
  if (input.destination !== "active-or-new") {
    throw new TypeError('destination must be "active-or-new".');
  }

  let requestId;
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== "string" || input.requestId.trim() === "") {
      throw new TypeError("requestId must be a non-empty string.");
    }
    requestId = input.requestId.trim();
    if (requestId.length > 128) {
      throw new TypeError("requestId must not exceed 128 characters.");
    }
  }
  if (input.replace !== undefined && typeof input.replace !== "boolean") {
    throw new TypeError("replace must be a boolean.");
  }

  const hasItemKeys = Object.prototype.hasOwnProperty.call(input, "itemKeys");
  const hasCollectionKey = Object.prototype.hasOwnProperty.call(
    input,
    "collectionKey",
  );
  if (hasItemKeys === hasCollectionKey) {
    throw new TypeError(
      "Provide exactly one Zotero source: itemKeys or collectionKey.",
    );
  }

  const studioPrompt = normalizeStudioPrompt(input.studioPrompt);
  const base = {
    libraryID: input.libraryID,
    destination: "active-or-new",
    replace: input.replace ?? false,
    ...(requestId === undefined ? {} : { requestId }),
    ...(studioPrompt === undefined ? {} : { studioPrompt }),
  };

  if (hasItemKeys) {
    if (!Array.isArray(input.itemKeys) || input.itemKeys.length === 0) {
      throw new TypeError("itemKeys must be a non-empty array.");
    }
    const itemKeys = Array.from(input.itemKeys, (key) =>
      normalizeZoteroKey(key),
    );
    if (new Set(itemKeys).size !== itemKeys.length) {
      throw new TypeError("itemKeys must not contain duplicates.");
    }
    if (input.recursive !== undefined) {
      throw new TypeError("recursive is only valid with collectionKey.");
    }
    return Object.freeze({ ...base, itemKeys: Object.freeze(itemKeys.sort()) });
  }

  if (input.recursive !== undefined && typeof input.recursive !== "boolean") {
    throw new TypeError("recursive must be a boolean.");
  }
  return Object.freeze({
    ...base,
    collectionKey: normalizeZoteroKey(input.collectionKey),
    recursive: input.recursive ?? false,
  });
}

function normalizeZoteroKey(value) {
  if (typeof value !== "string" || !ZOTERO_KEY_PATTERN.test(value)) {
    throw new TypeError(
      "Zotero object keys must be eight alphanumeric characters.",
    );
  }
  return value.toUpperCase();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
