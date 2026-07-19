// covers: tool:aidlc-init, tool:aidlc-lifecycle, file:core/tools/aidlc-archive.ts
// covers: file:core/tools/aidlc-transaction.ts, file:scripts/package.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTarGz,
  extractTarGz,
  readTarGz,
  type ArchiveEntry,
} from "../../core/tools/aidlc-archive.ts";
import { sha256Bytes, walkFiles } from "../../core/tools/aidlc-distribution.ts";
import {
  packageManagerForExecutable,
  projectDirFrom,
  targetTriple,
} from "../../core/tools/aidlc-install-paths.ts";
import { activate } from "../../core/tools/aidlc-lifecycle.ts";
import { acquireRelease, digest, verifyReleaseDirectory } from "../../core/tools/aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "../../core/tools/aidlc-transaction.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  checkLiveReleaseContract,
  serveReleaseFixture,
  writeReleaseFixture,
} from "../harness/release-fixture.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INSTALLER = join(REPO_ROOT, "scripts", "install.sh");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
const CODEX_RELEASE = join(REPO_ROOT, "dist-release", "codex");
const KIRO_IDE_COPY = join(REPO_ROOT, "dist", "kiro-ide");
const KIRO_IDE_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const KIRO_RELEASES = [
  join(REPO_ROOT, "dist-release", "kiro"),
  join(REPO_ROOT, "dist-release", "kiro-ide"),
] as const;
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runAsync(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([BUN, tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function fixtureRelease(
  version = AIDLC_VERSION,
  reportedVersion = version,
): string {
  const root = temp("aidlc-t240-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version,
    reportedVersion,
    distributions: ["claude"],
  });
  return root;
}

describe("t240 archive and transaction safety", () => {
  test("tar round-trip is deterministic and rejects traversal", () => {
    const entries: ArchiveEntry[] = [
      { path: "root/a.txt", type: "file", mode: 0o644, data: Buffer.from("alpha\n") },
      { path: "root/bin/run", type: "file", mode: 0o755, data: Buffer.from("#!/bin/sh\n") },
    ];
    expect(createTarGz(entries).equals(createTarGz([...entries].reverse()))).toBe(true);
    const archive = join(temp("aidlc-t240-archive-"), "fixture.tgz");
    writeFileSync(archive, createTarGz(entries));
    expect(readTarGz(archive).map((entry) => entry.path)).toEqual(["root/a.txt", "root/bin/run"]);
    const extracted = temp("aidlc-t240-extract-");
    extractTarGz(archive, extracted);
    expect(readFileSync(join(extracted, "root", "a.txt"), "utf-8")).toBe("alpha\n");
    expect(() => createTarGz([
      { path: "../escape", type: "file", mode: 0o644, data: Buffer.from("bad") },
    ])).toThrow("unsafe archive path");
    expect(() => createTarGz([
      { path: "root/../escape", type: "file", mode: 0o644, data: Buffer.from("bad") },
    ])).toThrow("unsafe archive path");
    expect(() => createTarGz([
      { path: "root", type: "directory", mode: 0o755, data: Buffer.from("bad") },
    ])).toThrow("unexpected file data");
  });

  test("transaction rejects symlink traversal and restores every committed byte on fault", () => {
    const root = temp("aidlc-t240-txn-");
    writeFileSync(join(root, "a.txt"), "old-a");
    writeFileSync(join(root, "b.txt"), "old-b");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("a.txt", "new-a"),
        writeOperation("b.txt", "new-b"),
      ],
    }, { failAfter: 1 })).toThrow("injected transaction failure");
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("old-a");
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("old-b");

    const outside = temp("aidlc-t240-outside-");
    symlinkSync(outside, join(root, "escape"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("escape/file.txt", "no")],
    })).toThrow("traverses a symlink");
    expect(existsSync(join(outside, "file.txt"))).toBe(false);
  });

  test("transaction refuses a copy source that changed after planning", () => {
    const parent = temp("aidlc-t240-source-parent-");
    const root = join(parent, "missing-root");
    const sourceRoot = temp("aidlc-t240-source-input-");
    const source = join(sourceRoot, "input.txt");
    writeFileSync(source, "planned");
    const sourceHash = transactionSourceHash(source);
    writeFileSync(source, "changed");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [{
        kind: "copy",
        path: "output.txt",
        source,
        sourceHash,
        expected: "absent",
      }],
    })).toThrow("transaction source changed after planning");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(root, "output.txt"))).toBe(false);
  });

  test("transaction validates staged candidates before live mutation", () => {
    const root = temp("aidlc-t240-candidate-validation-");
    writeFileSync(join(root, "value.txt"), "old");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("value.txt", "new", transactionState(join(root, "value.txt"))),
      ],
    }, {
      validateCandidates(candidateRoot) {
        expect(readFileSync(join(candidateRoot, "value.txt"), "utf-8")).toBe("new");
        expect(readFileSync(join(root, "value.txt"), "utf-8")).toBe("old");
        throw new Error("candidate rejected");
      },
    })).toThrow("candidate rejected");
    expect(readFileSync(join(root, "value.txt"), "utf-8")).toBe("old");
  });

  test("named transaction boundaries restore the prior state", () => {
    const boundaries = [
      "after-lock",
      "before-plan-validation",
      "after-plan-validation",
      "before-stage:1:write",
      "after-stage:1:write",
      "before-candidate-validation",
      "after-candidate-validation",
      "before-snapshot:1:write",
      "after-snapshot:1:write",
      "before-commit:1:write",
      "after-commit:1:write",
      "before-committed-validation",
      "after-committed-validation",
    ];
    for (const failAt of boundaries) {
      const root = temp("aidlc-t240-named-fault-");
      writeFileSync(join(root, "value.txt"), "old");
      expect(() => executePlan({
        schemaVersion: 1,
        root,
        operations: [
          writeOperation("value.txt", "new", transactionState(join(root, "value.txt"))),
        ],
      }, { failAt })).toThrow(`injected transaction failure at ${failAt}`);
      expect(readFileSync(join(root, "value.txt"), "utf-8"), failAt).toBe("old");
    }
  });

  test("rollback restores file mode and symlink target and rejects a dangling symlink parent", () => {
    const root = temp("aidlc-t240-txn-metadata-");
    const first = join(root, "first");
    const second = join(root, "second");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    writeFileSync(join(root, "mode.txt"), "old", { mode: 0o600 });
    symlinkSync(first, join(root, "pointer"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("mode.txt", "new", transactionState(join(root, "mode.txt")), 0o755),
        {
          kind: "symlink",
          path: "pointer",
          target: second,
          expected: transactionState(join(root, "pointer")),
        },
      ],
    }, { failAfter: 2 })).toThrow("injected transaction failure");
    expect(readFileSync(join(root, "mode.txt"), "utf-8")).toBe("old");
    expect(statSync(join(root, "mode.txt")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "pointer"), "utf-8")).toBe("first");

    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("dangling/file.txt", "blocked")],
    })).toThrow("traverses a symlink");
  });

  test("archive supports ustar prefixes and rejects file-descendant collisions", () => {
    const path = `${"segment/".repeat(18)}payload.txt`;
    const archive = join(temp("aidlc-t240-ustar-"), "long.tgz");
    writeFileSync(archive, createTarGz([
      { path, type: "file", mode: 0o644, data: Buffer.from("long") },
    ]));
    expect(readTarGz(archive)[0].path).toBe(path);
    expect(() => createTarGz([
      { path: "root", type: "file", mode: 0o644, data: Buffer.from("file") },
      { path: "root/child", type: "file", mode: 0o644, data: Buffer.from("child") },
    ])).toThrow("is an ancestor");
  });

  test("archive expansion is bounded before tar parsing", () => {
    const archive = join(temp("aidlc-t240-expansion-"), "expanded.tgz");
    writeFileSync(archive, createTarGz([
      {
        path: "large.txt",
        type: "file",
        mode: 0o644,
        data: Buffer.alloc(16 * 1024),
      },
    ]));
    expect(statSync(archive).size).toBeLessThan(1024);
    expect(() => readTarGz(archive, { maxBytes: 1024 }))
      .toThrow("expanded archive exceeds the extraction byte limit");
  });

  test("transaction sweeps dead-process staging without replaying a journal", () => {
    const root = temp("aidlc-t240-recovery-");
    const stagingName = ".aidlc-txn-00000000-0000-4000-8000-000000000000";
    const staging = join(root, stagingName);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "orphan.txt"), "unused");
    writeFileSync(join(root, "a.txt"), "still-live");
    writeFileSync(
      join(root, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, staging: stagingName })}\n`,
    );

    executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("b.txt", "next", "absent")],
    });

    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("still-live");
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("next");
    expect(existsSync(staging)).toBe(false);
  });

  test("transaction never reclaims a live lock with complete metadata", () => {
    const root = temp("aidlc-t240-live-lock-");
    writeFileSync(
      join(root, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`,
    );
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("blocked.txt", "no", "absent")],
    })).toThrow("another AI-DLC mutation holds");
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
    expect(existsSync(join(root, ".aidlc-transaction.lock"))).toBe(true);
  });

  test("transaction release never unlinks a replacement lock it does not own", () => {
    const root = temp("aidlc-t240-lock-identity-");
    const lockPath = join(root, ".aidlc-transaction.lock");
    const replacement = `${JSON.stringify({ pid: process.pid, staging: "replacement" })}\n`;
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("blocked.txt", "no", "absent")],
    }, {
      validateCandidates() {
        rmSync(lockPath);
        writeFileSync(lockPath, replacement);
        throw new Error("replacement installed");
      },
    })).toThrow("replacement installed");
    expect(readFileSync(lockPath, "utf-8")).toBe(replacement);
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
    rmSync(lockPath);
  });

  test("route mutation policy blocks a plan before it creates destination bytes", () => {
    const root = temp("aidlc-t240-policy-mutation-");
    const priorScope = process.env.AIDLC_ROUTE_MUTATION_SCOPE;
    const priorId = process.env.AIDLC_ROUTE_ID;
    try {
      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "none";
      process.env.AIDLC_ROUTE_ID = "package-verify";
      expect(() => executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("forbidden.txt", "no\n", "absent")],
      })).toThrow("does not permit filesystem mutation");
      expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
      expect(existsSync(join(root, ".aidlc-transaction.lock"))).toBe(false);
    } finally {
      if (priorScope === undefined) delete process.env.AIDLC_ROUTE_MUTATION_SCOPE;
      else process.env.AIDLC_ROUTE_MUTATION_SCOPE = priorScope;
      if (priorId === undefined) delete process.env.AIDLC_ROUTE_ID;
      else process.env.AIDLC_ROUTE_ID = priorId;
    }
  });

  test("target selection distinguishes glibc and musl Linux releases", () => {
    if (process.platform !== "linux") return;
    const prior = process.env.AIDLC_LIBC;
    try {
      process.env.AIDLC_LIBC = "musl";
      expect(targetTriple()).toEndWith("-musl");
      process.env.AIDLC_LIBC = "glibc";
      expect(targetTriple()).not.toEndWith("-musl");
    } finally {
      if (prior === undefined) delete process.env.AIDLC_LIBC;
      else process.env.AIDLC_LIBC = prior;
    }
  });

  test("package-manager executable detection yields to Homebrew and Nix", () => {
    expect(packageManagerForExecutable("/opt/homebrew/Cellar/aidlc/2.5.0/libexec/aidlc"))
      .toEqual({ name: "Homebrew", remediation: "brew upgrade aidlc" });
    expect(packageManagerForExecutable("/nix/store/hash-aidlc-2.5.0/bin/aidlc"))
      .toEqual({ name: "Nix", remediation: "upgrade aidlc through Nix" });
    expect(packageManagerForExecutable("/home/user/.local/share/aidlc/versions/2.5.0/aidlc"))
      .toBeNull();
  });

  test("shared release fixture is byte-deterministic and emits hostile archives", () => {
    const first = temp("aidlc-t240-fixture-first-");
    const second = temp("aidlc-t240-fixture-second-");
    const hostile = temp("aidlc-t240-fixture-hostile-");
    const left = writeReleaseFixture({
      root: first,
      repoRoot: REPO_ROOT,
      distributions: ["claude"],
      hostileRoot: hostile,
    });
    writeReleaseFixture({
      root: second,
      repoRoot: REPO_ROOT,
      distributions: ["claude"],
    });
    expect(walkFiles(first)).toEqual(walkFiles(second));
    for (const path of walkFiles(first)) {
      expect(digest(join(first, path)), path).toBe(digest(join(second, path)));
    }
    expect(left.hostileArchives).toHaveLength(2);
    for (const path of left.hostileArchives) {
      expect(() => readTarGz(path)).toThrow();
    }
  });
});

