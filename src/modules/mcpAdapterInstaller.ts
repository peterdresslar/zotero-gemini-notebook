import { config, version as packageVersion } from "../../package.json";

const PRIVATE_STORAGE_DIRECTORY = ".zotero-gemini-notebook";
const MCP_STORAGE_DIRECTORY = "mcp";
const MCP_ADAPTERS_DIRECTORY = "adapters";
const MCP_ADAPTER_MANIFEST_FILE = ".zgn-adapter-manifest.json";
const MCP_ADAPTER_MANIFEST_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_PERMISSIONS = 0o700;
const PRIVATE_FILE_PERMISSIONS = 0o600;
const MAX_RUNTIME_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_BUNDLE_BYTES = 4 * 1024 * 1024;

export const MCP_ADAPTER_RUNTIME_FILES = Object.freeze([
  "server.py",
  "zotero_control.py",
  "zotero_jobs.py",
  "zotero_status.py",
  "pyproject.toml",
  "uv.lock",
] as const);

type McpAdapterRuntimeFile = (typeof MCP_ADAPTER_RUNTIME_FILES)[number];

export type McpAdapterInstallerErrorCode =
  | "MCP_ADAPTER_CRYPTO_UNAVAILABLE"
  | "MCP_ADAPTER_INSTALL_CONFLICT"
  | "MCP_ADAPTER_RESOURCE_UNAVAILABLE"
  | "MCP_ADAPTER_STORAGE_UNAVAILABLE";

export class McpAdapterInstallerError extends Error {
  readonly code: McpAdapterInstallerErrorCode;

  constructor(code: McpAdapterInstallerErrorCode, message: string) {
    super(message);
    this.name = "McpAdapterInstallerError";
    this.code = code;
  }
}

interface McpAdapterFileInfo {
  permissions?: number;
  size?: number;
  type?: "directory" | "other" | "regular";
}

export interface McpAdapterInstallerIO {
  createUniqueDirectory(
    parent: string,
    prefix: string,
    permissions?: number,
  ): Promise<string>;
  exists(path: string): Promise<boolean>;
  getChildren(path: string): Promise<string[]>;
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
  stat(path: string): Promise<McpAdapterFileInfo>;
  write(
    path: string,
    value: Uint8Array,
    options?: { flush?: boolean; mode?: "create" | "overwrite" },
  ): Promise<number>;
}

export type McpAdapterResourceReader = (
  filename: McpAdapterRuntimeFile,
  resourceURL: string,
) => Promise<Uint8Array>;

export interface McpAdapterInstallerOptions {
  crypto?: Pick<Crypto, "subtle">;
  homeDir?: string;
  io?: McpAdapterInstallerIO;
  platform?: string;
  pluginVersion?: string;
  resourceReader?: McpAdapterResourceReader;
}

export type McpAdapterInstallation = Readonly<{
  projectPath: string;
  serverPath: string;
}>;

interface PreparedRuntimeFile {
  bytes: Uint8Array;
  name: McpAdapterRuntimeFile;
  sha256: string;
  size: number;
}

interface PreparedAdapterBundle {
  contentHash: string;
  files: PreparedRuntimeFile[];
  manifestBytes: Uint8Array;
  pluginVersion: string;
}

interface McpAdapterInstallationPaths {
  adaptersDirectory: string;
  mcpDirectory: string;
  privateRoot: string;
  projectPath: string;
  serverPath: string;
}

