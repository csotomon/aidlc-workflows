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
  activeVersionPath,
  commandPath,
  inspectInstalledVersion,
  installRoot,
  machineTransactionRoot,
  packageManagerForExecutable,
  projectDirFrom,
  requireVersion,
  rollbackVersionPath,
  runtimeRoot,
  targetTriple,
  versionRoot,
  versionsRoot,
} from "./aidlc-install-paths.ts";
import {
  acquireRelease,
  copyReleaseSubset,
  digest,
  ReleaseUnavailableError,
  verifyReleaseDirectory,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";

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

function offline(argv: readonly string[]): boolean {
  return argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1";
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

function registeredPins(): Record<string, string> {
  const path = join(installRoot(), "pins.json");
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a project-to-version object`);
  }
  const pins: Record<string, string> = {};
  for (const [project, version] of Object.entries(value as Record<string, unknown>)) {
    if (!isAbsolute(project) || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`${path} contains an invalid pin entry`);
    }
    pins[project] = version;
  }
  return pins;
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

function retainedVersions(): Array<{
  version: string;
  active: boolean;
  rollback: boolean;
  distributions: string[];
  complete: boolean;
  pinPaths: string[];
  stalePinPaths: string[];
}> {
  if (!existsSync(versionsRoot())) return [];
  const active = activeVersion();
  const rollback = existsSync(rollbackVersionPath())
    ? readFileSync(rollbackVersionPath(), "utf-8").trim()
    : null;
  const pins = registeredPins();
  return readdirSync(versionsRoot()).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort()
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
}

function projectDistribution(projectDir: string): string | null {
  for (const harness of [".claude", ".kiro", ".codex"]) {
    const stamp = join(projectDir, harness, "tools", "data", "aidlc-stamp.json");
    if (!existsSync(stamp)) continue;
    const value = JSON.parse(readFileSync(stamp, "utf-8")) as { distribution?: string };
    if (value.distribution) return value.distribution;
  }
  return null;
}

export function activate(version: string, options: { failAfter?: number } = {}): void {
  if (!completeVersion(version)) {
    commandError(`retained version ${version} is incomplete`, EXIT.unavailable);
  }
  const previous = activeVersion();
  const root = machineTransactionRoot();
  const target = join(versionRoot(version), "aidlc");
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
    {
      kind: "symlink" as const,
      path: relative(root, commandPath()),
      target,
      expected: transactionState(commandPath()),
    },
  ];
  executePlan({
    schemaVersion: 1,
    root,
    operations,
  }, {
    ...options,
    validateCommitted: () => {
      if (realpathSync(commandPath()) !== realpathSync(target)) {
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

async function installVersion(options: {
  version?: string;
  distributions: string[];
  from?: string;
  offline: boolean;
  activate: boolean;
  dryRun: boolean;
  baseUrl?: string;
  caBundle?: string;
}): Promise<{ version: string; distributions: string[] }> {
  const wantedVersion = options.version ? requestedVersion(options.version) : undefined;
  if (options.distributions.length === 0) {
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
    writeFileSync(join(candidate, "aidlc"), readFileSync(binarySource), { mode: 0o755 });
    chmodSync(join(candidate, "aidlc"), 0o755);
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
        if (digest(join(destination, "aidlc")) !== expectedAssets.get(binaryAsset(target))) {
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
    const versions = retainedVersions();
    return success(
      versions.length
        ? versions.map((item) =>
            `${item.version}${item.active ? " active" : ""}${item.rollback ? " rollback" : ""} [${item.distributions.join(",")}] pins=${item.pinPaths.length} stale-pins=${item.stalePinPaths.length}${item.complete ? "" : " incomplete"}`
          ).join("\n")
        : "no retained versions",
      { versions },
    );
  }
  if (verb !== "install") return usage("usage: aidlc versions <list|install>");
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
  const distributions = current ? installedDistributions(current) : valuesAfter(argv, "--harness");
  const dryRun = argv.includes("--dry-run") || argv.includes("--check");
  const result = await installVersion({
    version: valueAfter(argv, "--version"),
    distributions,
    from: valueAfter(argv, "--from"),
    offline: offline(argv),
    activate: true,
    dryRun,
    baseUrl: valueAfter(argv, "--release-base-url"),
    caBundle: valueAfter(argv, "--ca-bundle"),
  });
  if (argv.includes("--check") && current !== result.version) {
    return {
      ...success(`update available: ${current ?? "none"} -> ${result.version}`, result),
      code: EXIT.actionNeeded,
      status: "action-needed",
    };
  }
  return success(
    dryRun
      ? `upgrade plan: ${current ?? "none"} -> ${result.version} [${result.distributions.join(",")}]`
      : `upgraded ${current ?? "new install"} -> ${result.version}`,
    result,
  );
}

function rollbackCommand(argv: string[]): ReturnType<typeof success> {
  if (argv.includes("--list")) {
    const eligible = retainedVersions().filter((item) => item.complete && !item.active);
    return success(
      eligible.length ? eligible.map((item) => `${item.version} [${item.distributions.join(",")}]`).join("\n") : "no rollback target",
      { versions: eligible },
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
  const pins = registeredPins();
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
    throw new Error(`${version} does not contain this project's ${distribution} runtime`);
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
    const manifest = verifyReleaseDirectory(directory);
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
      : EXIT.integrity;
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