describe("t240 project initialization", () => {
  test("dry-run against a missing explicit target creates no directory", () => {
    const parent = temp("aidlc-t240-dry-parent-");
    const project = join(parent, "not-created");
    const dry = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--dry-run",
      "--json",
    ], parent);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(existsSync(project)).toBe(false);
  });

  test("Kiro project context resolves without a command-line target", () => {
    const project = temp("aidlc-t240-kiro-project-");
    const prior = process.env.KIRO_PROJECT_DIR;
    try {
      process.env.KIRO_PROJECT_DIR = project;
      expect(projectDirFrom([])).toBe(project);
    } finally {
      if (prior === undefined) delete process.env.KIRO_PROJECT_DIR;
      else process.env.KIRO_PROJECT_DIR = prior;
    }
  });

  test("fresh init, dry-run, refresh preservation, conflict, and force use one projection", () => {
    const project = temp("aidlc-t240-project-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".gitignore"), "node_modules/\n");
    const dry = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--dry-run",
      "--json",
    ], project);
    expect(dry.status).toBe(0);
    expect(existsSync(join(project, ".claude"))).toBe(false);
    const dryPlan = JSON.parse(dry.stdout) as { data: { actions: unknown[]; planToken: string } };

    const apply = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "none",
      "--plan-token",
      dryPlan.data.planToken,
      "--json",
    ], project);
    expect(apply.status, apply.stdout + apply.stderr).toBe(0);
    const applyPlan = JSON.parse(apply.stdout) as {
      message: string;
      data: { actions: unknown[]; planToken: string };
    };
    expect(applyPlan.data.actions).toEqual(dryPlan.data.actions);
    expect(applyPlan.data.planToken).toBe(dryPlan.data.planToken);
    expect(applyPlan.message).toContain("open Claude Code in this project");
    expect(existsSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"))).toBe(true);
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("node_modules/");
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("BEGIN AI-DLC:gitignore");
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);

    const memory = join(project, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(memory, "# local method\n");
    const framework = join(project, ".claude", "tools", "aidlc-command.ts");
    const harnessData = join(project, ".claude", "tools", "data", "harness.json");
    const graphData = join(project, ".claude", "tools", "data", "stage-graph.json");
    const scopeData = join(project, ".claude", "tools", "data", "scope-grid.json");
    const selected = JSON.parse(readFileSync(harnessData, "utf-8")) as Record<string, unknown>;
    selected.plugins = ["aidlc", "test-pro"];
    writeFileSync(harnessData, `${JSON.stringify(selected, null, 2)}\n`);
    writeFileSync(graphData, `${readFileSync(graphData, "utf-8").trimEnd()}\n `);
    const scopeGrid = JSON.parse(readFileSync(scopeData, "utf-8")) as Record<string, unknown>;
    scopeGrid["custom-composed"] = scopeGrid.bugfix;
    writeFileSync(scopeData, `${JSON.stringify(scopeGrid, null, 2)}\n`);
    writeFileSync(framework, `${readFileSync(framework, "utf-8")}\n// local edit\n`);
    const conflict = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(conflict.status).toBe(4);
    expect(conflict.stdout).toContain("locally modified");

    const forced = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--force",
    ], project);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(readFileSync(memory, "utf-8")).toBe("# local method\n");
    expect(readFileSync(framework, "utf-8")).not.toContain("// local edit");
    expect(JSON.parse(readFileSync(harnessData, "utf-8")).plugins).toEqual(["aidlc", "test-pro"]);
    expect(() => JSON.parse(readFileSync(graphData, "utf-8"))).not.toThrow();
    expect(readFileSync(graphData, "utf-8")).not.toEndWith("\n ");
    expect(JSON.parse(readFileSync(scopeData, "utf-8"))["custom-composed"]).toEqual(scopeGrid.bugfix);
    const baseline = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"), "utf-8"),
    ) as { files: Record<string, string> };
    expect(baseline.files[".claude/tools/data/harness.json"]).toBeUndefined();
    expect(baseline.files[".claude/tools/data/stage-graph.json"]).toBeUndefined();
    expect(baseline.files[".claude/tools/data/scope-grid.json"]).toBeUndefined();

    const gitignore = join(project, ".gitignore");
    writeFileSync(
      gitignore,
      readFileSync(gitignore, "utf-8").replace(
        "# END AI-DLC:gitignore",
        "# local managed edit\n# END AI-DLC:gitignore",
      ),
    );
    const blockConflict = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(blockConflict.status).toBe(4);
    expect(blockConflict.stdout).toContain("managed block was locally modified");

    const blockForced = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--force",
    ], project);
    expect(blockForced.status, blockForced.stdout + blockForced.stderr).toBe(0);
    expect(readFileSync(gitignore, "utf-8")).toContain("node_modules/");
    expect(readFileSync(gitignore, "utf-8")).not.toContain("# local managed edit");
  }, 60_000);

  test("--force does not replace a pre-existing user-owned JSON entry", () => {
    const project = temp("aidlc-t240-json-owner-");
    mkdirSync(join(project, ".git"));
    const custom = { type: "http", url: "https://example.invalid/custom" };
    writeFileSync(
      join(project, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { context7: custom }, projectSetting: true }, null, 2)}\n`,
    );

    const result = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "defaults",
      "--force",
    ], project);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const merged = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
      projectSetting: boolean;
    };
    expect(merged.mcpServers.context7).toEqual(custom);
    expect(merged.projectSetting).toBe(true);
  });

  test("MCP consent and managed AGENTS blocks preserve user-owned configuration", () => {
    const claudeProject = temp("aidlc-t240-mcp-matrix-");
    mkdirSync(join(claudeProject, ".git"));
    const noConsent = run(INIT, [
      "init",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--yes",
    ], claudeProject);
    expect(noConsent.status, noConsent.stdout + noConsent.stderr).toBe(0);
    expect(existsSync(join(claudeProject, ".mcp.json"))).toBe(false);

    const defaults = run(INIT, [
      "init",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--mcp",
      "defaults",
    ], claudeProject);
    expect(defaults.status, defaults.stdout + defaults.stderr).toBe(0);
    const mcpPath = join(claudeProject, ".mcp.json");
    const configured = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    const shipped = JSON.parse(readFileSync(join(CLAUDE_RELEASE, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(configured.mcpServers).sort()).toEqual(Object.keys(shipped.mcpServers).sort());
    configured.mcpServers["project-owned"] = { command: "project-tool" };
    (configured as Record<string, unknown>).projectSetting = true;
    writeFileSync(mcpPath, `${JSON.stringify(configured, null, 2)}\n`);
    const disabled = run(INIT, [
      "init",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--mcp",
      "none",
    ], claudeProject);
    expect(disabled.status, disabled.stdout + disabled.stderr).toBe(0);
    const retained = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
      projectSetting: boolean;
    };
    expect(retained.mcpServers).toEqual({ "project-owned": { command: "project-tool" } });
    expect(retained.projectSetting).toBe(true);

    const kiroProject = temp("aidlc-t240-agents-matrix-");
    mkdirSync(join(kiroProject, ".git"));
    writeFileSync(join(kiroProject, "AGENTS.md"), "# Project instructions\n\nKeep this text.\n");
    const kiroInit = run(INIT, [
      "init",
      "--project-dir",
      kiroProject,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], kiroProject);
    expect(kiroInit.status, kiroInit.stdout + kiroInit.stderr).toBe(0);
    const agentsPath = join(kiroProject, "AGENTS.md");
    expect(readFileSync(agentsPath, "utf-8")).toContain("Keep this text.");
    expect(readFileSync(agentsPath, "utf-8")).toContain("<!-- BEGIN AI-DLC:agents -->");
    writeFileSync(agentsPath, readFileSync(agentsPath, "utf-8").replace(
      "Keep this text.",
      "Keep this updated text.",
    ));
    const kiroRefresh = run(INIT, [
      "init",
      "--project-dir",
      kiroProject,
      "--from",
      KIRO_RELEASES[0],
    ], kiroProject);
    expect(kiroRefresh.status, kiroRefresh.stdout + kiroRefresh.stderr).toBe(0);
    expect(readFileSync(agentsPath, "utf-8")).toContain("Keep this updated text.");

    const malformedProject = temp("aidlc-t240-root-conflicts-");
    mkdirSync(join(malformedProject, ".git"));
    writeFileSync(join(malformedProject, "AGENTS.md"), "<!-- BEGIN AI-DLC:agents -->\nmissing end\n");
    const malformedAgents = run(INIT, [
      "init",
      "--project-dir",
      malformedProject,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], malformedProject);
    expect(malformedAgents.status).toBe(4);
    expect(malformedAgents.stdout).toContain("managed markers are missing, duplicated, or malformed");

    const malformedMcp = temp("aidlc-t240-mcp-conflict-");
    mkdirSync(join(malformedMcp, ".git"));
    writeFileSync(join(malformedMcp, ".mcp.json"), "{");
    const malformedJson = run(INIT, [
      "init",
      "--project-dir",
      malformedMcp,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "defaults",
    ], malformedMcp);
    expect(malformedJson.status).toBe(4);
    expect(malformedJson.stdout).toContain("malformed JSON");
  }, 60_000);

  test("all local init modes open no internet sockets", () => {
    const strace = Bun.which("strace");
    if (!strace || process.platform !== "linux") return;
    const project = temp("aidlc-t240-no-network-");
    mkdirSync(join(project, ".git"));
    const cases = [
      ["init", "--project-dir", project, "--from", CLAUDE_RELEASE, "--harness", "claude", "--dry-run"],
      ["init", "--project-dir", project, "--from", CLAUDE_RELEASE, "--harness", "claude"],
      ["init", "--project-dir", project, "--from", CLAUDE_RELEASE],
    ];
    for (const [index, args] of cases.entries()) {
      const trace = join(temp(`aidlc-t240-trace-${index}-`), "network.trace");
      const result = spawnSync(strace, [
        "-f",
        "-qq",
        "-e",
        "trace=network",
        "-o",
        trace,
        BUN,
        INIT,
        ...args,
      ], {
        cwd: project,
        env: process.env,
        encoding: "utf-8",
        timeout: 60_000,
      });
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
      const calls = readFileSync(trace, "utf-8");
      expect(calls).not.toMatch(/\b(?:socket|connect)\([^\n]*(?:AF_INET|AF_INET6)/);
    }
  }, 60_000);

  test("init treats dangling managed symlinks as conflicts and cleans failed refresh staging", () => {
    const project = temp("aidlc-t240-init-symlink-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".claude", "tools"), { recursive: true });
    symlinkSync(join(project, "missing-target"), join(project, ".claude", "tools", "aidlc-command.ts"));
    const dangling = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(dangling.status).toBe(4);
    expect(dangling.stdout).toContain("locally modified or unowned");

    rmSync(join(project, ".claude"), { recursive: true, force: true });
    const installed = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("aidlc-init-refresh-")),
    );
    writeFileSync(join(project, ".claude", "tools", "data", "harness.json"), "{");
    const failed = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(failed.status).toBe(4);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("aidlc-init-refresh-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  }, 60_000);

  test("refresh reapplies recorded plugin contributions onto newer upstream stage bytes", () => {
    const project = temp("aidlc-t240-plugin-refresh-");
    mkdirSync(join(project, ".git"));
    const first = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(first.status, first.stdout + first.stderr).toBe(0);

    const rel = join(".claude", "aidlc-common", "stages", "construction", "nfr-requirements.md");
    const stagePath = join(project, rel);
    const current = readFileSync(stagePath, "utf-8");
    writeFileSync(stagePath, current.replace(
      /^(produces:\n(?: {2}- .+\n)*)/m,
      "$1  - test-pro-refresh-artifact\n",
    ));
    writeFileSync(
      join(project, ".claude", "tools", "data", "plugin-contrib-test-pro.json"),
      `${JSON.stringify({
        "nfr-requirements": { produces: ["test-pro-refresh-artifact"] },
      }, null, 2)}\n`,
    );

    const newer = temp("aidlc-t240-newer-projection-");
    cpSync(CLAUDE_RELEASE, newer, { recursive: true });
    const newerStage = join(newer, rel);
    writeFileSync(newerStage, `${readFileSync(newerStage, "utf-8")}\nUpstream refresh marker.\n`);
    const refreshed = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      newer,
    ], project);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(readFileSync(stagePath, "utf-8")).toContain("test-pro-refresh-artifact");
    expect(readFileSync(stagePath, "utf-8")).toContain("Upstream refresh marker.");
  }, 60_000);

  test("Kiro IDE release trust merge owns only the native command entry", () => {
    const project = temp("aidlc-t240-kiro-trust-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".vscode"));
    writeFileSync(
      join(project, ".vscode", "settings.json"),
      `${JSON.stringify({
        "kiroAgent.trustedCommands": ["user-tool *"],
        "editor.formatOnSave": true,
      }, null, 2)}\n`,
    );
    const installed = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      KIRO_IDE_RELEASE,
      "--harness",
      "kiro-ide",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    let settings = JSON.parse(readFileSync(join(project, ".vscode", "settings.json"), "utf-8"));
    expect(settings["kiroAgent.trustedCommands"]).toEqual(["user-tool *", "aidlc *"]);
    expect(settings["editor.formatOnSave"]).toBe(true);

    const switched = run(INIT, [
      "init",
      "--project-dir",
      project,
      "--from",
      KIRO_IDE_COPY,
    ], project);
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    settings = JSON.parse(readFileSync(join(project, ".vscode", "settings.json"), "utf-8"));
    expect(settings["kiroAgent.trustedCommands"]).toEqual(["user-tool *"]);
    expect(settings["editor.formatOnSave"]).toBe(true);
  }, 60_000);
});

describe("t240 release lifecycle", () => {
  test("installer renders order-independent usage failures as valid JSON", () => {
    const invalidHarness = "invalid\u0001\nharness";
    const result = spawnSync("sh", [
      INSTALLER,
      "--harness",
      invalidHarness,
      "--json",
    ], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout ?? "")).toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      code: 2,
      status: "usage",
      message: `invalid harness name: ${invalidHarness}`,
    }));
  });

  test("route network policy blocks acquisition before opening a socket", async () => {
    const priorPolicy = process.env.AIDLC_ROUTE_NETWORK_POLICY;
    const priorId = process.env.AIDLC_ROUTE_ID;
    try {
      process.env.AIDLC_ROUTE_NETWORK_POLICY = "forbidden";
      process.env.AIDLC_ROUTE_ID = "package-verify";
      await expect(acquireRelease({
        names: [],
        baseUrl: "http://127.0.0.1:1",
      })).rejects.toThrow("package-verify forbids network access");
    } finally {
      if (priorPolicy === undefined) delete process.env.AIDLC_ROUTE_NETWORK_POLICY;
      else process.env.AIDLC_ROUTE_NETWORK_POLICY = priorPolicy;
      if (priorId === undefined) delete process.env.AIDLC_ROUTE_ID;
      else process.env.AIDLC_ROUTE_ID = priorId;
    }
  });

  test("shared release server covers redirect, delay, truncation, captive portal, oversized metadata, and missing assets", async () => {
    const release = fixtureRelease();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;

    const redirect = serveReleaseFixture(release, { kind: "redirect" });
    try {
      const acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: redirect.baseUrl,
      });
      expect(acquired.manifest.assets.map((asset) => asset.name)).toEqual([binary]);
      expect(redirect.requests.some((path) => path.startsWith("/fixture-assets/"))).toBe(true);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
    } finally {
      redirect.stop();
    }

    const delay = serveReleaseFixture(release, {
      kind: "delay",
      asset: "version.json",
      milliseconds: 100,
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: delay.baseUrl,
        metadataTimeoutMs: 10,
      })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
    } finally {
      delay.stop();
    }

    for (const fault of [
      { kind: "truncate", asset: binary } as const,
      { kind: "captive-portal", asset: "version.json" } as const,
      { kind: "oversized", asset: "version.json" } as const,
      { kind: "missing", asset: "checksums.txt" } as const,
    ]) {
      const server = serveReleaseFixture(release, fault);
      try {
        await expect(acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: server.baseUrl,
        })).rejects.toThrow();
      } finally {
        server.stop();
      }
    }
  });

  test("opt-in live release endpoint matches the fixture contract", async () => {
    if (process.env.AIDLC_RELEASE_CONTRACT_LIVE !== "1") return;
    const checked = await checkLiveReleaseContract(process.env.AIDLC_RELEASE_BASE_URL);
    expect(checked.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(checked.assets).toContain("install.sh");
  }, 30_000);

  test("online acquisition trusts released checksums instead of manifest-synthesized rows", async () => {
    const release = fixtureRelease();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-linux-"))?.name ??
      manifest.assets.find((asset) => asset.name.startsWith("aidlc-darwin-"))?.name;
    expect(binary).toBeDefined();
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path.endsWith("/version.json")) return new Response(readFileSync(join(release, "version.json")));
        if (path.endsWith("/checksums.txt")) {
          return new Response(
            `${digest(join(release, "version.json"))}  version.json\n${"0".repeat(64)}  ${binary}\n`,
          );
        }
        return new Response(readFileSync(join(release, basename(path))));
      },
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary as string],
        baseUrl: `http://127.0.0.1:${server.port}`,
      })).rejects.toThrow("released checksum does not match version.json");
      expect(requests.some((path) => path.endsWith(`/${binary}`))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("release verification requires and authenticates version.json", () => {
    const missing = fixtureRelease();
    const rows = readFileSync(join(missing, "checksums.txt"), "utf-8")
      .split(/\r?\n/)
      .filter((row) => row && !row.endsWith("  version.json"));
    writeFileSync(join(missing, "checksums.txt"), `${rows.join("\n")}\n`);
    expect(() => verifyReleaseDirectory(missing)).toThrow("no version.json checksum");

    const tampered = fixtureRelease();
    const manifestPath = join(tampered, "version.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { date: string };
    manifest.date = "2026-07-18";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyReleaseDirectory(tampered)).toThrow("version.json: checksum mismatch");
  });

  test("release client classifies HTTP failures, follows redirects, and enforces metadata timeout", async () => {
    const release = fixtureRelease();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;
    const failures = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 500 }) });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${failures.port}`,
      })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
    } finally {
      failures.stop(true);
    }

    let redirects = 0;
    let redirectPort = 0;
    const redirecting = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        const name = basename(url.pathname);
        if (!url.pathname.startsWith("/assets/")) {
          redirects++;
          return Response.redirect(`http://127.0.0.1:${redirectPort}/assets/${name}`, 302);
        }
        return new Response(readFileSync(join(release, name)));
      },
    });
    redirectPort = redirecting.port ?? 0;
    try {
      const acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${redirecting.port}`,
      });
      expect(acquired.manifest.assets.map((asset) => asset.name)).toEqual([binary]);
      expect(redirects).toBe(3);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
    } finally {
      redirecting.stop(true);
    }

    const delayed = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(100);
        return new Response("{}");
      },
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${delayed.port}`,
        metadataTimeoutMs: 10,
      })).rejects.toThrow("timed out after 10ms");
    } finally {
      delayed.stop(true);
    }
  });

  test("release client honors proxy, NO_PROXY, mirror precedence, custom CA, and redaction", async () => {
    const release = fixtureRelease();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;
    const responseFor = (request: Request): Response => {
      const name = basename(new URL(request.url).pathname);
      return existsSync(join(release, name))
        ? new Response(readFileSync(join(release, name)))
        : new Response("missing", { status: 404 });
    };
    const openssl = Bun.which("openssl");
    if (openssl) {
      const tlsProxyKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
      const tlsProxySaved = Object.fromEntries(
        tlsProxyKeys.map((name) => [name, process.env[name]]),
      );
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.no_proxy;
      process.env.NO_PROXY = "localhost";
      const tlsRoot = temp("aidlc-t240-tls-");
      const key = join(tlsRoot, "server.key");
      const cert = join(tlsRoot, "server.crt");
      const generated = spawnSync(openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        key,
        "-out",
        cert,
      ], { encoding: "utf-8" });
      expect(generated.status, generated.stderr ?? "").toBe(0);
      const secure = Bun.serve({
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch: responseFor,
      });
      try {
        await expect(acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `https://localhost:${secure.port}`,
        })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
        const acquired = await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `https://localhost:${secure.port}`,
          caBundle: cert,
        });
        expect(acquired.manifest.version).toBe(manifest.version);
        if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
      } finally {
        secure.stop(true);
        for (const name of tlsProxyKeys) {
          const value = tlsProxySaved[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    let originRequests = 0;
    let proxyRequests = 0;
    let ignoredMirrorRequests = 0;
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        originRequests++;
        return responseFor(request);
      },
    });
    const proxy = Bun.serve({
      port: 0,
      fetch(request) {
        proxyRequests++;
        return responseFor(request);
      },
    });
    const ignoredMirror = Bun.serve({
      port: 0,
      fetch() {
        ignoredMirrorRequests++;
        return new Response("wrong mirror", { status: 500 });
      },
    });
    const keys = [
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "AIDLC_RELEASE_BASE_URL",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      delete process.env.https_proxy;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
      let acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(proxyRequests).toBe(3);
      expect(originRequests).toBe(0);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      process.env.NO_PROXY = "127.0.0.1";
      acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(originRequests).toBe(3);
      expect(proxyRequests).toBe(3);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      process.env.AIDLC_RELEASE_BASE_URL = `http://127.0.0.1:${ignoredMirror.port}`;
      acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(ignoredMirrorRequests).toBe(0);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      delete process.env.NO_PROXY;
      process.env.HTTPS_PROXY = "ftp://alice:proxy-secret@127.0.0.1:9";
      let proxyMessage = "";
      try {
        await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `http://127.0.0.1:${origin.port}`,
        });
      } catch (error) {
        proxyMessage = error instanceof Error ? error.message : String(error);
      }
      expect(proxyMessage).toContain("HTTPS_PROXY must use HTTP or HTTPS");
      expect(proxyMessage).not.toContain("proxy-secret");

      delete process.env.HTTPS_PROXY;
      let urlMessage = "";
      try {
        await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `http://alice:url-secret@127.0.0.1:${ignoredMirror.port}`,
        });
      } catch (error) {
        urlMessage = error instanceof Error ? error.message : String(error);
      }
      expect(urlMessage).not.toContain("url-secret");
    } finally {
      origin.stop(true);
      proxy.stop(true);
      ignoredMirror.stop(true);
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  test("checksums, side-by-side install, activation, version inventory, and pins agree", async () => {
    const release = fixtureRelease();
    expect(verifyReleaseDirectory(release).version).toBe(AIDLC_VERSION);
    const machine = temp("aidlc-t240-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-pin-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };

    const sideBySide = run(LIFECYCLE, [
      "versions",
      "install",
      AIDLC_VERSION,
      "--harness",
      "claude",
      "--from",
      release,
    ], project, env);
    expect(sideBySide.status, sideBySide.stdout + sideBySide.stderr).toBe(0);
    expect(existsSync(join(machine, "active-version"))).toBe(false);

    const upgrade = run(LIFECYCLE, [
      "upgrade",
      "--version",
      AIDLC_VERSION,
      "--harness",
      "claude",
      "--from",
      release,
    ], project, env);
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    expect(existsSync(join(bin, "aidlc"))).toBe(true);

    const list = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(`"version":"${AIDLC_VERSION}"`);
    expect(list.stdout).toContain(`"active":true`);

    const pin = run(LIFECYCLE, ["use", AIDLC_VERSION, "--project-dir", project], project, env);
    expect(pin.status, pin.stdout + pin.stderr).toBe(0);
    expect(readFileSync(join(project, ".aidlc-version"), "utf-8")).toBe(`${AIDLC_VERSION}\n`);
    const pins = readFileSync(join(machine, "pins.json"), "utf-8");
    expect(pins).toContain(AIDLC_VERSION);
    const pinnedList = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(pinnedList.status).toBe(0);
    expect(pinnedList.stdout).toContain(`"pinPaths":["${project}"]`);

    const offline = join(temp("aidlc-t240-package-parent-"), "release");
    mkdirSync(offline);
    const createPackage = run(LIFECYCLE, [
      "package",
      "create",
      "--version",
      AIDLC_VERSION,
      "--harness",
      "claude",
      "--target",
      targetTriple(),
      "--output",
      offline,
      "--from",
      release,
    ], project, env);
    expect(createPackage.status, createPackage.stdout + createPackage.stderr).toBe(0);
    const verifyPackage = run(LIFECYCLE, ["package", "verify", offline], project, env);
    expect(verifyPackage.status, verifyPackage.stdout + verifyPackage.stderr).toBe(0);
    writeFileSync(join(offline, "install.sh"), "tampered");
    const rejectPackage = run(LIFECYCLE, ["package", "verify", offline], project, env);
    expect(rejectPackage.status).toBe(4);
    expect(rejectPackage.stdout).toContain("checksum mismatch");

    const unpin = run(LIFECYCLE, ["use", "current", "--project-dir", project], project, env);
    expect(unpin.status, unpin.stdout + unpin.stderr).toBe(0);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(readFileSync(join(machine, "pins.json"), "utf-8")).not.toContain(project);

    writeFileSync(join(release, `aidlc-${targetTriple()}`), "tampered");
    expect(() => verifyReleaseDirectory(release)).toThrow("checksum mismatch");
  }, 60_000);

  test("activation fault rolls pointer, active marker, and rollback marker back together", () => {
    const currentRelease = fixtureRelease();
    const nextVersion = "2.5.2";
    const nextRelease = fixtureRelease(nextVersion);
    const machine = temp("aidlc-t240-activation-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-activation-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    for (const [version, release, verb] of [
      [AIDLC_VERSION, currentRelease, "upgrade"],
      [nextVersion, nextRelease, "versions"],
    ] as const) {
      const args = verb === "upgrade"
        ? ["upgrade", "--version", version, "--harness", "claude", "--from", release]
        : ["versions", "install", version, "--harness", "claude", "--from", release];
      const result = run(LIFECYCLE, args, project, env);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    const priorEnv = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = bin;
    try {
      const command = join(bin, "aidlc");
      const oldTarget = realpathSync(command);
      for (const failAfter of [1, 2, 3]) {
        expect(() => activate(nextVersion, { failAfter })).toThrow("injected transaction failure");
        expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
        expect(realpathSync(command)).toBe(oldTarget);
        expect(existsSync(join(machine, "rollback-version"))).toBe(false);
      }

      activate(nextVersion);
      expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(nextVersion);
      expect(readFileSync(join(machine, "rollback-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    } finally {
      if (priorEnv.install === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = priorEnv.install;
      if (priorEnv.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = priorEnv.bin;
    }
  }, 60_000);

  test("failed post-flip version validation restores the prior active install", () => {
    const currentRelease = fixtureRelease();
    const badVersion = "2.5.2";
    const badRelease = fixtureRelease(badVersion, "9.9.9");
    const machine = temp("aidlc-t240-validation-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-validation-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    expect(run(LIFECYCLE, [
      "upgrade", "--version", AIDLC_VERSION, "--harness", "claude", "--from", currentRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", badVersion, "--harness", "claude", "--from", badRelease,
    ], project, env).status).toBe(0);

    const priorInstallRoot = process.env.AIDLC_INSTALL_ROOT;
    const priorBinDir = process.env.AIDLC_BIN_DIR;
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = bin;
    try {
      expect(() => activate(badVersion)).toThrow("version probe returned");
      expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
      expect(realpathSync(join(bin, "aidlc")))
        .toBe(join(machine, "versions", AIDLC_VERSION, "aidlc"));
      expect(existsSync(join(machine, "rollback-version"))).toBe(false);
    } finally {
      if (priorInstallRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = priorInstallRoot;
      if (priorBinDir === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = priorBinDir;
    }
  }, 60_000);

  test("retained versions reject executable checksum and runtime stamp corruption", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t240-completeness-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-completeness-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    const installed = run(LIFECYCLE, [
      "versions",
      "install",
      AIDLC_VERSION,
      "--harness",
      "claude",
      "--from",
      release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const executable = join(machine, "versions", AIDLC_VERSION, "aidlc");
    writeFileSync(executable, "tampered", { mode: 0o755 });
    const badExecutable = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(badExecutable.stdout).toContain('"complete":false');
    expect(run(LIFECYCLE, ["use", AIDLC_VERSION, "--project-dir", project], project, env).status)
      .toBe(3);

    cpSync(join(release, `aidlc-${targetTriple()}`), executable);
    const stampPath = join(
      machine,
      "versions",
      AIDLC_VERSION,
      "runtime",
      "claude",
      ".claude",
      "tools",
      "data",
      "aidlc-stamp.json",
    );
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { distribution: string };
    stamp.distribution = "kiro";
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const badStamp = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(badStamp.stdout).toContain('"complete":false');
    expect(run(LIFECYCLE, ["use", AIDLC_VERSION, "--project-dir", project], project, env).status)
      .toBe(3);
  }, 60_000);

  test("lifecycle exit taxonomy distinguishes usage, transport, operation, and integrity", async () => {
    const release = fixtureRelease();
    const project = temp("aidlc-t240-exits-");
    mkdirSync(join(project, ".git"));
    const invalid = run(LIFECYCLE, [
      "versions", "install", "not-semver", "--harness", "claude", "--from", release,
    ], project);
    expect(invalid.status).toBe(2);
    const invalidPackage = run(LIFECYCLE, [
      "package",
      "create",
      "--version",
      "not-semver",
      "--harness",
      "claude",
      "--target",
      targetTriple(),
      "--output",
      join(temp("aidlc-t240-invalid-package-"), "output"),
      "--from",
      release,
    ], project);
    expect(invalidPackage.status).toBe(2);

    const server = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 500 }) });
    try {
      const unavailable = await runAsync(LIFECYCLE, [
        "versions",
        "install",
        AIDLC_VERSION,
        "--harness",
        "claude",
        "--release-base-url",
        `http://127.0.0.1:${server.port}`,
      ], project);
      expect(unavailable.status, unavailable.stdout + unavailable.stderr).toBe(3);
    } finally {
      server.stop(true);
    }

    const noRollback = run(LIFECYCLE, ["rollback"], project, {
      AIDLC_INSTALL_ROOT: temp("aidlc-t240-no-rollback-"),
      AIDLC_BIN_DIR: join(temp("aidlc-t240-no-rollback-bin-"), "bin"),
    });
    expect(noRollback.status).toBe(1);

    writeFileSync(join(release, "install.sh"), "tampered");
    const integrity = run(LIFECYCLE, ["package", "verify", release], project);
    expect(integrity.status).toBe(4);
  }, 60_000);

  test("same-version pinned dispatch self-heals a moved project registration", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t240-moved-machine-");
    const bin = join(machine, "bin");
    const parent = temp("aidlc-t240-moved-parent-");
    const oldProject = join(parent, "old");
    const newProject = join(parent, "new");
    mkdirSync(join(oldProject, ".git"), { recursive: true });
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    expect(run(LIFECYCLE, [
      "upgrade", "--version", AIDLC_VERSION, "--harness", "claude", "--from", release,
    ], oldProject, env).status).toBe(0);
    expect(run(INIT, [
      "init", "--project-dir", oldProject, "--from", CLAUDE_RELEASE, "--harness", "claude",
    ], oldProject, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "use", AIDLC_VERSION, "--project-dir", oldProject,
    ], oldProject, env).status).toBe(0);
    renameSync(oldProject, newProject);

    const unpinnedRoute = run(DISPATCHER, ["version", "--project-dir", newProject], newProject, env);
    expect(unpinnedRoute.status).toBe(0);
    expect(readFileSync(join(machine, "pins.json"), "utf-8")).toContain(oldProject);
    run(DISPATCHER, ["--status", "--project-dir", newProject], newProject, env);
    const pins = readFileSync(join(machine, "pins.json"), "utf-8");
    expect(pins).toContain(newProject);
    expect(pins).not.toContain(oldProject);
  }, 60_000);
});