export async function installBundledMcpAdapter(
  options: McpAdapterInstallerOptions = {},
): Promise<McpAdapterInstallation> {
  const bundle = await prepareAdapterBundle(options);
  const paths = getInstallationPaths(bundle, options);
  const io = getInstallerIO(options);
  let temporaryPath: string | null = null;
  let temporaryPrefix: string | null = null;

  try {
    await rejectSymbolicPaths(paths, io);
    await ensurePrivateDirectories(paths, options);

    if (await io.exists(paths.projectPath)) {
      await validateExistingInstallation(paths, bundle, options);
      return installationResult(paths);
    }

    temporaryPrefix = `.${bundle.pluginVersion}-${bundle.contentHash}.tmp-`;
    const candidatePath = await io.createUniqueDirectory(
      paths.adaptersDirectory,
      temporaryPrefix,
      PRIVATE_DIRECTORY_PERMISSIONS,
    );
    assertTemporaryPath(
      paths.adaptersDirectory,
      candidatePath,
      temporaryPrefix,
    );
    temporaryPath = candidatePath;
    await validateDirectory(temporaryPath, options);
    await writeStagedInstallation(temporaryPath, bundle, options);
    await validateInstallationDirectory(temporaryPath, bundle, options);

    try {
      await io.move(temporaryPath, paths.projectPath, { noOverwrite: true });
      temporaryPath = null;
    } catch {
      // A concurrent explicit install may have published the same immutable
      // bundle. Accept it only after byte-for-byte validation.
      try {
        await validateInstallationDirectory(paths.projectPath, bundle, options);
        return installationResult(paths);
      } catch {
        throw adapterInstallerError(
          "MCP_ADAPTER_INSTALL_CONFLICT",
          "An incompatible MCP adapter installation already exists.",
        );
      }
    }

    await validateInstallationDirectory(paths.projectPath, bundle, options);
    return installationResult(paths);
  } catch (error) {
    if (error instanceof McpAdapterInstallerError) throw error;
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "Unable to install the bundled MCP adapter.",
    );
  } finally {
    if (temporaryPath !== null) {
      await removeOwnedTemporaryDirectory(
        paths.adaptersDirectory,
        temporaryPath,
        temporaryPrefix,
        io,
      );
    }
  }
}

async function prepareAdapterBundle(
  options: McpAdapterInstallerOptions,
): Promise<PreparedAdapterBundle> {
  const pluginVersion = validatePluginVersion(
    options.pluginVersion ?? packageVersion,
  );
  const reader = options.resourceReader ?? readBundledResource;
  const cryptoApi = getCrypto(options);
  const files: PreparedRuntimeFile[] = [];
  let totalBytes = 0;

  for (const filename of MCP_ADAPTER_RUNTIME_FILES) {
    let value: Uint8Array;
    try {
      value = await reader(filename, bundledResourceURL(filename));
    } catch {
      throw adapterInstallerError(
        "MCP_ADAPTER_RESOURCE_UNAVAILABLE",
        "A bundled MCP adapter resource is unavailable.",
      );
    }
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength === 0 ||
      value.byteLength > MAX_RUNTIME_FILE_BYTES
    ) {
      throw adapterInstallerError(
        "MCP_ADAPTER_RESOURCE_UNAVAILABLE",
        "A bundled MCP adapter resource is invalid.",
      );
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RUNTIME_BUNDLE_BYTES) {
      throw adapterInstallerError(
        "MCP_ADAPTER_RESOURCE_UNAVAILABLE",
        "The bundled MCP adapter is invalid.",
      );
    }
    const bytes = Uint8Array.from(value);
    files.push({
      bytes,
      name: filename,
      sha256: await sha256Hex(bytes, cryptoApi),
      size: bytes.byteLength,
    });
  }

  const contentHash = await sha256Hex(
    encodeUTF8(
      JSON.stringify({
        schemaVersion: MCP_ADAPTER_MANIFEST_SCHEMA_VERSION,
        files: files.map(({ name, sha256, size }) => ({ name, sha256, size })),
      }),
    ),
    cryptoApi,
  );
  const manifestBytes = encodeUTF8(
    `${JSON.stringify({
      schemaVersion: MCP_ADAPTER_MANIFEST_SCHEMA_VERSION,
      pluginVersion,
      contentHash,
      files: files.map(({ name, sha256, size }) => ({ name, sha256, size })),
    })}\n`,
  );

  return { contentHash, files, manifestBytes, pluginVersion };
}

