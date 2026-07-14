// covers: subcommand:aidlc-utility:doctor
// covers: file:aidlc-doctor-bundle
//
// t237 - the `/aidlc --doctor --export` redacted diagnostic exporter (issue
// #575). The feature was reworked to address review feedback: the flag is now
// `--export` (was `--bundle`), the relocation flag is `--output <dir>` (was
// `--bundle-out`), and the produced artifacts are named
// `aidlc-diagnostic-report-<ts>-<hash>` (dir) + `.tar.gz` (was
// `aidlc-doctor-bundle-*`). Four mechanisms in one file:
//
//   1. PURE-HELPER unit assertions import the projected module directly
//      (dist/claude/.claude/tools/aidlc-doctor-bundle.ts — the same dist path
//      t204 imports aidlc-lib from) and exercise redactString /
//      reconstructTimeline / isRecoveryBypass / adaptLegacyResult in-process.
//
//   2. END-TO-END + SECRET-CANARY assertions SPAWN the real tool the way t204 /
//      t83 do (process.execPath running aidlc-utility.ts) with
//      `doctor --export --project-dir <p> --output <p>/out`, then walk the
//      produced report directory AND extract the .tar.gz to prove that no secret
//      canary — an AWS key, a password= assignment, a foreign home path, or the
//      raw intent slug — survives into ANY emitted file. The canary test is the
//      load-bearing safety contract: the report's entire reason to exist is that
//      it is safe to hand a maintainer.
//
//   3. ROUTING assertions (Arden #1) spawn the REAL orchestrator
//      (aidlc-orchestrate.ts next --doctor --export --output <dir>) and inspect
//      the emitted directive JSON, proving parseNextFlags carries the
//      allowlisted export args through the engine into the named command — the
//      export surface reaches the tool through the real `/aidlc` path, not only
//      a direct invocation. A Kiro-parity assertion imports classifyTerminalCommand
//      so the verb-intercept seam and the engine agree on the same allowlist.
//
//   4. SAFETY-HARDENING canaries (Arden #2): a symlinked input (runtime-graph.json
//      → a secret file) must be refused, not followed; and a CUSTOM (non-core)
//      stage slug must be hashed to `<id:...>` in the report, never emitted raw.
//
// Fixture discipline mirrors t83: createTestProject() (no .claude copy — the
// shipped stage graph is simply absent, exactly as t83/t204 run), a per-test
// fresh project torn down in afterEach, audit seeded into a *.md shard the
// doctor globs via readAllAuditShards. The custom-slug test additionally copies
// the shipped .claude tree so the shipped stage graph is present and the custom
// slug is genuinely NOT a core slug.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
} from "../harness/fixtures.ts";
import {
  adaptLegacyResult,
  isRecoveryBypass,
  newRedactionContext,
  reconstructTimeline,
  redactString,
  shortHash,
  UNKNOWN,
} from "../../dist/claude/.claude/tools/aidlc-doctor-bundle.ts";
import { classifyTerminalCommand } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

// Secret canaries — none of these may appear anywhere in the emitted report.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const PASSWORD_SECRET = "supersecret123";
const HOME_PATH = "/Users/secretuser/DEV/proj";
const INTENT_SLUG = "build-auth-a1b2c3d4"; // the record-dir name → hashed

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function freshProject(): string {
  const proj = createTestProject();
  created.push(proj);
  return proj;
}

/**
 * Replace the default seeded intent with a record dir NAMED `build-auth-a1b2c3d4`
 * (so the intent slug the report hashes is our canary), seed it with a state file
 * carrying secret canaries in allowlisted fields (→ redacted) and non-allowlisted
 * fields (→ dropped) plus a `[?]` feasibility checkbox, and an audit shard whose
 * feasibility stage sits at STAGE_AWAITING_APPROVAL with no GATE_APPROVED (→ the
 * gate-unresolved diagnosis). Free-text audit fields carry the same canaries to
 * prove the field allowlist drops them.
 */
