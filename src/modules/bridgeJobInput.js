const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/i;
const JOB_INPUT_KEYS = new Set([
  "libraryID",
  "itemKeys",
  "collectionKey",
  "recursive",
  "destination",
  "requestId",
  "replace",
]);

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

  const base = {
    libraryID: input.libraryID,
    destination: "active-or-new",
    replace: input.replace ?? false,
    ...(requestId === undefined ? {} : { requestId }),
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
