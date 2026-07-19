#!/usr/bin/env bun
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  EXIT,
  type CommandResult,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
  valuesAfter,
} from "./aidlc-command.ts";
import {
  projectionFiles,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  activeExecutablePath,
  activeVersionPath,
  commandPath,
  installedExecutablePath,
  inspectInstalledVersion,
  installRoot,
  machineTransactionRoot,
  packageManagerForExecutable,
  projectDirFrom,
  requireVersion,
  readActiveExecutable,
  rollbackVersionPath,
  runtimeRoot,
  targetTriple,
  versionRoot,
  versionsRoot,
} from "./aidlc-install-paths.ts";
import {
  defaultHarnessPath,
  machineConfigPath,
  updateCachePath,
} from "./aidlc-machine-config.ts";
import {
  acquireRelease,
  copyReleaseSubset,
  digest,
  type ReleaseManifest,
  ReleaseUnavailableError,
  verifyReleaseDirectory,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { cachedUpdateNotice, refreshUpdateState } from "./aidlc-update.ts";
import {
  recoverWindowsUninstallContinuations,
  scheduleWindowsUninstall as scheduleWindowsUninstallContinuation,
} from "./aidlc-windows-uninstall.ts";
import {
  discoverProjectHarnesses,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";

class LifecycleCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "LifecycleCommandError";
  }
}

function commandError(message: string, exitCode: number): never {
  throw new LifecycleCommandError(message, exitCode);
}

function requestedVersion(value: string): string {
  try {
    return requireVersion(value);
  } catch (error) {
    return commandError(
      error instanceof Error ? error.message : String(error),
      EXIT.usage,
    );
  }
}

function stripVerb(argv: string[]): string[] {
  return argv[0] === "update" ? ["upgrade", ...argv.slice(1)] : argv;
}

function offline(argv: readonly string[]): boolean | undefined {
  if (argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1") return true;
  if (process.env.AIDLC_OFFLINE === "0") return false;
  return undefined;
}

function dataAsset(distribution: string): string {
  return `aidlc-data-${distribution}.tgz`;
}

function binaryAsset(target = targetTriple()): string {
  return `aidlc-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

function installedDistributions(version: string): string[] {
  const root = runtimeRoot(version);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => {
    try {
      projectionFiles(join(root, entry));
      return true;
    } catch {
      return false;
    }
  }).sort();
}

function completeVersion(version: string): boolean {
  try {
    return inspectInstalledVersion(version).complete;
  } catch {
    return false;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeHarness(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    commandError(`invalid harness name: ${value}`, EXIT.usage);
  }
  return value;
}

function requireConfirmation(argv: readonly string[], message: string): void {
  if (argv.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    commandError(`${message}; non-interactive use requires --yes`, EXIT.usage);
  }
  const answer = prompt(`${message}\nContinue [y/N]:`);
  if (!/^y(?:es)?$/i.test(answer?.trim() ?? "")) {
    commandError("operation cancelled", EXIT.failure);
  }
}

function installedManifest(version: string): ReleaseManifest {
  const path = join(versionRoot(version), "version.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ReleaseManifest;
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function productName(manifest: ReleaseManifest, distribution: string): string {
  return manifest.distributions.find((item) => item.name === distribution)?.productName ??
    distribution;
}

function windowsLauncherOwnedByInstaller(): boolean {
  try {
    return readFileSync(commandPath(), "utf-8") === windowsShim() &&
      readFileSync(windowsShimPath(), "utf-8") === windowsShimHelper();
  } catch {
    return false;
  }
}

function commandOwnedByInstaller(version: string): boolean {
  try {
    if (process.platform === "win32") {
      return windowsLauncherOwnedByInstaller() &&
        readActiveExecutable() === resolve(installedExecutablePath(version));
    }
    return lstatSync(commandPath()).isSymbolicLink() &&
      realpathSync(commandPath()) === realpathSync(installedExecutablePath(version));
  } catch {
    return false;
  }
}

function registeredPins(strict = false): {
  pins: Record<string, string>;
  warnings: string[];
} {
  const path = join(installRoot(), "pins.json");
  if (!existsSync(path)) return { pins: {}, warnings: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const warning = `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const warning = `${path} must contain a project-to-version object`;
    if (strict) commandError(warning, EXIT.integrity);
    return { pins: {}, warnings: [warning] };
  }
  const pins: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [project, version] of Object.entries(value as Record<string, unknown>)) {
    if (!isAbsolute(project) || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      warnings.push(`${path} contains an invalid pin entry for ${project}`);
      continue;
    }
    pins[project] = version;
  }
  if (strict && warnings.length > 0) commandError(warnings.join("; "), EXIT.integrity);
  return { pins, warnings };
}

function treesMatch(left: string, right: string): boolean {
  const leftFiles = walkFiles(left).map((path) => path.replaceAll("\\", "/"));
  const rightFiles = walkFiles(right).map((path) => path.replaceAll("\\", "/"));
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every((path) =>
    sha256File(join(left, path)) === sha256File(join(right, path)) &&
    (statSync(join(left, path)).mode & 0o777) === (statSync(join(right, path)).mode & 0o777)
  );
}