function seedCanaryIntent(proj: string): void {
  const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
  const recDir = join(intentsDir, INTENT_SLUG);
  mkdirSync(join(recDir, "audit"), { recursive: true });
  // Repoint the active-intent cursor at our named record.
  writeFileSync(join(intentsDir, "active-intent"), `${INTENT_SLUG}\n`, "utf-8");

  const state = [
    "# AI-DLC State Tracking",
    "",
    "## Project Information",
    // NON-allowlisted → dropped entirely (the foreign home path never emits).
    `- **Project Root**: ${HOME_PATH}`,
    // Allowlisted → extracted, then redacted.
    "- **Status**: InProgress",
    `- **Scope**: password=${PASSWORD_SECRET}`,
    `- **Active Agent**: ${AWS_KEY}`,
    // The raw slug in an allowlisted field: forces it through emission so the
    // intent-id hashing must fire (a redaction miss would leak it here).
    `- **Next Stage**: ${INTENT_SLUG}`,
    "- **State Version**: 7",
    "",
    "## Stage Progress",
    "### IDEATION PHASE",
    "- [?] feasibility — EXECUTE",
    "",
  ].join("\n");
  writeFileSync(join(recDir, "aidlc-state.md"), state, "utf-8");

  const audit = [
    "## Stage Started",
    "**Timestamp**: 2026-05-19T10:00:00Z",
    "**Event**: STAGE_STARTED",
    "**Stage**: feasibility",
    "",
    "## Stage Awaiting Approval",
    "**Timestamp**: 2026-05-19T11:00:00Z",
    "**Event**: STAGE_AWAITING_APPROVAL",
    "**Stage**: feasibility",
    "",
    // A non-allowlisted event with canaries in free-text fields — dropped whole.
    "## Subagent Completed",
    "**Timestamp**: 2026-05-19T09:00:00Z",
    "**Event**: SUBAGENT_COMPLETED",
    `**Details**: used ${AWS_KEY} with password=${PASSWORD_SECRET} under ${HOME_PATH}`,
    `**Message**: ${INTENT_SLUG}`,
    "",
  ].join("\n");
  writeFileSync(join(recDir, "audit", "seed.md"), audit, "utf-8");
}

interface ExportRun {
  status: number;
  out: string;
  outDir: string;
  bundleDir: string | null;
  archivePath: string | null;
}

/** Spawn `doctor --export` and locate the produced report dir + archive. */
function runExport(proj: string): ExportRun {
  const outDir = join(proj, "out");
  const res = spawnSync(
    BUN,
    [UTIL, "doctor", "--export", "--project-dir", proj, "--output", outDir],
    { encoding: "utf-8", env: { ...process.env } },
  );
  let bundleDir: string | null = null;
  let archivePath: string | null = null;
  try {
    for (const e of readdirSync(outDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith("aidlc-diagnostic-report-")) {
        bundleDir = join(outDir, e.name);
      } else if (e.isFile() && e.name.endsWith(".tar.gz")) {
        archivePath = join(outDir, e.name);
      }
    }
  } catch {
    /* outDir missing → export failed; leave nulls for the test to surface */
  }
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    outDir,
    bundleDir,
    archivePath,
  };
}

