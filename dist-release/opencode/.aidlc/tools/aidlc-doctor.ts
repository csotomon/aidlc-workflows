#!/usr/bin/env bun
import { parseArgs, resolveProjectDir } from "./aidlc-lib.ts";
import {
  collectDoctorReport,
  type DoctorCheck,
  type DoctorReport,
} from "./aidlc-utility.ts";
import {
  cachedUpdateState,
  refreshUpdateState,
  type UpdateState,
} from "./aidlc-update.ts";
import { collectPluginStatus } from "./aidlc-plugin.ts";
import { scanWindowsUninstallJournals } from "./aidlc-windows-uninstall.ts";

function windowsRecoveryCheck(): DoctorCheck | null {
  if (process.platform !== "win32") return null;
  const recovery = scanWindowsUninstallJournals();
  const paths = [
    ...recovery.pending.map((item) => item.path),
    ...recovery.invalid,
  ];
  return {
    pass: paths.length === 0,
    label: paths.length === 0
      ? "Windows uninstall recovery: no pending continuations"
      : `Windows uninstall recovery: ${recovery.pending.length} pending and ${recovery.invalid.length} invalid continuation(s): ${paths.join(", ")}`,
    fix: paths.length === 0
      ? undefined
      : "finish active AI-DLC commands, then run `aidlc version` to resume cleanup",
  };
}

export async function doctorUpdateState(
  flags: Record<string, string>,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): Promise<UpdateState> {
  const explicit = flags["check-updates"] === "true";
  const mayRefresh = interactive &&
    flags.json !== "true" &&
    flags.quiet !== "true";
  let update = cachedUpdateState();
  if (
    explicit ||
    (mayRefresh &&
      (update.stale === true ||
        ["stale", "absent", "unavailable"].includes(update.state)))
  ) {
    update = await refreshUpdateState(explicit ? 15_000 : 750, {
      offline: flags.offline === "true" ? true : undefined,
      baseUrl: flags["release-base-url"],
      caBundle: flags["ca-bundle"],
    });
  }
  return update;
}

function updateCheck(state: UpdateState): DoctorCheck {
  return {
    pass: state.state === "current",
    severity: state.state === "current" || state.state === "invalid-config"
      ? undefined
      : "warn",
    label: `Update: ${state.message}`,
    fix: state.state === "behind" ? "run `aidlc upgrade`" : undefined,
  };
}

function pluginCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const { statuses } = collectPluginStatus(projectDir);
  const attention = statuses.filter((status) => status.action === "attention");
  const drift = statuses.filter((status) => status.action === "sync");
  const detail = verbose && statuses.length > 0
    ? ` - ${statuses.map((status) => `${status.key ?? "host"}:${status.state}`).join(", ")}`
    : "";
  if (attention.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${attention.length} need attention${detail}`,
      fix: attention.map((status) => status.message).join("; "),
    };
  }
  if (drift.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${drift.length} require sync${detail}`,
      fix: "run `aidlc plugin sync`",
    };
  }
  return {
    pass: true,
    label: statuses.length === 0
      ? "Plugins: no AIDLC plugins installed"
      : `Plugins: composed state is current${detail}`,
  };
}

function humanReport(report: DoctorReport): string {
  let output = "AI-DLC Health Check\n";
  output += `${"\u2500".repeat(37)}\n`;
  for (const check of report.checks) {
    if (check.severity === "warn") {
      output += `!  ${check.label}`;
    } else if (check.pass) {
      output += `\u2713  ${check.label}`;
    } else {
      output += `\u2717  ${check.label}`;
    }
    if (!check.pass && check.fix) output += ` - ${check.fix}`;
    output += "\n";
  }
  output += `${"\u2500".repeat(37)}\n`;
  output += `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed\n`;
  return output;
}

export async function main(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const projectDir = resolveProjectDir(flags["project-dir"]);
  const update = await doctorUpdateState(flags);
  const checks: DoctorCheck[] = [];
  const recovery = windowsRecoveryCheck();
  if (recovery) checks.push(recovery);
  checks.push(updateCheck(update));
  checks.push(pluginCheck(projectDir, flags.verbose === "true"));
  const report = await collectDoctorReport(projectDir, checks);
  const code = update.state === "invalid-config"
    ? 2
    : report.failed > 0
    ? 1
    : 0;

  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: code === 0,
      code,
      status: report.failed > 0
        ? "failed"
        : report.warnings > 0
        ? "warning"
        : "ok",
      message: `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed`,
      data: report,
    })}\n`);
  } else if (flags.quiet === "true") {
    process.stdout.write(
      `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed\n`,
    );
  } else {
    process.stdout.write(humanReport(report));
  }
  process.exitCode = code;
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