function retainedVersions(): {
  versions: Array<{
    version: string;
    active: boolean;
    rollback: boolean;
    distributions: string[];
    complete: boolean;
    pinPaths: string[];
    stalePinPaths: string[];
  }>;
  pinWarnings: string[];
} {
  const { pins, warnings } = registeredPins();
  if (!existsSync(versionsRoot())) return { versions: [], pinWarnings: warnings };
  const active = activeVersion();
  const rollback = existsSync(rollbackVersionPath())
    ? readFileSync(rollbackVersionPath(), "utf-8").trim()
    : null;
  const versions = readdirSync(versionsRoot()).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort()
    .map((version) => ({
      version,
      active: version === active,
      rollback: version === rollback,
      distributions: installedDistributions(version),
      complete: completeVersion(version),
      pinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && existsSync(project))
        .map(([project]) => project)
        .sort(),
      stalePinPaths: Object.entries(pins)
        .filter(([project, pinnedVersion]) => pinnedVersion === version && !existsSync(project))
        .map(([project]) => project)
        .sort(),
    }));
  return { versions, pinWarnings: warnings };
}

function projectDistribution(projectDir: string): string | null {
  const harnessDir = runtimeHarnessDir(projectDir);
  return discoverProjectHarnesses(projectDir)
    .find((candidate) => candidate.harnessDir === harnessDir)?.distribution ?? null;
}