describe("t240 projection channel", () => {
  test("release projection is stamped and contains no harness-local bun invocation", () => {
    const stamp = JSON.parse(
      readFileSync(join(CLAUDE_RELEASE, ".claude", "tools", "data", "aidlc-stamp.json"), "utf-8"),
    ) as { frameworkVersion: string; distribution: string };
    expect(stamp).toEqual(expect.objectContaining({
      frameworkVersion: AIDLC_VERSION,
      distribution: "claude",
    }));
    for (const path of walkFiles(CLAUDE_RELEASE)) {
      if (!/\.(md|json|toml|hook|ts)$/.test(path)) continue;
      const text = readFileSync(join(CLAUDE_RELEASE, path), "utf-8");
      expect(text).not.toMatch(/\bbun\s+[^\n]*\.claude\/(?:tools|hooks)\/aidlc/);
      expect(text).not.toContain("{{INVOKE}}");
    }
    expect(sha256Bytes(readFileSync(join(CLAUDE_RELEASE, ".claude", "tools", "aidlc.ts"))))
      .toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("release runtime-generated commands remain binary-invoked", () => {
    const project = temp("aidlc-t240-release-invoke-");
    mkdirSync(join(project, ".git"));
    const orchestrate = run(
      join(CLAUDE_RELEASE, ".claude", "tools", "aidlc-orchestrate.ts"),
      ["next", "--status"],
      project,
      {
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_RUNTIME_HARNESS_ROOT: join(CLAUDE_RELEASE, ".claude"),
      },
    );
    expect(orchestrate.status, orchestrate.stdout + orchestrate.stderr).toBe(0);
    const directive = JSON.parse(orchestrate.stdout) as { kind: string; message: string };
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("aidlc __delegate utility status");
    expect(directive.message).not.toContain("bun ");

    const runner = readFileSync(
      join(
        CLAUDE_RELEASE,
        ".claude",
        "skills",
        "aidlc-code-generation",
        "SKILL.md",
      ),
      "utf-8",
    );
    expect(runner).toContain("aidlc __delegate orchestrate next --stage code-generation --single");
    expect(runner).not.toContain("bun .claude/tools/aidlc-orchestrate.ts");
  });

  test("release projections carry native host trust entries", () => {
    const claudeSettings = JSON.parse(
      readFileSync(join(CLAUDE_RELEASE, ".claude", "settings.json"), "utf-8"),
    ) as { permissions: { allow: string[] } };
    expect(claudeSettings.permissions.allow).toContain("Bash(aidlc *)");
    expect(claudeSettings.permissions.allow).not.toContain("Bash");
    expect(claudeSettings.permissions.allow.some((entry) => entry.startsWith("Bash(bun "))).toBe(false);

    for (const root of KIRO_RELEASES) {
      for (const path of walkFiles(join(root, ".kiro", "agents"))) {
        if (!path.endsWith(".json")) continue;
        const value = JSON.parse(
          readFileSync(join(root, ".kiro", "agents", path), "utf-8"),
        ) as {
          toolsSettings?: { execute_bash?: { allowedCommands?: string[] } };
        };
        const allowed = value.toolsSettings?.execute_bash?.allowedCommands;
        if (!allowed) continue;
        expect(allowed).toContain("aidlc .*");
        expect(allowed.some((command) => command.startsWith("bun "))).toBe(false);
      }
      expect(readFileSync(join(root, "AGENTS.md"), "utf-8"))
        .toContain("Native installs use the self-contained `aidlc` binary");
    }
    const ideSettings = JSON.parse(
      readFileSync(join(KIRO_IDE_RELEASE, ".vscode", "settings.json"), "utf-8"),
    ) as { "kiroAgent.trustedCommands": string[] };
    expect(ideSettings["kiroAgent.trustedCommands"]).toEqual(["aidlc *"]);

    const rules = readFileSync(
      join(CODEX_RELEASE, ".codex", "rules", "default.rules"),
      "utf-8",
    );
    expect(rules).toContain('prefix_rule(pattern = ["aidlc"], decision = "allow")');
    expect(rules).not.toContain('pattern = ["bun"');
    const hooks = readFileSync(join(CODEX_RELEASE, ".codex", "hooks.json"), "utf-8");
    const trust = readFileSync(join(CODEX_RELEASE, ".codex", "trust-seed.toml"), "utf-8");
    expect(hooks).toContain("aidlc adapter codex");
    expect(trust).toContain("native `aidlc adapter codex ...`");
    expect(trust).not.toContain("bun scripts/package.ts codex trust");
    const parsedHooks = JSON.parse(hooks) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const snake: Record<string, string> = {
      SessionStart: "session_start",
      UserPromptSubmit: "user_prompt_submit",
      PreToolUse: "pre_tool_use",
      PostToolUse: "post_tool_use",
      PreCompact: "pre_compact",
      PostCompact: "post_compact",
      SubagentStop: "subagent_stop",
      Stop: "stop",
    };
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]),
        );
      }
      return value;
    };
    for (const [event, groups] of Object.entries(parsedHooks.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const identity = {
            event_name: snake[event],
            hooks: [{
              async: false,
              command: hook.command,
              timeout: 600,
              type: "command",
            }],
          };
          const hash = `sha256:${
            createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex")
          }`;
          expect(trust).toContain(`trusted_hash = "${hash}"`);
        }
      }
    }
    expect(readFileSync(join(CODEX_RELEASE, "AGENTS.md"), "utf-8"))
      .toContain("Native installs use the self-contained `aidlc` binary");
  });

  test("projection descriptors cannot name paths outside the projection", async () => {
    const root = temp("aidlc-t240-descriptor-");
    cpSync(CLAUDE_RELEASE, root, { recursive: true });
    const path = join(root, ".claude", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(path, "utf-8")) as {
      managedDirectories: string[];
    };
    descriptor.managedDirectories.push("..");
    writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
    const { projectionFiles } = await import("../../core/tools/aidlc-distribution.ts");
    expect(() => projectionFiles(root)).toThrow("safe top-level name");
  });
});
