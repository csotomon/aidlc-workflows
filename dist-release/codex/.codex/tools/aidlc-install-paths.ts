import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { projectionFiles } from "./aidlc-distribution.ts";

export const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function requireVersion(value: string): string {
  if (!STRICT_SEMVER.test(value)) {
    throw new Error(`invalid version "${value}"; expected strict semver (for example 2.5.0)`);
  }
  return value;
}

export function installRoot(): string {
  const explicit = process.env.AIDLC_INSTALL_ROOT?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "aidlc");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "aidlc");
}

export function versionsRoot(): string {
  return join(installRoot(), "versions");
}

export function versionRoot(version: string): string {
  return join(versionsRoot(), requireVersion(version));
}

export function binRoot(): string {
  const explicit = process.env.AIDLC_BIN_DIR?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  return platform() === "win32"
    ? join(installRoot(), "bin")
    : join(homedir(), ".local", "bin");
}

export function machineTransactionRoot(): string {
  const paths = [installRoot(), binRoot()].map((path) => resolve(path));
  const filesystemRoot = parse(paths[0]).root;
  if (paths.some((path) => parse(path).root !== filesystemRoot)) {
    throw new Error("machine install and command directories must be on one filesystem root");
  }
  const parts = paths.map((path) =>
    path.slice(filesystemRoot.length).split(/[\\/]/).filter(Boolean)
  );
  const shared: string[] = [];
  for (let index = 0; index < Math.min(...parts.map((value) => value.length)); index++) {
    if (parts.some((value) => value[index] !== parts[0][index])) break;
    shared.push(parts[0][index]);
  }
  const common = join(filesystemRoot, ...shared);
  if (common === filesystemRoot) {
    throw new Error("machine install and command directories need a writable shared parent");
  }
  return common;
}

export function commandPath(): string {
  return join(binRoot(), platform() === "win32" ? "aidlc.cmd" : "aidlc");
}

export function packageManagerForExecutable(
  executable: string,
): { name: string; remediation: string } | null {
  let path = resolve(executable);
  try {
    path = realpathSync(path);
  } catch {
    // A missing executable is not manager-owned.
  }
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.includes("/Cellar/") ||
    normalized.startsWith("/opt/homebrew/") ||
    normalized.startsWith("/home/linuxbrew/.linuxbrew/")
  ) {
    return { name: "Homebrew", remediation: "brew upgrade aidlc" };
  }
  if (normalized.startsWith("/nix/store/") || normalized.includes("/.nix-profile/")) {
    return { name: "Nix", remediation: "upgrade aidlc through Nix" };
  }
  return null;
}

export function activeVersionPath(): string {
  return join(installRoot(), "active-version");
}

export function rollbackVersionPath(): string {
  return join(installRoot(), "rollback-version");
}

export function readVersionMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return STRICT_SEMVER.test(value) ? value : null;
}

export function activeVersion(): string | null {
  for (const candidatePath of [process.execPath, commandPath()]) {
    try {
      const executable = realpathSync(candidatePath);
      const parent = dirname(executable);
      const candidate = basename(parent);
      if (dirname(parent) === realpathOrResolved(versionsRoot()) && STRICT_SEMVER.test(candidate)) {
        return candidate;
      }
    } catch {
      // The command link does not exist before the first install.
    }
  }
  return readVersionMarker(activeVersionPath());
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function runtimeRoot(version: string): string {
  return join(versionRoot(version), "runtime");
}

export function installedExecutablePath(version: string): string {
  return join(versionRoot(version), platform() === "win32" ? "aidlc.exe" : "aidlc");
}

export function inspectInstalledVersion(
  version: string,
  requiredDistribution?: string | null,
): { complete: boolean; distributions: string[]; reason?: string } {
  requireVersion(version);
  const executable = installedExecutablePath(version);
  const manifestPath = join(versionRoot(version), "version.json");
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    return { complete: false, distributions: [], reason: "executable is missing" };
  }
  if (platform() !== "win32" && (statSync(executable).mode & 0o111) === 0) {
    return { complete: false, distributions: [], reason: "executable mode is invalid" };
  }
  let manifest: {
    schemaVersion?: unknown;
    version?: unknown;
    distributions?: unknown;
    assets?: unknown;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as typeof manifest;
  } catch {
    return { complete: false, distributions: [], reason: "version.json is missing or malformed" };
  }
  if (manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.assets)) {
    return { complete: false, distributions: [], reason: "version.json identity is invalid" };
  }
  const binaryName = `aidlc-${targetTriple()}${platform() === "win32" ? ".exe" : ""}`;
  const binary = manifest.assets.find((asset): asset is { name: string; sha256: string } =>
    Boolean(asset) &&
    typeof asset === "object" &&
    (asset as { name?: unknown }).name === binaryName &&
    /^[a-f0-9]{64}$/.test(String((asset as { sha256?: unknown }).sha256 ?? ""))
  );
  if (
    !binary ||
    createHash("sha256").update(readFileSync(executable)).digest("hex") !== binary.sha256
  ) {
    return { complete: false, distributions: [], reason: "executable does not match version.json" };
  }
  const runtime = runtimeRoot(version);
  if (!existsSync(runtime)) {
    return { complete: false, distributions: [], reason: "runtime directory is missing" };
  }
  const declared = new Set(
    Array.isArray(manifest.distributions)
      ? manifest.distributions.flatMap((entry) =>
          entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
            ? [(entry as { name: string }).name]
            : []
        )
      : [],
  );
  const distributions: string[] = [];
  try {
    for (const distribution of readdirSync(runtime).sort()) {
      const root = join(runtime, distribution);
      if (!statSync(root).isDirectory() || !declared.has(distribution)) {
        return { complete: false, distributions, reason: `runtime ${distribution} is not declared` };
      }
      const { stamp } = projectionFiles(root);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        return { complete: false, distributions, reason: `runtime ${distribution} stamp is invalid` };
      }
      distributions.push(distribution);
    }
  } catch (error) {
    return {
      complete: false,
      distributions,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (distributions.length === 0) {
    return { complete: false, distributions, reason: "no harness runtime is installed" };
  }
  if (requiredDistribution && !distributions.includes(requiredDistribution)) {
    return {
      complete: false,
      distributions,
      reason: `${requiredDistribution} runtime is not installed`,
    };
  }
  return { complete: true, distributions };
}

export function targetTriple(): string {
  const os = platform() === "darwin" ? "darwin" : platform() === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const libc = process.env.AIDLC_LIBC?.trim().toLowerCase() ||
    (os === "linux" && !report?.header?.glibcVersionRuntime ? "musl" : "glibc");
  return `${os}-${arch}${os === "linux" && libc === "musl" ? "-musl" : ""}`;
}

export function projectDirFrom(argv: readonly string[]): string {
  const index = argv.indexOf("--project-dir");
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  const value = explicit || process.env.AIDLC_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR || process.env.KIRO_PROJECT_DIR;
  return value ? (isAbsolute(value) ? value : resolve(process.cwd(), value)) : process.cwd();
}