function getInstallationPaths(
  bundle: PreparedAdapterBundle,
  options: McpAdapterInstallerOptions,
): McpAdapterInstallationPaths {
  let homeDir: string;
  try {
    homeDir = options.homeDir ?? Services.dirsvc.get("Home", Ci.nsIFile).path;
  } catch {
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "The home directory for the MCP adapter is unavailable.",
    );
  }
  if (
    typeof homeDir !== "string" ||
    homeDir.length === 0 ||
    !PathUtils.isAbsolute(homeDir)
  ) {
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "The home directory for the MCP adapter is unavailable.",
    );
  }

  const privateRoot = PathUtils.join(homeDir, PRIVATE_STORAGE_DIRECTORY);
  const mcpDirectory = PathUtils.join(privateRoot, MCP_STORAGE_DIRECTORY);
  const adaptersDirectory = PathUtils.join(
    mcpDirectory,
    MCP_ADAPTERS_DIRECTORY,
  );
  const projectPath = PathUtils.join(
    adaptersDirectory,
    `${bundle.pluginVersion}-${bundle.contentHash}`,
  );
  return {
    privateRoot,
    mcpDirectory,
    adaptersDirectory,
    projectPath,
    serverPath: PathUtils.join(projectPath, "server.py"),
  };
}

async function rejectSymbolicPaths(
  paths: McpAdapterInstallationPaths,
  io: McpAdapterInstallerIO,
): Promise<void> {
  for (const candidate of [
    paths.privateRoot,
    paths.mcpDirectory,
    paths.adaptersDirectory,
    paths.projectPath,
  ]) {
    if (await io.isSymbolicLink(candidate)) {
      throw adapterInstallerError(
        "MCP_ADAPTER_STORAGE_UNAVAILABLE",
        "The MCP adapter storage path is invalid.",
      );
    }
  }
}

async function ensurePrivateDirectories(
  paths: McpAdapterInstallationPaths,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  const io = getInstallerIO(options);
  for (const directoryPath of [
    paths.privateRoot,
    paths.mcpDirectory,
    paths.adaptersDirectory,
  ]) {
    if (await io.isSymbolicLink(directoryPath)) {
      throw adapterInstallerError(
        "MCP_ADAPTER_STORAGE_UNAVAILABLE",
        "The MCP adapter storage path is invalid.",
      );
    }
    await io.makeDirectory(directoryPath, {
      createAncestors: false,
      ignoreExisting: true,
      permissions: PRIVATE_DIRECTORY_PERMISSIONS,
    });
    if (await io.isSymbolicLink(directoryPath)) {
      throw adapterInstallerError(
        "MCP_ADAPTER_STORAGE_UNAVAILABLE",
        "The MCP adapter storage path is invalid.",
      );
    }
    if (!isWindows(options)) {
      await io.setPermissions(
        directoryPath,
        PRIVATE_DIRECTORY_PERMISSIONS,
        false,
      );
    }
    await validateDirectory(directoryPath, options);
  }
}

async function writeStagedInstallation(
  directoryPath: string,
  bundle: PreparedAdapterBundle,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  for (const file of bundle.files) {
    await writePrivateFile(
      PathUtils.join(directoryPath, file.name),
      file.bytes,
      options,
    );
  }
  // The manifest is deliberately written last. The staging directory is not
  // ready for publication without this exact readiness record.
  await writePrivateFile(
    PathUtils.join(directoryPath, MCP_ADAPTER_MANIFEST_FILE),
    bundle.manifestBytes,
    options,
  );
}

async function writePrivateFile(
  path: string,
  bytes: Uint8Array,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  const io = getInstallerIO(options);
  if (await io.isSymbolicLink(path)) {
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "The MCP adapter staging path is invalid.",
    );
  }
  const written = await io.write(path, bytes, {
    flush: true,
    mode: "create",
  });
  if (written !== bytes.byteLength || (await io.isSymbolicLink(path))) {
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "Unable to write the bundled MCP adapter.",
    );
  }
  if (!isWindows(options)) {
    await io.setPermissions(path, PRIVATE_FILE_PERMISSIONS, false);
  }
}