export function activate(version: string, options: { failAfter?: number } = {}): void {
  if (!completeVersion(version)) {
    commandError(`retained version ${version} is incomplete`, EXIT.unavailable);
  }
  const previous = activeVersion();
  const root = machineTransactionRoot();
  const target = installedExecutablePath(version);
  const windows = process.platform === "win32";
  const shim = windows ? windowsShim() : null;
  const shimHelper = windows ? windowsShimHelper() : null;
  if (
    pathEntryExists(commandPath()) &&
    (!previous ||
      !(windows
        ? windowsLauncherOwnedByInstaller()
        : commandOwnedByInstaller(previous)))
  ) {
    commandError(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  if (windows && existsSync(commandPath()) && readFileSync(commandPath(), "utf-8") !== shim) {
    commandError("existing aidlc.cmd is not owned by this AI-DLC install", EXIT.integrity);
  }
  if (
    windows &&
    existsSync(windowsShimPath()) &&
    readFileSync(windowsShimPath(), "utf-8") !== shimHelper
  ) {
    commandError("existing aidlc-shim.ps1 is not owned by this AI-DLC install", EXIT.integrity);
  }
  const operations = [
    ...(previous && previous !== version
      ? [writeOperation(relative(root, rollbackVersionPath()), `${previous}\n`,
          transactionState(rollbackVersionPath()))]
      : []),
    writeOperation(
      relative(root, activeVersionPath()),
      `${version}\n`,
      transactionState(activeVersionPath()),
    ),
    ...(windows
      ? [
          ...(!existsSync(windowsShimPath())
            ? [writeOperation(
                relative(root, windowsShimPath()),
                shimHelper as string,
                "absent",
                0o700,
              )]
            : []),
          ...(!existsSync(commandPath())
            ? [writeOperation(
                relative(root, commandPath()),
                shim as string,
                "absent",
                0o700,
              )]
            : []),
          writeOperation(
            relative(root, activeExecutablePath()),
            `${target}\r\n`,
            transactionState(activeExecutablePath()),
            0o600,
          ),
        ]
      : [{
          kind: "symlink" as const,
          path: relative(root, commandPath()),
          target,
          expected: transactionState(commandPath()),
        }]),
  ];
  executePlan({
    schemaVersion: 1,
    root,
    operations,
  }, {
    ...options,
    validateCommitted: () => {
      if (
        windows
          ? readActiveExecutable() !== resolve(target)
          : realpathSync(commandPath()) !== realpathSync(target)
      ) {
        throw new Error(`command pointer validation failed for ${version}`);
      }
      const probe = Bun.spawnSync([commandPath(), "version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Buffer.from(probe.stdout ?? new Uint8Array()).toString("utf-8").trim();
      if (probe.exitCode !== 0 || output !== `aidlc ${version}`) {
        throw new Error(
          `command pointer validation failed for ${version}: version probe returned ${
            probe.exitCode ?? "no exit"
          } ${JSON.stringify(output)}`,
        );
      }
    },
  });
}

function windowsShim(): string {
  const helper = windowsShimPath().replaceAll("%", "%%");
  return [
    "@echo off",
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function windowsShimPath(): string {
  return join(installRoot(), "aidlc-shim.ps1");
}

function windowsShimHelper(): string {
  const pointer = activeExecutablePath().replaceAll("'", "''");
  const root = versionsRoot().replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pointer = '${pointer}'`,
    `$versions = [IO.Path]::GetFullPath('${root}')`,
    "try {",
    "  $raw = [IO.File]::ReadAllText($pointer)",
    "  if ($raw -notmatch '^[^\\r\\n]+\\r?\\n?$') { exit 4 }",
    "  $executable = [IO.Path]::GetFullPath($raw.TrimEnd(\"`r\", \"`n\"))",
    "  $prefix = $versions.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "  if (-not $executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { exit 4 }",
    "  $relative = $executable.Substring($prefix.Length)",
    "  if ($relative -notmatch '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\\\aidlc\\.exe$') { exit 4 }",
    "  if (-not [IO.File]::Exists($executable)) { exit 4 }",
    "  $env:AIDLC_SHIM_PID = [string]$PID",
    "  & $executable @args",
    "  exit $LASTEXITCODE",
    "} catch {",
    "  exit 4",
    "}",
    "",
  ].join("\r\n");
}

async function installVersion(options: {
  version?: string;
  distributions: string[];
  from?: string;
  offline?: boolean;
  activate: boolean;
  dryRun: boolean;
  allowNoDistributions?: boolean;
  baseUrl?: string;
  caBundle?: string;
}): Promise<{ version: string; distributions: string[] }> {
  const wantedVersion = options.version ? requestedVersion(options.version) : undefined;
  if (options.distributions.length === 0 && !options.allowNoDistributions) {
    commandError("at least one --harness is required", EXIT.usage);
  }
  const target = targetTriple();
  const required = [binaryAsset(target), ...options.distributions.map(dataAsset)];
  const release = await acquireRelease({
    version: wantedVersion,
    from: options.from,
    names: required,
    offline: options.offline,
    baseUrl: options.baseUrl,
    caBundle: options.caBundle,
  });
  const version = release.manifest.version;
  const temporary = mkdtempSync(join(tmpdir(), `aidlc-version-${version}-`));
  try {
    const candidate = join(temporary, version);
    mkdirSync(join(candidate, "runtime"), { recursive: true });
    const binarySource = join(release.directory, binaryAsset(target));
    const candidateExecutable = join(
      candidate,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    writeFileSync(candidateExecutable, readFileSync(binarySource), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(candidateExecutable, 0o755);
    for (const distribution of options.distributions) {
      const destination = join(candidate, "runtime", distribution);
      extractTarGz(join(release.directory, dataAsset(distribution)), destination);
      const { stamp } = projectionFiles(destination);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        throw new Error(`${distribution} archive stamp does not match release ${version}`);
      }
    }
    writeFileSync(
      join(candidate, "version.json"),
      `${JSON.stringify(release.manifest, null, 2)}\n`,
    );
    if (!options.dryRun) {
      const destination = versionRoot(version);
      if (existsSync(destination)) {
        const priorManifestPath = join(destination, "version.json");
        if (!existsSync(priorManifestPath)) {
          throw new Error(`existing ${version} install has no release manifest`);
        }
        const priorManifest = JSON.parse(readFileSync(priorManifestPath, "utf-8")) as {
          assets?: Array<{ name: string; sha256: string }>;
        };
        const expectedAssets = new Map(
          release.manifest.assets.map((asset) => [asset.name, asset.sha256]),
        );
        const missing = options.distributions.filter(
          (distribution) => !existsSync(join(destination, "runtime", distribution)),
        );
        for (const assetName of required) {
          const prior = priorManifest.assets?.find((asset) => asset.name === assetName);
          const missingDataAsset = assetName.startsWith("aidlc-data-") &&
            missing.some((distribution) => assetName === dataAsset(distribution));
          if ((!prior && !missingDataAsset) || (prior && prior.sha256 !== expectedAssets.get(assetName))) {
            throw new Error(`existing ${version} install came from a different ${assetName}`);
          }
        }
        if (digest(installedExecutablePath(version)) !== expectedAssets.get(binaryAsset(target))) {
          throw new Error(`existing ${version} binary does not match the verified release`);
        }
        for (const distribution of options.distributions) {
          const installed = join(destination, "runtime", distribution);
          if (
            existsSync(installed) &&
            !treesMatch(installed, join(candidate, "runtime", distribution))
          ) {
            throw new Error(`existing ${version} ${distribution} runtime does not match the verified release`);
          }
        }
        const mergedAssets = [
          ...(priorManifest.assets ?? []),
          ...release.manifest.assets.filter(
            (asset) => !(priorManifest.assets ?? []).some((prior) => prior.name === asset.name),
          ),
        ];
        executePlan({
          schemaVersion: 1,
          root: machineTransactionRoot(),
          operations: [
            ...missing.map((distribution) => ({
              kind: "tree" as const,
              path: relative(machineTransactionRoot(), join(destination, "runtime", distribution)),
              source: join(candidate, "runtime", distribution),
              sourceHash: transactionSourceHash(join(candidate, "runtime", distribution)),
              expected: "absent" as const,
            })),
            writeOperation(
              relative(machineTransactionRoot(), join(destination, "version.json")),
              `${JSON.stringify({ ...release.manifest, assets: mergedAssets }, null, 2)}\n`,
              transactionState(join(destination, "version.json")),
            ),
          ],
        });
        if (!completeVersion(version)) throw new Error(`existing ${version} install is incomplete`);
      } else {
        executePlan({
          schemaVersion: 1,
          root: machineTransactionRoot(),
          operations: [{
            kind: "tree",
            path: relative(machineTransactionRoot(), destination),
            source: candidate,
            sourceHash: transactionSourceHash(candidate),
            expected: "absent",
          }],
        });
      }
      if (options.activate) activate(version);
    }
    return { version, distributions: options.distributions };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (release.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}

async function versionsCommand(argv: string[]): Promise<ReturnType<typeof success>> {
  const verb = argv[1];
  if (verb === "list") {
    const { versions, pinWarnings } = retainedVersions();
    if (argv.includes("--completion-values")) {
      return success(
        versions.filter((item) => item.complete).map((item) => item.version).join("\n"),
      );
    }
    return success(
      (versions.length
        ? versions.map((item) =>
            `${item.version}${item.active ? " active" : ""}${item.rollback ? " rollback" : ""} [${item.distributions.join(",")}] pins=${item.pinPaths.length} stale-pins=${item.stalePinPaths.length}${item.complete ? "" : " incomplete"}`
          ).join("\n")
        : "no retained versions") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions, pinWarnings },
    );
  }
  if (verb === "prune") {
    const { versions, pinWarnings } = retainedVersions();
    if (pinWarnings.length > 0) {
      commandError(
        `cannot prune while pin registry is invalid: ${pinWarnings.join("; ")}`,
        EXIT.integrity,
      );
    }
    const protectedVersions = versions.filter((item) =>
      item.active ||
      item.rollback ||
      item.pinPaths.length > 0 ||
      item.stalePinPaths.length > 0
    );
    const removable = versions.filter((item) => !protectedVersions.includes(item));
    const protection = protectedVersions.map((item) => {
      const reasons = [
        ...(item.active ? ["active"] : []),
        ...(item.rollback ? ["rollback"] : []),
        ...item.pinPaths.map((path) => `pinned by ${path}`),
        ...item.stalePinPaths.map((path) => `stale pin ${path}`),
      ];
      return `${item.version} (${reasons.join(", ")})`;
    }).join("; ");
    if (removable.length === 0) {
      return success(
        protection
          ? `no versions eligible for pruning; protected: ${protection}`
          : "no versions eligible for pruning",
        { removed: [], protected: protectedVersions },
      );
    }
    requireConfirmation(
      argv,
      `Prune retained versions ${removable.map((item) => item.version).join(", ")}?`,
    );
    const refreshed = retainedVersions();
    if (refreshed.pinWarnings.length > 0) {
      commandError(
        `prune cancelled because pin registry changed: ${refreshed.pinWarnings.join("; ")}`,
        EXIT.failure,
      );
    }
    const refreshedByVersion = new Map(
      refreshed.versions.map((item) => [item.version, item]),
    );
    const newlyProtected = removable.filter((item) => {
      const current = refreshedByVersion.get(item.version);
      return !current ||
        current.active ||
        current.rollback ||
        current.pinPaths.length > 0 ||
        current.stalePinPaths.length > 0;
    });
    if (newlyProtected.length > 0) {
      commandError(
        `prune cancelled because version protection changed: ${
          newlyProtected.map((item) => item.version).join(", ")
        }`,
        EXIT.failure,
      );
    }
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: removable.map((item) => ({
        kind: "remove" as const,
        path: relative(root, versionRoot(item.version)),
        expected: transactionState(versionRoot(item.version)) as string,
      })),
    });
    return success(
      `pruned ${removable.map((item) => item.version).join(", ")}${
        protection ? `; protected: ${protection}` : ""
      }`,
      { removed: removable.map((item) => item.version), protected: protectedVersions },
    );
  }
  if (verb !== "install") return usage("usage: aidlc versions <list|install|prune>");
  const version = argv[2];
  if (!version || version.startsWith("--")) return usage("versions install requires a strict version");
  const projectDir = projectDirFrom(argv);
  const distributions = valuesAfter(argv, "--harness");
  if (distributions.length === 0) {
    const project = projectDistribution(projectDir);
    if (project) distributions.push(project);
  }
  const result = await installVersion({
    version,
    distributions,
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: false,
    dryRun: argv.includes("--dry-run"),
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  return success(
    `installed ${result.version} side-by-side; active version remains ${activeVersion() ?? "unchanged"}`,
    result,
  );
}

async function harnessCommand(argv: string[]): Promise<CommandResult> {
  const verb = argv[1];
  const version = activeVersion();
  if (!version || !completeVersion(version)) {
    if (verb === "list" && argv.includes("--completion-values")) {
      return success("");
    }
    return failure("no complete active AI-DLC version is installed", EXIT.unavailable);
  }
  const manifest = installedManifest(version);
  const installed = installedDistributions(version);
  if (verb === "list") {
    if (argv.includes("--completion-values")) {
      return success(installed.join("\n"));
    }
    const selectedDefault = existsSync(defaultHarnessPath())
      ? readFileSync(defaultHarnessPath(), "utf-8").trim()
      : null;
    const harnesses = installed.map((distribution) => ({
      name: distribution,
      productName: productName(manifest, distribution),
      version,
      path: join(runtimeRoot(version), distribution),
      default: distribution === selectedDefault,
    }));
    const notice = process.stdout.isTTY &&
        globalOptions(argv).mode === "human"
      ? cachedUpdateNotice()
      : null;
    return success(
      harnesses.map((item) =>
        `${item.productName} (${item.name}) ${item.version} ${item.path}${item.default ? " default" : ""}`
      ).join("\n") + (notice ? `\n${notice}` : "") || "no installed harnesses",
      { harnesses },
    );
  }
  if (verb === "default") {
    const value = argv[2];
    if (!value) return usage("harness default requires <name|clear>");
    const path = defaultHarnessPath();
    const root = machineTransactionRoot();
    if (value === "clear") {
      if (existsSync(path)) {
        executePlan({
          schemaVersion: 1,
          root,
          operations: [{
            kind: "remove",
            path: relative(root, path),
            expected: transactionState(path) as string,
          }],
        });
      }
      return success("cleared the default harness", { default: null });
    }
    const distribution = safeHarness(value);
    if (!installed.includes(distribution)) {
      return failure(`${distribution} is not installed in active version ${version}`, EXIT.unavailable);
    }
    executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation(
        relative(root, path),
        `${distribution}\n`,
        transactionState(path),
        0o600,
      )],
    });
    return success(
      `default harness set to ${productName(manifest, distribution)}`,
      { default: distribution },
    );
  }
  const rawName = argv[2];
  if (!rawName || rawName.startsWith("--")) {
    return usage(`harness ${verb ?? "<verb>"} requires a harness name`);
  }
  const distribution = safeHarness(rawName);
  if (verb === "add") {
    if (installed.includes(distribution)) {
      return success(
        `${productName(manifest, distribution)} is already installed in ${version}`,
        { version, distribution, changed: false },
      );
    }
    const assetName = dataAsset(distribution);
    const release = await acquireRelease({
      version,
      from: valueAfter(argv, "--from"),
      names: [assetName],
      offline: offline(argv),
      baseUrl: valueAfter(argv, "--release-base-url"),
      caBundle: valueAfter(argv, "--ca-bundle"),
    });
    const temporary = mkdtempSync(join(tmpdir(), `aidlc-harness-${distribution}-`));
    try {
      const candidate = join(temporary, distribution);
      extractTarGz(join(release.directory, assetName), candidate);
      const { stamp } = projectionFiles(candidate);
      if (stamp.frameworkVersion !== version || stamp.distribution !== distribution) {
        throw new Error(`${distribution} archive stamp does not match release ${version}`);
      }
      const asset = release.manifest.assets.find((item) => item.name === assetName);
      if (!asset) throw new Error(`release does not provide ${assetName}`);
      const manifestPath = join(versionRoot(version), "version.json");
      const nextManifest = {
        ...manifest,
        assets: [...manifest.assets.filter((item) => item.name !== assetName), asset],
      };
      const root = machineTransactionRoot();
      executePlan({
        schemaVersion: 1,
        root,
        operations: [
          {
            kind: "tree",
            path: relative(root, join(runtimeRoot(version), distribution)),
            source: candidate,
            sourceHash: transactionSourceHash(candidate),
            expected: "absent",
          },
          writeOperation(
            relative(root, manifestPath),
            `${JSON.stringify(nextManifest, null, 2)}\n`,
            transactionState(manifestPath),
          ),
        ],
      }, {
        validateCommitted: () => {
          if (!inspectInstalledVersion(version, distribution).complete) {
            throw new Error(`installed ${distribution} runtime is incomplete`);
          }
        },
      });
      return success(
        `installed ${productName(release.manifest, distribution)} for ${version}`,
        { version, distribution, changed: true },
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      if (release.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
    }
  }
  if (verb !== "remove") return usage("usage: aidlc harness <add|remove|list|default>");
  if (!installed.includes(distribution)) {
    return failure(`${distribution} is not installed in active version ${version}`, EXIT.unavailable);
  }
  requireConfirmation(
    argv,
    `Remove ${productName(manifest, distribution)} from active aidlc ${version}? Existing projects will not be changed.`,
  );
  const runtimePath = join(runtimeRoot(version), distribution);
  const manifestPath = join(versionRoot(version), "version.json");
  const defaultPath = defaultHarnessPath();
  const nextManifest = {
    ...manifest,
    assets: manifest.assets.filter((item) => item.name !== dataAsset(distribution)),
  };
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: [
      {
        kind: "remove",
        path: relative(root, runtimePath),
        expected: transactionState(runtimePath) as string,
      },
      writeOperation(
        relative(root, manifestPath),
        `${JSON.stringify(nextManifest, null, 2)}\n`,
        transactionState(manifestPath),
      ),
      ...(existsSync(defaultPath) &&
          readFileSync(defaultPath, "utf-8").trim() === distribution
        ? [{
            kind: "remove" as const,
            path: relative(root, defaultPath),
            expected: transactionState(defaultPath) as string,
          }]
        : []),
    ],
  }, {
    validateCommitted: () => {
      if (!completeVersion(version)) throw new Error(`active version ${version} became incomplete`);
    },
  });
  return success(
    `removed ${productName(manifest, distribution)} from ${version}`,
    { version, distribution },
  );
}

function uninstallCommand(argv: string[]): CommandResult {
  const manager = packageManagerForExecutable(process.execPath);
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-uninstall is disabled`,
      EXIT.integrity,
      manager.remediation,
    );
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return failure("refusing to uninstall a root-owned installation", EXIT.integrity);
  }
  if (process.platform === "win32") {
    const recovered = recoverWindowsUninstallContinuations();
    if (recovered > 0) {
      return success(
        `resumed ${recovered} pending Windows uninstall continuation(s)`,
        { purge: argv.includes("--purge"), deferred: true, recovered },
      );
    }
  }
  const version = activeVersion();
  if (!version || !completeVersion(version)) {
    return failure(
      "no complete native AI-DLC installation is active",
      EXIT.unavailable,
    );
  }
  if (!commandOwnedByInstaller(version)) {
    return failure(
      `existing ${commandPath()} is not owned by this AI-DLC install`,
      EXIT.integrity,
    );
  }
  const purge = argv.includes("--purge");
  const { versions } = retainedVersions();
  const preserved = purge ? "nothing" : "global config, update cache, pins, and harness default";
  requireConfirmation(
    argv,
    `Uninstall AI-DLC (${versions.length} retained version(s))? Project trees will not be changed; preserving ${preserved}.`,
  );
  if (process.platform === "win32") {
    return scheduleWindowsUninstall(purge);
  }
  const root = machineTransactionRoot();
  const paths = [
    commandPath(),
    versionsRoot(),
    activeVersionPath(),
    rollbackVersionPath(),
    activeExecutablePath(),
    ...(purge
      ? [
          machineConfigPath(),
          updateCachePath(),
          join(installRoot(), "pins.json"),
          defaultHarnessPath(),
        ]
      : []),
  ].filter(existsSync);
  executePlan({
    schemaVersion: 1,
    root,
    operations: paths.map((path) => ({
      kind: "remove" as const,
      path: relative(root, path),
      expected: transactionState(path) as string,
    })),
  });
  return success(
    `uninstalled AI-DLC; ${purge ? "removed machine configuration and cache" : "preserved machine configuration and cache"}`,
    { purge, preserved: purge ? [] : ["config", "update-cache", "pins", "default-harness"] },
  );
}

function scheduleWindowsUninstall(purge: boolean): CommandResult {
  const recovered = recoverWindowsUninstallContinuations();
  if (recovered > 0) {
    return success(
      `resumed ${recovered} pending Windows uninstall continuation(s)`,
      { purge, deferred: true, recovered },
    );
  }
  const preserved = [
    machineConfigPath(),
    updateCachePath(),
    join(installRoot(), "pins.json"),
    defaultHarnessPath(),
  ];
  scheduleWindowsUninstallContinuation(purge, preserved);
  return success(
    `uninstall scheduled; Windows cleanup will finish after this command exits`,
    { purge, deferred: true },
  );
}

async function upgradeCommand(argv: string[]): Promise<CommandResult> {
  const manager = packageManagerForExecutable(process.execPath);
  if (manager) {
    return failure(
      `AI-DLC is installed via ${manager.name}; self-upgrade is disabled`,
      EXIT.failure,
      manager.remediation,
    );
  }
  const current = activeVersion();
  if (argv.includes("--check")) {
    let state: Awaited<ReturnType<typeof refreshUpdateState>>;
    try {
      state = await refreshUpdateState(15_000, {
        offline: offline(argv),
        baseUrl: valueAfter(argv, "--release-base-url"),
        caBundle: valueAfter(argv, "--ca-bundle"),
      });
    } catch (error) {
      commandError(
        error instanceof Error ? error.message : String(error),
        error instanceof ReleaseUnavailableError ? EXIT.unavailable : EXIT.failure,
      );
    }
    if (state.state === "behind") {
      return {
        ...success(state.message, state),
        code: EXIT.actionNeeded,
        status: "action-needed",
      };
    }
    if (state.state === "invalid-config") {
      return failure(state.message, EXIT.usage, "repair or remove the invalid machine config");
    }
    if (
      state.state === "unavailable" ||
      state.state === "offline"
    ) {
      return failure(state.message, EXIT.unavailable);
    }
    if (state.state === "disabled") {
      return failure(state.message, EXIT.failure);
    }
    return success(state.message, state);
  }
  const distributions = current ? installedDistributions(current) : valuesAfter(argv, "--harness");
  const dryRun = argv.includes("--dry-run");
  const result = await installVersion({
    version: valueAfter(argv, "--version"),
    distributions,
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: true,
    dryRun,
    allowNoDistributions: current !== null,
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  return success(
    dryRun
      ? `upgrade plan: ${current ?? "none"} -> ${result.version} [${result.distributions.join(",")}]`
      : `upgraded ${current ?? "new install"} -> ${result.version}`,
    result,
  );
}

function rollbackCommand(argv: string[]): ReturnType<typeof success> {
  if (argv.includes("--list")) {
    const { versions, pinWarnings } = retainedVersions();
    const eligible = versions.filter((item) => item.complete && !item.active);
    return success(
      (eligible.length
        ? eligible.map((item) => `${item.version} [${item.distributions.join(",")}]`).join("\n")
        : "no rollback target") +
        (pinWarnings.length > 0 ? `\nwarning: ${pinWarnings.join("; ")}` : ""),
      { versions: eligible, pinWarnings },
    );
  }
  const target = valueAfter(argv, "--version") ||
    (existsSync(rollbackVersionPath()) ? readFileSync(rollbackVersionPath(), "utf-8").trim() : "");
  if (!target) {
    commandError("no rollback version is recorded; run aidlc rollback --list", EXIT.failure);
  }
  if (valueAfter(argv, "--version")) {
    requestedVersion(target);
  } else {
    try {
      requireVersion(target);
    } catch (error) {
      commandError(
        `recorded rollback version is invalid: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.integrity,
      );
    }
  }
  const active = activeVersion();
  const missing = active
    ? installedDistributions(active).filter((item) => !installedDistributions(target).includes(item))
    : [];
  if (missing.length > 0 && !argv.includes("--allow-harness-loss")) {
    throw new Error(`rollback target lacks harnesses: ${missing.join(", ")}`);
  }
  activate(target);
  return success(`rolled back to ${target}`, { version: target });
}

function useCommand(argv: string[]): ReturnType<typeof success> {
  const value = argv[1];
  if (!value) return usage("usage: aidlc use <version|current>");
  const projectDir = projectDirFrom(argv);
  const pinPath = join(projectDir, ".aidlc-version");
  const pins = registeredPins(true).pins;
  const project = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
  if (value === "current") {
    if (existsSync(pinPath)) {
      executePlan({
        schemaVersion: 1,
        root: projectDir,
        operations: [{
          kind: "remove",
          path: ".aidlc-version",
          expected: transactionState(pinPath),
        }],
      });
    }
    delete pins[project];
    executePlan({
      schemaVersion: 1,
      root: machineTransactionRoot(),
      operations: [writeOperation(
        relative(machineTransactionRoot(), join(installRoot(), "pins.json")),
        `${JSON.stringify(pins, null, 2)}\n`,
        transactionState(join(installRoot(), "pins.json")),
      )],
    });
    return success("project now follows the active AI-DLC version");
  }
  const version = requestedVersion(value);
  if (!completeVersion(version)) {
    commandError(`${version} is not installed completely`, EXIT.unavailable);
  }
  const distribution = projectDistribution(projectDir);
  if (distribution && !inspectInstalledVersion(version, distribution).complete) {
    commandError(
      `${version} does not contain this project's ${distribution} runtime`,
      EXIT.usage,
    );
  }
  pins[project] = version;
  executePlan({
    schemaVersion: 1,
    root: machineTransactionRoot(),
    operations: [writeOperation(
      relative(machineTransactionRoot(), join(installRoot(), "pins.json")),
      `${JSON.stringify(pins, null, 2)}\n`,
      transactionState(join(installRoot(), "pins.json")),
    )],
  });
  executePlan({
    schemaVersion: 1,
    root: projectDir,
    operations: [writeOperation(
      ".aidlc-version",
      `${version}\n`,
      transactionState(pinPath),
    )],
  });
  return success(`project pinned to AI-DLC ${version}`, { projectDir, version });
}

async function packageCommand(argv: string[]): Promise<ReturnType<typeof success>> {
  if (argv[1] === "verify") {
    const directory = argv[2];
    if (!directory) return usage("package verify requires a directory");
    let manifest: ReleaseManifest;
    try {
      manifest = verifyReleaseDirectory(directory);
    } catch (error) {
      commandError(
        error instanceof Error ? error.message : String(error),
        EXIT.integrity,
      );
    }
    return success(`verified release package ${manifest.version} (${manifest.assets.length} assets)`, manifest);
  }
  if (argv[1] !== "create") return usage("usage: aidlc package <create|verify>");
  const output = valueAfter(argv, "--output");
  if (!output) return usage("package create requires --output <directory>");
  const distributions = valuesAfter(argv, "--harness");
  const targets = valuesAfter(argv, "--target");
  if (distributions.length === 0 || targets.length === 0) {
    return usage("package create requires at least one --harness and --target");
  }
  const versionValue = valueAfter(argv, "--version");
  const version = versionValue ? requestedVersion(versionValue) : undefined;
  const names = [
    ...targets.map(binaryAsset),
    ...distributions.map(dataAsset),
    "install.sh",
    "install.ps1",
  ];
  const release = await acquireRelease({
    version,
    from: valueAfter(argv, "--from"),
    names,
    offline: offline(argv),
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  const destination = isAbsolute(output) ? output : resolve(process.cwd(), output);
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-package-"));
  try {
    if (existsSync(destination) && readdirSync(destination).length > 0) {
      throw new Error(`package output must be empty: ${destination}`);
    }
    const candidate = join(temporary, "package");
    const manifest = copyReleaseSubset(release.directory, candidate, names);
    executePlan({
      schemaVersion: 1,
      root: dirname(destination),
      operations: [{
        kind: "tree",
        path: basename(destination),
        source: candidate,
        sourceHash: transactionSourceHash(candidate),
        expected: existsSync(destination) ? "empty-directory" : "absent",
      }],
    });
    return success(`created offline package ${manifest.version} at ${destination}`, manifest);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (release.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}

function installProfileCommand(argv: string[]): CommandResult {
  const profileValue = valueAfter(argv, "--profile");
  const binValue = valueAfter(argv, "--bin-dir");
  if (!profileValue || !binValue) {
    return usage("install-profile requires --profile <path> and --bin-dir <path>");
  }
  const profile = resolve(profileValue);
  const bin = resolve(binValue);
  const home = resolve(process.env.HOME || "");
  if (!process.env.HOME) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileRelative: string;
  try {
    profileRelative = relative(
      realpathSync(home),
      join(realpathSync(dirname(profile)), basename(profile)),
    );
  } catch {
    return failure(
      "profile parent must exist inside the target user's home directory",
      EXIT.integrity,
    );
  }
  if (
    profileRelative === ".." ||
    profileRelative.startsWith(`..${sep}`) ||
    isAbsolute(profileRelative)
  ) {
    return failure("profile path must be inside the target user's home directory", EXIT.integrity);
  }
  let profileMode = 0o600;
  let profileExists = false;
  try {
    const stat = lstatSync(profile);
    profileExists = true;
    profileMode = stat.mode & 0o777;
    if (!stat.isFile()) {
      return failure("profile path is not a regular file", EXIT.integrity);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const begin = "# BEGIN AI-DLC:PATH";
  const end = "# END AI-DLC:PATH";
  const current = profileExists ? readFileSync(profile, "utf-8") : "";
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || begins !== ends) {
    return failure("profile AI-DLC PATH markers are missing, duplicated, or malformed", EXIT.integrity);
  }
  const escapedBin = bin.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$").replaceAll("`", "\\`");
  const block = `${begin}\nexport PATH="${escapedBin}:$PATH"\n${end}`;
  let next: string;
  if (begins === 1) {
    const start = current.indexOf(begin);
    const finish = current.indexOf(end, start + begin.length) + end.length;
    next = `${current.slice(0, start)}${block}${current.slice(finish)}`;
  } else {
    const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
    next = `${prefix}${prefix.length > 0 ? "\n" : ""}${block}\n`;
  }
  executePlan({
    schemaVersion: 1,
    root: dirname(profile),
    operations: [writeOperation(
      basename(profile),
      next,
      transactionState(profile),
      profileMode,
    )],
  });
  return success(`updated ${profile} with an owned AI-DLC PATH block`, { profile, bin });
}

export async function main(input: string[]): Promise<void> {
  const argv = stripVerb(input);
  const options = globalOptions(argv);
  try {
    const command = argv[0];
    const result = command === "versions"
      ? await versionsCommand(argv)
      : command === "upgrade"
      ? await upgradeCommand(argv)
      : command === "rollback"
      ? rollbackCommand(argv)
      : command === "use"
      ? useCommand(argv)
      : command === "package"
      ? await packageCommand(argv)
      : command === "harness"
      ? await harnessCommand(argv)
      : command === "uninstall"
      ? uninstallCommand(argv)
      : command === "install-profile"
      ? installProfileCommand(argv)
      : command === "install-apply"
      ? success(
          `installed ${(await installVersion({
            version: valueAfter(argv, "--version"),
            distributions: valuesAfter(argv, "--harness"),
            from: valueAfter(argv, "--from"),
            offline: true,
            activate: true,
            dryRun: false,
            baseUrl: valueAfter(argv, "--release-base-url"),
            caBundle: valueAfter(argv, "--ca-bundle"),
          })).version}`,
        )
      : usage("unknown lifecycle command");
    emitResult(result, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof LifecycleCommandError
      ? error.exitCode
      : error instanceof ReleaseUnavailableError
      ? EXIT.unavailable
      : EXIT.failure;
    emitResult(failure(
      message,
      code,
    ), options);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
