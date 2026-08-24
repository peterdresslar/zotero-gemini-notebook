const PRIVATE_STORAGE_DIRECTORY = ".zotero-gemini-notebook";
const MCP_STORAGE_DIRECTORY = "mcp";
const LOCAL_AUTHORIZATION_FILE = "local-bridge.key";
const PRIVATE_DIRECTORY_PERMISSIONS = 0o700;
const PRIVATE_FILE_PERMISSIONS = 0o600;
const LOCAL_AUTHORIZATION_KEY_BYTES = 32;

export type McpLocalAuthorizationErrorCode =
  | "LOCAL_AUTH_KEY_MISSING"
  | "LOCAL_AUTH_KEY_INVALID"
  | "LOCAL_AUTH_CRYPTO_UNAVAILABLE"
  | "LOCAL_AUTH_STORAGE_UNAVAILABLE";

export class McpLocalAuthorizationError extends Error {
  readonly code: McpLocalAuthorizationErrorCode;

  constructor(code: McpLocalAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "McpLocalAuthorizationError";
    this.code = code;
  }
}

export type McpLocalAuthorizationStatus = Readonly<{
  status: "ready" | "missing" | "invalid";
  errorCode?: McpLocalAuthorizationErrorCode;
}>;

interface McpLocalAuthorizationFileInfo {
  permissions?: number;
  size?: number;
  type?: "directory" | "other" | "regular";
}

export interface McpLocalAuthorizationIO {
  createUniqueFile(
    parent: string,
    prefix: string,
    permissions?: number,
  ): Promise<string>;
  exists(path: string): Promise<boolean>;
  isSymbolicLink(path: string): Promise<boolean>;
  makeDirectory(
    path: string,
    options?: {
      createAncestors?: boolean;
      ignoreExisting?: boolean;
      permissions?: number;
    },
  ): Promise<void>;
  move(
    sourcePath: string,
    destinationPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
  read(
    path: string,
    options?: { maxBytes?: number | null },
  ): Promise<Uint8Array>;
  remove(
    path: string,
    options?: { ignoreAbsent?: boolean; recursive?: boolean },
  ): Promise<void>;
  setPermissions(
    path: string,
    permissions: number,
    honorUmask?: boolean,
  ): Promise<void>;
  stat(path: string): Promise<McpLocalAuthorizationFileInfo>;
  write(
    path: string,
    value: Uint8Array,
    options?: { flush?: boolean; mode?: "create" | "overwrite" },
  ): Promise<number>;
}

export interface McpLocalAuthorizationOptions {
  crypto?: Pick<Crypto, "getRandomValues">;
  homeDir?: string;
  io?: McpLocalAuthorizationIO;
  platform?: string;
}

interface McpLocalAuthorizationPaths {
  privateRoot: string;
  mcpDirectory: string;
  keyPath: string;
}

export async function ensureMcpLocalAuthorization(
  options: McpLocalAuthorizationOptions = {},
): Promise<void> {
  const status = await getMcpLocalAuthorizationStatus(options);
  if (status.status === "ready") return;
  if (status.status === "invalid") {
    throw localAuthorizationError(
      status.errorCode ?? "LOCAL_AUTH_KEY_INVALID",
      "The existing local MCP authorization is invalid and was not replaced.",
    );
  }

  const paths = getLocalAuthorizationPaths(options);
  const io = getLocalAuthorizationIO(options);
  const key = generateLocalAuthorizationKey(options);
  let temporaryPath: string | null = null;

  try {
    await ensurePrivateDirectories(paths, options);
    temporaryPath = await io.createUniqueFile(
      paths.mcpDirectory,
      ".local-bridge.key.tmp-",
      PRIVATE_FILE_PERMISSIONS,
    );
    await io.setPermissions(temporaryPath, PRIVATE_FILE_PERMISSIONS, false);
    await io.write(temporaryPath, key, {
      flush: true,
      mode: "overwrite",
    });
    await io.setPermissions(temporaryPath, PRIVATE_FILE_PERMISSIONS, false);
    await io.move(temporaryPath, paths.keyPath, { noOverwrite: true });
    temporaryPath = null;
    await io.setPermissions(paths.keyPath, PRIVATE_FILE_PERMISSIONS, false);
  } catch {
    if (temporaryPath !== null) {
      try {
        await io.remove(temporaryPath, { ignoreAbsent: true });
      } catch {
        // Preserve the original storage failure without disclosing its path.
      }
    }

    // Another caller may have won the no-overwrite move. Accept only a key
    // that independently passes the same strict validation.
    const concurrentStatus = await getMcpLocalAuthorizationStatus(options);
    if (concurrentStatus.status === "ready") return;
    throw localAuthorizationError(
      "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "Unable to create local MCP authorization.",
    );
  } finally {
    key.fill(0);
  }

  const createdStatus = await getMcpLocalAuthorizationStatus(options);
  if (createdStatus.status !== "ready") {
    throw localAuthorizationError(
      createdStatus.errorCode ?? "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "Unable to validate local MCP authorization.",
    );
  }
}

export async function getMcpLocalAuthorizationStatus(
  options: McpLocalAuthorizationOptions = {},
): Promise<McpLocalAuthorizationStatus> {
  let paths: McpLocalAuthorizationPaths;
  let io: McpLocalAuthorizationIO;
  try {
    paths = getLocalAuthorizationPaths(options);
    io = getLocalAuthorizationIO(options);
    await rejectExistingSymbolicLinks(paths, io);
    if (!(await io.exists(paths.keyPath))) {
      return Object.freeze({ status: "missing" });
    }
    await validatePrivateStorage(paths, options);
    const key = await readValidatedKey(paths.keyPath, options);
    key.fill(0);
    return Object.freeze({ status: "ready" });
  } catch (error) {
    return Object.freeze({
      status: "invalid",
      errorCode: statusErrorCode(error),
    });
  }
}

export async function resetMcpLocalAuthorization(
  options: McpLocalAuthorizationOptions = {},
): Promise<void> {
  const paths = getLocalAuthorizationPaths(options);
  try {
    const io = getLocalAuthorizationIO(options);
    await rejectExistingSymbolicLinks(paths, io);
    await io.remove(paths.keyPath, {
      ignoreAbsent: true,
    });
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "Unable to reset local MCP authorization.",
    );
  }
}