/** Every regular file under a directory tree (absolute paths). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe("t237 doctor --export diagnostic exporter (#575)", () => {
  test("1: SECRET CANARY — no secret survives into any report file or the archive", () => {
    const proj = freshProject();
    seedCanaryIntent(proj);
    const { bundleDir, archivePath } = runExport(proj);
    expect(bundleDir).not.toBeNull();

    const canaries = [AWS_KEY, PASSWORD_SECRET, `password=${PASSWORD_SECRET}`, HOME_PATH, INTENT_SLUG];

    // (a) Every file on disk under the report dir is clean.
    for (const file of walkFiles(bundleDir!)) {
      const body = readFileSync(file, "utf-8");
      for (const c of canaries) {
        expect(body, `${c} leaked into ${file}`).not.toContain(c);
      }
    }

    // (b) The packaged .tar.gz is clean too (extract every member to stdout).
    expect(archivePath).not.toBeNull();
    const extracted = spawnSync("tar", ["-xzOf", archivePath!], { encoding: "utf-8" });
    expect(extracted.status).toBe(0);
    for (const c of canaries) {
      expect(extracted.stdout, `${c} leaked into the archive`).not.toContain(c);
    }
  }, 30000);

  test("2: report dir contains report.md, report.json, manifest.json, evidence/normalized.json", () => {
    const proj = freshProject();
    seedCanaryIntent(proj);
    const { bundleDir } = runExport(proj);
    expect(bundleDir).not.toBeNull();
    const rel = walkFiles(bundleDir!).map((f) => f.slice(bundleDir!.length + 1).replace(/\\/g, "/"));
    expect(rel).toContain("report.md");
    expect(rel).toContain("report.json");
    expect(rel).toContain("manifest.json");
    expect(rel).toContain("evidence/normalized.json");
  }, 30000);

  test("3: report.json exposes findings + timeline.stages and the gate-unresolved error", () => {
    const proj = freshProject();
    seedCanaryIntent(proj);
    const { bundleDir } = runExport(proj);
    expect(bundleDir).not.toBeNull();
    const report = JSON.parse(readFileSync(join(bundleDir!, "report.json"), "utf-8"));
    expect(Array.isArray(report.findings)).toBe(true);
    expect(Array.isArray(report.timeline.stages)).toBe(true);
    const gate = report.findings.find((f: { id: string }) => f.id === "gate-unresolved");
    expect(gate).toBeDefined();
    expect(gate.severity).toBe("error");
  }, 30000);

  test("4: manifest.json carries real sha256 checksums, versions, hashed intent id, excluded + files", () => {
    const proj = freshProject();
    seedCanaryIntent(proj);
    const { bundleDir } = runExport(proj);
    expect(bundleDir).not.toBeNull();
    const manifest = JSON.parse(readFileSync(join(bundleDir!, "manifest.json"), "utf-8"));
    expect(typeof manifest.bundleSchemaVersion).toBe("string");
    expect(typeof manifest.aidlcVersion).toBe("string");
    expect(typeof manifest.intentIdHash).toBe("string");
    expect(Array.isArray(manifest.excluded)).toBe(true);
    // Raw bodies must be named as excluded.
    expect(manifest.excluded.join("\n")).toContain("aidlc-state.md (raw)");
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/); // real hash, never <redacted-hex>
      expect(f.sha256).not.toBe("<redacted-hex>");
    }
  }, 30000);

  test("5: redactString scrubs home, project dir, AWS key, and password= assignment", () => {
    const ctx = newRedactionContext("/tmp/my-secret-proj");
    const home = homedir();

    const redHome = redactString(`config lives at ${home}/.aidlc`, ctx);
    expect(redHome).toContain("~/.aidlc");
    expect(redHome).not.toContain(home);

    const redProj = redactString("/tmp/my-secret-proj/aidlc/state.md", ctx);
    expect(redProj).toContain("<project>");
    expect(redProj).not.toContain("/tmp/my-secret-proj");

    expect(redactString(AWS_KEY, ctx)).not.toContain(AWS_KEY);

    const redPw = redactString(`password=${PASSWORD_SECRET}`, ctx);
    expect(redPw).not.toContain(PASSWORD_SECRET);
    expect(redPw).toContain("<redacted>");
  });

  test("6: reconstructTimeline durations + gate for a complete stage, incomplete flag for a torn one", () => {
    const audit = [
      "## a started",
      "**Timestamp**: 2026-01-01T00:00:00Z",
      "**Event**: STAGE_STARTED",
      "**Stage**: stagea",
      "",
      "## a completed",
      "**Timestamp**: 2026-01-01T01:00:00Z",
      "**Event**: STAGE_COMPLETED",
      "**Stage**: stagea",
      "",
      "## a gate",
      "**Timestamp**: 2026-01-01T01:30:00Z",
      "**Event**: GATE_APPROVED",
      "**Stage**: stagea",
      "",
      "## b started",
      "**Timestamp**: 2026-01-01T02:00:00Z",
      "**Event**: STAGE_STARTED",
      "**Stage**: stageb",
      "",
    ].join("\n");

    const tl = reconstructTimeline(audit, "");
    const a = tl.stages.find((s) => s.slug === "stagea");
    const b = tl.stages.find((s) => s.slug === "stageb");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Complete stage: numeric duration (1h) and a resolved gate.
    expect(typeof a!.durationMs).toBe("number");
    expect(a!.durationMs).toBe(60 * 60 * 1000);
    expect(a!.gate).toBe("approved");
    expect(a!.abnormal).not.toContain("incomplete");
    // Torn stage: never completed → incomplete flag + unknown completion.
    expect(b!.abnormal).toContain("incomplete");
    expect(b!.completedRaw).toBe(UNKNOWN);
    expect(b!.durationMs).toBeNull();
  });

  test("7: isRecoveryBypass flags AIDLC_DISABLE_* remedies; adaptLegacyResult maps pass/fail severity", () => {
    expect(
      isRecoveryBypass("Set AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 to bypass the validation."),
    ).toBe(true);
    expect(isRecoveryBypass("Re-run the compile step and continue.")).toBe(false);

    const fail = adaptLegacyResult({ pass: false, label: "hooks wired", fix: "wire the hook" });
    expect(fail.severity).toBe("error");

    const ok = adaptLegacyResult({ pass: true, label: "bun installed" });
    expect(ok.severity).toBe("info");
    expect(ok.safeToAutomate).toBe(true);
  });

  test("8: ROUTING — the engine carries `--export --output <dir>` into the named doctor command (Arden #1)", () => {
    const outDir = "/tmp/aidlc-export-routing-x";
    // The real `/aidlc` path: aidlc-orchestrate `next` parses the flags and emits
    // the terminal print directive naming the exact aidlc-utility.ts command.
    const withExport = spawnSync(
      BUN,
      [ORCH, "next", "--doctor", "--export", "--output", outDir],
      { encoding: "utf-8", env: { ...process.env } },
    );
    expect(withExport.status).toBe(0);
    const dir = JSON.parse((withExport.stdout ?? "").trim());
    expect(dir.kind).toBe("print");
    // parseNextFlags carried the allowlisted trailing args through the engine.
    expect(dir.message).toContain("doctor --export --output");
    expect(dir.message).toContain(outDir);

    // A plain `--doctor` (no export) names the doctor command WITHOUT --export.
    const plain = spawnSync(BUN, [ORCH, "next", "--doctor"], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(plain.status).toBe(0);
    const plainDir = JSON.parse((plain.stdout ?? "").trim());
    expect(plainDir.kind).toBe("print");
    expect(plainDir.message).toContain("aidlc-utility.ts doctor");
    expect(plainDir.message).not.toContain("--export");
  });

  test("9: KIRO PARITY — classifyTerminalCommand carries the same allowlisted export args", () => {
    const withArgs = classifyTerminalCommand(["--doctor", "--export", "--output", "/tmp/x"]);
    expect(withArgs).toEqual({
      subcommand: "doctor",
      source: "read-only-flag",
      extraArgs: ["--export", "--output", "/tmp/x"],
    });

    // A bare `--doctor` carries no extraArgs (undefined, not an empty array).
    const bare = classifyTerminalCommand(["--doctor"]);
    expect(bare).toEqual({ subcommand: "doctor", source: "read-only-flag" });
    expect(bare?.extraArgs).toBeUndefined();
  });

  test("10: SYMLINK CANARY — a symlinked runtime-graph.json input is refused, not followed (Arden #2)", () => {
    const proj = freshProject();
    seedCanaryIntent(proj);

    // Plant a secret-bearing file and symlink the active intent's
    // runtime-graph.json at it. safeRead/isSymlink must refuse the link, so the
    // secret never enters the report.
    const SYMLINK_SECRET = "TOPSECRET_SYMLINK_TARGET";
    const secretTarget = join(proj, "symlink-secret-target.json");
    writeFileSync(
      secretTarget,
      JSON.stringify({ stages: [{ slug: SYMLINK_SECRET, phase: SYMLINK_SECRET }] }),
      "utf-8",
    );
    const rgLink = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "intents",
      INTENT_SLUG,
      "runtime-graph.json",
    );
    symlinkSync(secretTarget, rgLink);

    const { bundleDir, archivePath } = runExport(proj);
    expect(bundleDir).not.toBeNull();

    // (a) No file on disk under the report dir carries the symlink target secret.
    for (const file of walkFiles(bundleDir!)) {
      expect(readFileSync(file, "utf-8"), `${SYMLINK_SECRET} leaked into ${file}`).not.toContain(
        SYMLINK_SECRET,
      );
    }
    // (b) The archive is clean too.
    expect(archivePath).not.toBeNull();
    const extracted = spawnSync("tar", ["-xzOf", archivePath!], { encoding: "utf-8" });
    expect(extracted.status).toBe(0);
    expect(extracted.stdout, `${SYMLINK_SECRET} leaked into the archive`).not.toContain(
      SYMLINK_SECRET,
    );
  }, 30000);

  test("11: CUSTOM-IDENTIFIER CANARY — a non-core stage slug is hashed, never emitted raw (Arden #2)", () => {
    const proj = freshProject();
    // Copy the shipped .claude tree so the shipped stage graph is present and the
    // custom slug is genuinely NOT one of the 32 core slugs (readShippedStageGraph
    // resolves join(projectDir, ".claude", "tools/data/stage-graph.json")).
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });

    const CUSTOM_SLUG = "my-custom-secret-stage"; // a slug NOT in the shipped graph
    const recDir = seededRecordDir(proj); // active-intent points here (default fixture record)
    mkdirSync(join(recDir, "audit"), { recursive: true });

    const state = [
      "# AI-DLC State Tracking",
      "",
      "## Project Information",
      "- **Status**: InProgress",
      `- **Current Stage**: ${CUSTOM_SLUG}`,
      "- **State Version**: 7",
      "",
      "## Stage Progress",
      "### CONSTRUCTION PHASE",
      `- [?] ${CUSTOM_SLUG} — EXECUTE`,
      "",
    ].join("\n");
    writeFileSync(join(recDir, "aidlc-state.md"), state, "utf-8");

    // An audit STAGE_STARTED for the custom slug surfaces it on the timeline, so
    // seedCustomIdentifiers seeds it into the redaction context (→ hashed).
    const audit = [
      "## Stage Started",
      "**Timestamp**: 2026-05-19T10:00:00Z",
      "**Event**: STAGE_STARTED",
      `**Stage**: ${CUSTOM_SLUG}`,
      "",
    ].join("\n");
    writeFileSync(join(recDir, "audit", "seed.md"), audit, "utf-8");

    const { bundleDir } = runExport(proj);
    expect(bundleDir).not.toBeNull();

    // The raw custom slug must not appear in the human or machine report — it is
    // hashed to `<id:...>`.
    const reportMd = readFileSync(join(bundleDir!, "report.md"), "utf-8");
    const reportJson = readFileSync(join(bundleDir!, "report.json"), "utf-8");
    const normalized = readFileSync(join(bundleDir!, "evidence", "normalized.json"), "utf-8");
    expect(reportMd, "custom slug leaked into report.md").not.toContain(CUSTOM_SLUG);
    expect(reportJson, "custom slug leaked into report.json").not.toContain(CUSTOM_SLUG);
    expect(normalized, "custom slug leaked into normalized.json").not.toContain(CUSTOM_SLUG);
    // Positive control: the slug was hashed, not merely absent — its exact
    // `<id:<8-hex>>` token appears where the raw slug would have been.
    const expectedId = `<id:${shortHash(CUSTOM_SLUG)}>`;
    expect(reportJson).toContain(expectedId);
  }, 30000);
});
