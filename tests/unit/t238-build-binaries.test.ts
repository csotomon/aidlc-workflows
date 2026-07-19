// covers: file:scripts/build-binaries.ts, tool:aidlc, subcommand:aidlc-utility:version
// covers: subcommand:aidlc-utility:plugin-sync
// covers: subcommand:aidlc-utility:doctor
//
// Native-only unit coverage for the release binary builder. The cross-target
// matrix, including Bun's Windows .exe append behavior, is intentionally left
// to release CI because those artifacts are host/toolchain dependent and much
// more expensive than the local native gate.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../../dist/claude/.claude/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-binaries.ts");
const PACKAGE_RELEASE_SCRIPT = join(REPO_ROOT, "scripts", "package-release.ts");
const RESULTS_JSON = join(REPO_ROOT, "build", "binaries", "build-results.json");
const RELEASE_DIR = join(REPO_ROOT, "build", "release");
const UTILITY_TS = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type GateResult = {
  name: string;
  ok: boolean;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  actual?: string | number;
  expected?: string | number;
};

type TargetResult = {
  name: string;
  artifact: string;
  bytes: number;
  gates: GateResult[];
};

type BuildResults = {
  expectedVersion: string;
  results: TargetResult[];
};

function runBuild(extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_BUILD_ENTRY;
  delete env.AIDLC_BUILD_OUT_DIR;
  Object.assign(env, extraEnv);
  const result = spawnSync(BUN, [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
    timeout: 300_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function readResults(path = RESULTS_JSON): BuildResults {
  return JSON.parse(readFileSync(path, "utf-8")) as BuildResults;
}

function nativeResult(doc: BuildResults): TargetResult {
  const native = doc.results.find((result) => result.name === "native");
  expect(native).toBeDefined();
  return native as TargetResult;
}

function gate(result: TargetResult, name: string): GateResult {
  const found = result.gates.find((item) => item.name === name);
  expect(found).toBeDefined();
  return found as GateResult;
}

function stampedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const prefixed = /^aidlc\s+([0-9]+\.[0-9]+\.[0-9]+)$/.exec(trimmed);
  return prefixed?.[1] ?? trimmed;
}

describe("t238 build-binaries release builder", () => {
  test("native build compiles, gates, and runs version plus a delegate from an isolated project", () => {
    const result = runBuild();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const doc = readResults();
    expect(doc.expectedVersion).toBe(AIDLC_VERSION);
    const native = nativeResult(doc);
    expect(existsSync(native.artifact)).toBe(true);
    expect(relative(REPO_ROOT, native.artifact).replace(/\\/g, "/").startsWith("build/binaries/")).toBe(true);
    expect(native.bytes).toBeGreaterThan(10 * 1024 * 1024);
    for (const harness of ["claude", "codex", "kiro", "kiro-ide"]) {
      expect(existsSync(join(dirname(native.artifact), "runtime", harness))).toBe(true);
    }
    const stagedRunner = readFileSync(
      join(
        dirname(native.artifact),
        "runtime",
        "claude",
        ".claude",
        "skills",
        "aidlc-code-generation",
        "SKILL.md",
      ),
      "utf-8",
    );
    expect(stagedRunner).toContain(
      "aidlc __delegate orchestrate next --stage code-generation --single",
    );
    expect(stagedRunner).not.toContain("bun .claude/tools/aidlc-orchestrate.ts");

    const version = gate(native, "version");
    expect(version.ok).toBe(true);
    expect(version.actual).toBe(AIDLC_VERSION);

    const delegatePluginSync = gate(native, "delegate-plugin-sync");
    expect(delegatePluginSync.ok).toBe(true);
    expect(delegatePluginSync.actual).toBe("plugin sync complete: 0 plugin(s)");
    expect(delegatePluginSync.stderr).not.toContain("Cannot find module");
    expect(delegatePluginSync.stderr).not.toContain("/$bunfs/");

    for (const name of [
      "runtime-assets",
      "sensor-list",
      "sensor-fire",
      "graph-compile-check",
      "packaged-runtime-immutable",
      "validate-outputs",
      "runner-check",
      "stage-table-check",
      "scope-table-check",
      "runtime-codex",
      "runtime-kiro",
      "runtime-kiro-ide",
      "harness-probe-kiro",
      "plugin-select",
      "real-plugin-sync",
      "conductor-persona",
      "workspace-global-flags",
      "bolt-reentry",
      "swarm-reentry",
      "pathless-next-env-scope",
      "native-directive-invocation",
      "pathless-park",
      "pathless-single-audit",
      "hook-validate-state",
      "statusline",
      "adapter-codex-validate-state",
      "routed-project-dir",
      "bun-compiled-parity",
    ]) {
      expect(gate(native, name).ok, name).toBe(true);
    }

    const delegateDoctorData = gate(native, "delegate-doctor-data");
    expect(delegateDoctorData.ok).toBe(true);
    expect(delegateDoctorData.stdout).toContain("AI-DLC Health Check");
    expect(delegateDoctorData.stdout).toMatch(/Schema validation: \d+\/\d+ stages validated/);
    expect(delegateDoctorData.stdout).not.toContain("Schema validation: 0/0");
    expect(`${delegateDoctorData.stdout ?? ""}${delegateDoctorData.stderr ?? ""}`).not.toMatch(
      /Cannot find module|\/\$bunfs\/|ENOENT/,
    );

    const rerun = spawnSync(native.artifact, ["version"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(rerun.status).toBe(0);
    expect(stampedVersion(rerun.stdout ?? "")).toBe(AIDLC_VERSION);

    const pluginFixture = mkdtempSync(join(tmpdir(), "aidlc-t238-plugin-empty-"));
    try {
      const registry = join(pluginFixture, "installed_plugins.json");
      const settings = join(pluginFixture, "settings.json");
      writeFileSync(join(pluginFixture, "package.json"), "{}\n");
      writeFileSync(registry, '{"version":2,"plugins":{}}\n');
      writeFileSync(settings, '{"enabledPlugins":{}}\n');
      const pluginSync = spawnSync(native.artifact, ["plugin", "sync"], {
        cwd: pluginFixture,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_HARNESS_DIR: ".claude",
          AIDLC_CLAUDE_PLUGIN_REGISTRY: registry,
          AIDLC_CLAUDE_SETTINGS: settings,
        },
        timeout: 30_000,
      });
      expect(pluginSync.status).toBe(0);
      expect(pluginSync.stdout ?? "").toBe("plugin sync complete: 0 plugin(s)\n");
      expect(`${pluginSync.stdout ?? ""}${pluginSync.stderr ?? ""}`).not.toContain("Cannot find module");
      expect(`${pluginSync.stdout ?? ""}${pluginSync.stderr ?? ""}`).not.toContain("/$bunfs/");
    } finally {
      rmSync(pluginFixture, { recursive: true, force: true });
    }

    const doctor = spawnSync(native.artifact, ["doctor"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(doctor.status === 0 || doctor.status === 1).toBe(true);
    expect(doctor.stdout ?? "").toContain("AI-DLC Health Check");
    expect(`${doctor.stdout ?? ""}${doctor.stderr ?? ""}`).not.toMatch(
      /Cannot find module|\/\$bunfs\/|ENOENT/,
    );

    const utility = spawnSync(BUN, [UTILITY_TS, "version"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(utility.status).toBe(0);
    expect(stampedVersion(utility.stdout ?? "")).toBe(AIDLC_VERSION);

    const packaged = spawnSync(BUN, [PACKAGE_RELEASE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, SOURCE_DATE_EPOCH: "1784246400" },
    });
    expect(packaged.status, `${packaged.stdout ?? ""}${packaged.stderr ?? ""}`).toBe(0);

    const installFixture = mkdtempSync(join(tmpdir(), "aidlc-t238-install-"));
    try {
      const home = join(installFixture, "home");
      const installRoot = join(home, ".local", "share", "aidlc");
      const binDir = join(home, ".local", "bin");
      const profile = join(home, ".profile");
      const project = join(installFixture, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(profile, "# user profile\n");
      const env = {
        ...process.env,
        HOME: home,
        AIDLC_INSTALL_ROOT: installRoot,
        AIDLC_BIN_DIR: binDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      const outsideProfileDir = join(installFixture, "outside-profile");
      const linkedProfileDir = join(home, "linked-profile");
      mkdirSync(outsideProfileDir, { recursive: true });
      symlinkSync(relative(home, outsideProfileDir), linkedProfileDir);
      const escapedProfile = spawnSync(native.artifact, [
        "__delegate",
        "lifecycle",
        "install-profile",
        "--profile",
        join(linkedProfileDir, ".profile"),
        "--bin-dir",
        binDir,
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(escapedProfile.status).toBe(4);
      expect(escapedProfile.stdout ?? "").toContain(
        "profile path must be inside the target user's home directory",
      );
      expect(existsSync(join(outsideProfileDir, ".profile"))).toBe(false);

      const invalidRoot = join(installFixture, "invalid-destination-install");
      const invalidDestination = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "claude",
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...env,
          AIDLC_INSTALL_ROOT: invalidRoot,
          AIDLC_BIN_DIR: "relative-bin",
        },
      });
      expect(invalidDestination.status).toBe(4);
      expect(invalidDestination.stdout ?? "").toContain("AIDLC_BIN_DIR must be an absolute path");
      expect(existsSync(invalidRoot)).toBe(false);

      const unknownHarnessRoot = join(installFixture, "unknown-harness-install");
      const unknownHarness = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "not-a-release-harness",
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...env,
          AIDLC_INSTALL_ROOT: unknownHarnessRoot,
        },
      });
      expect(unknownHarness.status).toBe(4);
      expect(unknownHarness.stdout ?? "").toContain(
        "release does not provide harness not-a-release-harness",
      );
      expect(existsSync(unknownHarnessRoot)).toBe(false);

      const managerRoot = join(installFixture, "manager");
      const managerBin = join(managerRoot, "Cellar", "aidlc", "1.0.0", "bin");
      const managerCommandDir = join(managerRoot, "prefix", "bin");
      const managerInstallRoot = join(installFixture, "manager-refusal-install");
      mkdirSync(managerBin, { recursive: true });
      mkdirSync(managerCommandDir, { recursive: true });
      writeFileSync(join(managerBin, "aidlc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync(
        relative(managerCommandDir, join(managerBin, "aidlc")),
        join(managerCommandDir, "aidlc"),
      );
      const managerEnv: NodeJS.ProcessEnv = {
        ...env,
        AIDLC_INSTALL_ROOT: managerInstallRoot,
        PATH: `${managerCommandDir}:${process.env.PATH ?? ""}`,
      };
      delete managerEnv.AIDLC_BIN_DIR;
      const managerOwned = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "claude",
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env: managerEnv,
      });
      expect(managerOwned.status).toBe(4);
      expect(managerOwned.stdout ?? "").toContain("brew upgrade aidlc");
      expect(existsSync(managerInstallRoot)).toBe(false);

      const install = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "claude",
        "--profile",
        profile,
        "--json",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(install.status, `${install.stdout ?? ""}${install.stderr ?? ""}`).toBe(0);
      expect(JSON.parse(install.stdout ?? "")).toEqual(expect.objectContaining({
        schemaVersion: 1,
        ok: true,
        code: 0,
        data: expect.objectContaining({
          version: AIDLC_VERSION,
          harnesses: ["claude"],
          profile,
        }),
      }));
      const quietInstall = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "claude",
        "--quiet",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        quietInstall.status,
        `${quietInstall.stdout ?? ""}${quietInstall.stderr ?? ""}`,
      ).toBe(0);
      expect((quietInstall.stdout ?? "").trim().split("\n")).toHaveLength(1);
      expect(quietInstall.stdout ?? "").toContain(`installed AI-DLC ${AIDLC_VERSION}`);
      expect(`${quietInstall.stdout ?? ""}${quietInstall.stderr ?? ""}`).not.toContain("\u001b[");

      const humanInstall = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--harness",
        "claude",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        humanInstall.status,
        `${humanInstall.stdout ?? ""}${humanInstall.stderr ?? ""}`,
      ).toBe(0);
      expect(humanInstall.stdout ?? "")
        .toContain(`PASS installed AI-DLC ${AIDLC_VERSION} for Claude Code`);
      expect(`${humanInstall.stdout ?? ""}${humanInstall.stderr ?? ""}`).not.toContain("\u001b[");

      const profileText = readFileSync(profile, "utf-8");
      expect(profileText).toContain("# user profile");
      expect(profileText).toContain("# BEGIN AI-DLC:PATH");
      expect(profileText).toContain(`export PATH="${binDir}:$PATH"`);
      const installedBinary = join(binDir, "aidlc");
      expect(existsSync(installedBinary)).toBe(true);

      const init = spawnSync(installedBinary, [
        "init",
        "--project-dir",
        project,
        "--mcp",
        "none",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(init.status, `${init.stdout ?? ""}${init.stderr ?? ""}`).toBe(0);
      expect(existsSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"))).toBe(true);

      const installedDoctor = spawnSync(installedBinary, [
        "doctor",
        "--project-dir",
        project,
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        installedDoctor.status,
        `${installedDoctor.stdout ?? ""}${installedDoctor.stderr ?? ""}`,
      ).toBe(0);
      expect(installedDoctor.stdout ?? "").toContain("Installed runtime");
      expect(installedDoctor.stdout ?? "").toContain("Transaction staging: no abandoned directories");
      expect(installedDoctor.stdout ?? "").toContain("Project pin registry: no stale registrations");
      expect(installedDoctor.stdout ?? "").toContain(
        "Native command trust: host hooks and permission entries select the installed `aidlc` command",
      );
      expect(installedDoctor.stdout ?? "").not.toContain("wires no aidlc-*.ts hooks");

      const quietDoctor = spawnSync(installedBinary, [
        "doctor",
        "--project-dir",
        project,
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(quietDoctor.status, `${quietDoctor.stdout ?? ""}${quietDoctor.stderr ?? ""}`).toBe(0);
      expect((quietDoctor.stdout ?? "").trim().split("\n")).toHaveLength(1);
      expect(quietDoctor.stdout ?? "").toMatch(/^\d+ passed, \d+ warnings, 0 failed\n$/);
    } finally {
      rmSync(installFixture, { recursive: true, force: true });
    }
  }, 300_000);

  test("fake entry with wrong version proves the mandatory version gate can fail", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-t238-"));
    try {
      const entry = join(root, "fake-aidlc.ts");
      const outDir = join(root, "out");
      writeFileSync(
        entry,
        [
          "#!/usr/bin/env bun",
          "const verb = process.argv[2];",
          "if (verb === \"version\") {",
          "  process.stdout.write(\"aidlc 0.0.0\\n\");",
          "  process.exit(0);",
          "}",
          "if (verb === \"help\" || verb === undefined) {",
          "  process.stdout.write(\"aidlc fake help\\n\");",
          "  process.exit(0);",
          "}",
          "if (verb === \"doctor\") {",
          "  process.stderr.write(\"ENOENT: /$bunfs/root/data/stage-graph.json\\n\");",
          "  process.exit(1);",
          "}",
          "process.stderr.write(\"unknown fake command\\n\");",
          "process.exit(2);",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = runBuild({
        AIDLC_BUILD_ENTRY: entry,
        AIDLC_BUILD_OUT_DIR: outDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version gate failed");

      const doc = readResults(join(outDir, "build-results.json"));
      const native = nativeResult(doc);
      const version = gate(native, "version");
      expect(version.ok).toBe(false);
      expect(version.actual).toBe("0.0.0");
      expect(version.expected).toBe(AIDLC_VERSION);

      const delegatePluginSync = gate(native, "delegate-plugin-sync");
      expect(delegatePluginSync.ok).toBe(false);
      expect(result.stderr).toContain("delegate-plugin-sync gate failed");

      const delegateDoctorData = gate(native, "delegate-doctor-data");
      expect(delegateDoctorData.ok).toBe(false);
      expect(delegateDoctorData.actual).toBe("ENOENT");
      expect(result.stderr).toContain("delegate-doctor-data gate failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