async function validateExistingInstallation(
  paths: McpAdapterInstallationPaths,
  bundle: PreparedAdapterBundle,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  try {
    await validateInstallationDirectory(paths.projectPath, bundle, options);
  } catch {
    throw adapterInstallerError(
      "MCP_ADAPTER_INSTALL_CONFLICT",
      "An incompatible MCP adapter installation already exists.",
    );
  }
}

async function validateInstallationDirectory(
  directoryPath: string,
  bundle: PreparedAdapterBundle,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  const io = getInstallerIO(options);
  await validateDirectory(directoryPath, options);
  await validateTopLevelEntries(directoryPath, io);
  await validateFile(
    PathUtils.join(directoryPath, MCP_ADAPTER_MANIFEST_FILE),
    bundle.manifestBytes,
    options,
  );
  for (const file of bundle.files) {
    await validateFile(
      PathUtils.join(directoryPath, file.name),
      file.bytes,
      options,
    );
  }

  // Recheck the directory after all reads to reject a path swapped during
  // validation. The private parent limits the remaining same-user race.
  if (await io.isSymbolicLink(directoryPath)) {
    throw new Error("Symbolic MCP adapter directory");
  }
  await validateDirectory(directoryPath, options);
}

async function validateTopLevelEntries(
  directoryPath: string,
  io: McpAdapterInstallerIO,
): Promise<void> {
  const managedNames = new Set<string>([
    ...MCP_ADAPTER_RUNTIME_FILES,
    MCP_ADAPTER_MANIFEST_FILE,
  ]);
  for (const childPath of await io.getChildren(directoryPath)) {
    const childName = PathUtils.filename(childPath);
    if (PathUtils.parent(childPath) !== directoryPath) {
      throw new Error("Invalid MCP adapter child path");
    }
    if (managedNames.has(childName)) continue;
    throw new Error("Unexpected MCP adapter file");
  }
}

async function validateDirectory(
  path: string,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  const io = getInstallerIO(options);
  if (await io.isSymbolicLink(path)) {
    throw new Error("Symbolic MCP adapter directory");
  }
  const info = await io.stat(path);
  if (
    info.type !== "directory" ||
    (!isWindows(options) &&
      (info.permissions === undefined ||
        (info.permissions & 0o777) !== PRIVATE_DIRECTORY_PERMISSIONS))
  ) {
    throw new Error("Invalid MCP adapter directory");
  }
}

async function validateFile(
  path: string,
  expected: Uint8Array,
  options: McpAdapterInstallerOptions,
): Promise<void> {
  const io = getInstallerIO(options);
  if (await io.isSymbolicLink(path)) {
    throw new Error("Symbolic MCP adapter file");
  }
  const info = await io.stat(path);
  if (
    info.type !== "regular" ||
    info.size !== expected.byteLength ||
    (!isWindows(options) &&
      (info.permissions === undefined ||
        (info.permissions & 0o777) !== PRIVATE_FILE_PERMISSIONS))
  ) {
    throw new Error("Invalid MCP adapter file");
  }
  const actual = await io.read(path, { maxBytes: expected.byteLength + 1 });
  if (!equalBytes(actual, expected) || (await io.isSymbolicLink(path))) {
    throw new Error("Invalid MCP adapter file");
  }
}

function assertTemporaryPath(
  parent: string,
  temporaryPath: string,
  prefix: string,
): void {
  if (
    PathUtils.parent(temporaryPath) !== parent ||
    !PathUtils.filename(temporaryPath).startsWith(prefix)
  ) {
    throw adapterInstallerError(
      "MCP_ADAPTER_STORAGE_UNAVAILABLE",
      "Unable to create a private MCP adapter staging directory.",
    );
  }
}