export async function readMcpLocalAuthorizationKey(
  options: McpLocalAuthorizationOptions = {},
): Promise<Uint8Array> {
  const paths = getLocalAuthorizationPaths(options);
  const io = getLocalAuthorizationIO(options);
  let exists: boolean;
  try {
    await rejectExistingSymbolicLinks(paths, io);
    exists = await io.exists(paths.keyPath);
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "Local MCP authorization is unavailable.",
    );
  }
  if (!exists) {
    throw localAuthorizationError(
      "LOCAL_AUTH_KEY_MISSING",
      "Local MCP authorization has not been created.",
    );
  }

  await validatePrivateStorage(paths, options);
  return readValidatedKey(paths.keyPath, options);
}

function generateLocalAuthorizationKey(
  options: McpLocalAuthorizationOptions,
): Uint8Array {
  let cryptoApi: Pick<Crypto, "getRandomValues">;
  try {
    cryptoApi =
      options.crypto ??
      (Services.appShell.hiddenDOMWindow as unknown as Window).crypto;
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_CRYPTO_UNAVAILABLE",
      "Secure randomness is unavailable for local MCP authorization.",
    );
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw localAuthorizationError(
      "LOCAL_AUTH_CRYPTO_UNAVAILABLE",
      "Secure randomness is unavailable for local MCP authorization.",
    );
  }

  const key = new Uint8Array(LOCAL_AUTHORIZATION_KEY_BYTES);
  try {
    cryptoApi.getRandomValues(key);
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_CRYPTO_UNAVAILABLE",
      "Unable to generate local MCP authorization.",
    );
  }
  return key;
}

async function ensurePrivateDirectories(
  paths: McpLocalAuthorizationPaths,
  options: McpLocalAuthorizationOptions,
): Promise<void> {
  const io = getLocalAuthorizationIO(options);
  for (const directoryPath of [paths.privateRoot, paths.mcpDirectory]) {
    if (await io.isSymbolicLink(directoryPath)) {
      throw localAuthorizationError(
        "LOCAL_AUTH_STORAGE_UNAVAILABLE",
        "Local MCP authorization storage is invalid.",
      );
    }
    await io.makeDirectory(directoryPath, {
      createAncestors: false,
      ignoreExisting: true,
      permissions: PRIVATE_DIRECTORY_PERMISSIONS,
    });
    if (await io.isSymbolicLink(directoryPath)) {
      throw localAuthorizationError(
        "LOCAL_AUTH_STORAGE_UNAVAILABLE",
        "Local MCP authorization storage is invalid.",
      );
    }
    const info = await io.stat(directoryPath);
    if (info.type !== "directory") {
      throw localAuthorizationError(
        "LOCAL_AUTH_STORAGE_UNAVAILABLE",
        "Local MCP authorization storage is invalid.",
      );
    }
    await io.setPermissions(
      directoryPath,
      PRIVATE_DIRECTORY_PERMISSIONS,
      false,
    );
  }
}