async function removeOwnedTemporaryDirectory(
  parent: string,
  temporaryPath: string,
  prefix: string | null,
  io: McpAdapterInstallerIO,
): Promise<void> {
  try {
    if (
      prefix === null ||
      PathUtils.parent(temporaryPath) !== parent ||
      !PathUtils.filename(temporaryPath).startsWith(prefix) ||
      (await io.isSymbolicLink(temporaryPath))
    ) {
      return;
    }
    await io.remove(temporaryPath, {
      ignoreAbsent: true,
      recursive: true,
    });
  } catch {
    // Preserve the original installation failure without exposing its path.
  }
}

function installationResult(
  paths: McpAdapterInstallationPaths,
): McpAdapterInstallation {
  return Object.freeze({
    projectPath: paths.projectPath,
    serverPath: paths.serverPath,
  });
}

function bundledResourceURL(filename: McpAdapterRuntimeFile): string {
  return `chrome://${config.addonRef}/content/mcp-adapter/${filename}`;
}

async function readBundledResource(
  _filename: McpAdapterRuntimeFile,
  resourceURL: string,
): Promise<Uint8Array> {
  const hiddenWindow = Services.appShell.hiddenDOMWindow as unknown as Window;
  const response = await hiddenWindow.fetch(resourceURL);
  if (!response.ok && response.status !== 0) {
    throw new Error("Bundled resource unavailable");
  }
  return new Uint8Array(await response.arrayBuffer());
}

function getCrypto(
  options: McpAdapterInstallerOptions,
): Pick<Crypto, "subtle"> {
  let cryptoApi: Pick<Crypto, "subtle">;
  try {
    cryptoApi =
      options.crypto ??
      (Services.appShell.hiddenDOMWindow as unknown as Window).crypto;
  } catch {
    throw adapterInstallerError(
      "MCP_ADAPTER_CRYPTO_UNAVAILABLE",
      "SHA-256 is unavailable for the bundled MCP adapter.",
    );
  }
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== "function") {
    throw adapterInstallerError(
      "MCP_ADAPTER_CRYPTO_UNAVAILABLE",
      "SHA-256 is unavailable for the bundled MCP adapter.",
    );
  }
  return cryptoApi;
}

async function sha256Hex(
  value: Uint8Array,
  cryptoApi: Pick<Crypto, "subtle">,
): Promise<string> {
  try {
    const digest = await cryptoApi.subtle.digest("SHA-256", value);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    throw adapterInstallerError(
      "MCP_ADAPTER_CRYPTO_UNAVAILABLE",
      "Unable to hash the bundled MCP adapter.",
    );
  }
}

function validatePluginVersion(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value)
  ) {
    throw adapterInstallerError(
      "MCP_ADAPTER_RESOURCE_UNAVAILABLE",
      "The bundled MCP adapter version is invalid.",
    );
  }
  return value;
}

function encodeUTF8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function getInstallerIO(
  options: McpAdapterInstallerOptions,
): McpAdapterInstallerIO {
  return options.io ?? DEFAULT_INSTALLER_IO;
}

const DEFAULT_INSTALLER_IO: McpAdapterInstallerIO = {
  createUniqueDirectory: (parent, prefix, permissions) =>
    IOUtils.createUniqueDirectory(parent, prefix, permissions),
  exists: (path) => IOUtils.exists(path),
  getChildren: (path) => IOUtils.getChildren(path),
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
Object.freeze(DEFAULT_INSTALLER_IO);

function isWindows(options: McpAdapterInstallerOptions): boolean {
  const platform = options.platform ?? Services.appinfo.OS;
  return platform === "WINNT" || platform === "win32";
}

function adapterInstallerError(
  code: McpAdapterInstallerErrorCode,
  message: string,
): McpAdapterInstallerError {
  return new McpAdapterInstallerError(code, message);
}