async function validatePrivateStorage(
  paths: McpLocalAuthorizationPaths,
  options: McpLocalAuthorizationOptions,
): Promise<void> {
  const io = getLocalAuthorizationIO(options);
  const checkPermissions = !isWindows(options);

  try {
    for (const directoryPath of [paths.privateRoot, paths.mcpDirectory]) {
      if (await io.isSymbolicLink(directoryPath)) {
        throw new Error("Symbolic private directory");
      }
      const info = await io.stat(directoryPath);
      if (
        info.type !== "directory" ||
        (checkPermissions &&
          (info.permissions === undefined ||
            (info.permissions & 0o777) !== PRIVATE_DIRECTORY_PERMISSIONS))
      ) {
        throw new Error("Invalid private directory");
      }
    }

    if (await io.isSymbolicLink(paths.keyPath)) {
      throw new Error("Symbolic authorization file");
    }
    const keyInfo = await io.stat(paths.keyPath);
    if (
      keyInfo.type !== "regular" ||
      keyInfo.size !== LOCAL_AUTHORIZATION_KEY_BYTES ||
      (checkPermissions &&
        (keyInfo.permissions === undefined ||
          (keyInfo.permissions & 0o777) !== PRIVATE_FILE_PERMISSIONS))
    ) {
      throw new Error("Invalid authorization file");
    }
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_KEY_INVALID",
      "Local MCP authorization storage is invalid.",
    );
  }
}

async function rejectExistingSymbolicLinks(
  paths: McpLocalAuthorizationPaths,
  io: McpLocalAuthorizationIO,
): Promise<void> {
  try {
    for (const candidate of [
      paths.privateRoot,
      paths.mcpDirectory,
      paths.keyPath,
    ]) {
      if (await io.isSymbolicLink(candidate)) {
        throw new Error("Symbolic local authorization path");
      }
    }
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_KEY_INVALID",
      "Local MCP authorization storage is invalid.",
    );
  }
}

async function readValidatedKey(
  keyPath: string,
  options: McpLocalAuthorizationOptions,
): Promise<Uint8Array> {
  let key: Uint8Array | undefined;
  try {
    key = await getLocalAuthorizationIO(options).read(keyPath, {
      maxBytes: LOCAL_AUTHORIZATION_KEY_BYTES + 1,
    });
    if (key.byteLength !== LOCAL_AUTHORIZATION_KEY_BYTES) {
      throw new Error("Invalid key length");
    }
    return key;
  } catch {
    key?.fill(0);
    throw localAuthorizationError(
      "LOCAL_AUTH_KEY_INVALID",
      "The local MCP authorization file is invalid.",
    );
  }
}

function getLocalAuthorizationPaths(
  options: McpLocalAuthorizationOptions,
): McpLocalAuthorizationPaths {
  let homeDir: string;
  try {
    homeDir = options.homeDir ?? Services.dirsvc.get("Home", Ci.nsIFile).path;
  } catch {
    throw localAuthorizationError(
      "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "The home directory for local MCP authorization is unavailable.",
    );
  }
  if (typeof homeDir !== "string" || homeDir.length === 0) {
    throw localAuthorizationError(
      "LOCAL_AUTH_STORAGE_UNAVAILABLE",
      "The home directory for local MCP authorization is unavailable.",
    );
  }

  const privateRoot = PathUtils.join(homeDir, PRIVATE_STORAGE_DIRECTORY);
  const mcpDirectory = PathUtils.join(privateRoot, MCP_STORAGE_DIRECTORY);
  return {
    privateRoot,
    mcpDirectory,
    keyPath: PathUtils.join(mcpDirectory, LOCAL_AUTHORIZATION_FILE),
  };
}

function getLocalAuthorizationIO(
  options: McpLocalAuthorizationOptions,
): McpLocalAuthorizationIO {
  return options.io ?? DEFAULT_LOCAL_AUTHORIZATION_IO;
}

const DEFAULT_LOCAL_AUTHORIZATION_IO: McpLocalAuthorizationIO = {
  createUniqueFile: (parent, prefix, permissions) =>
    IOUtils.createUniqueFile(parent, prefix, permissions),
  exists: (path) => IOUtils.exists(path),
  isSymbolicLink: async (path) => {
    const file = await IOUtils.getFile(path);
    try {
      return file.isSymlink();
    } catch (error) {
      if (!file.exists()) return false;
      throw error;
    }
  },
  makeDirectory: (path, options) => IOUtils.makeDirectory(path, options),
  move: (sourcePath, destinationPath, options) =>
    IOUtils.move(sourcePath, destinationPath, options),
  read: (path, options) => IOUtils.read(path, options),
  remove: (path, options) => IOUtils.remove(path, options),
  setPermissions: (path, permissions, honorUmask) =>
    IOUtils.setPermissions(path, permissions, honorUmask),
  stat: (path) => IOUtils.stat(path),
  write: (path, value, options) => IOUtils.write(path, value, options),
};
Object.freeze(DEFAULT_LOCAL_AUTHORIZATION_IO);

function isWindows(options: McpLocalAuthorizationOptions): boolean {
  return (options.platform ?? Services.appinfo.OS) === "WINNT";
}

function statusErrorCode(error: unknown): McpLocalAuthorizationErrorCode {
  return error instanceof McpLocalAuthorizationError
    ? error.code
    : "LOCAL_AUTH_STORAGE_UNAVAILABLE";
}

function localAuthorizationError(
  code: McpLocalAuthorizationErrorCode,
  message: string,
): McpLocalAuthorizationError {
  return new McpLocalAuthorizationError(code, message);
}
