export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unavailable: 3,
  integrity: 4,
  actionNeeded: 5,
} as const;

export type OutputMode = "human" | "quiet" | "json";

export type CommandResult = {
  ok: boolean;
  code: number;
  status: string;
  message: string;
  data?: unknown;
  remediation?: string;
};

export type GlobalOptions = {
  mode: OutputMode;
  color: boolean;
  yes: boolean;
  offline: boolean;
  verbose: boolean;
};

export function globalOptions(argv: readonly string[]): GlobalOptions {
  return {
    mode: argv.includes("--json") ? "json" : argv.includes("--quiet") ? "quiet" : "human",
    color: !argv.includes("--no-color") && !process.env.NO_COLOR,
    yes: argv.includes("--yes"),
    offline: argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1",
    verbose: argv.includes("--verbose"),
  };
}

export function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function valuesAfter(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.push(argv[++i]);
    }
  }
  return values;
}

export function emitResult(result: CommandResult, options: GlobalOptions): void {
  if (options.mode === "json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
  } else if (options.mode === "quiet") {
    const output = result.ok ? result.message : (result.remediation ?? result.message);
    if (output) process.stdout.write(`${output}\n`);
  } else {
    const label = result.code === EXIT.actionNeeded
      ? "ACTION"
      : result.ok
      ? "PASS"
      : result.code === EXIT.integrity
      ? "FAIL"
      : "ERROR";
    process.stdout.write(`${label} ${result.message}\n`);
    if (result.remediation) process.stdout.write(`Run: ${result.remediation}\n`);
  }
  process.exitCode = result.code;
}

export function usage(message: string, remediation?: string): CommandResult {
  return { ok: false, code: EXIT.usage, status: "usage", message, remediation };
}

export function failure(
  message: string,
  code: number = EXIT.failure,
  remediation?: string,
): CommandResult {
  return { ok: false, code, status: "failed", message, remediation };
}

export function success(message: string, data?: unknown): CommandResult {
  return { ok: true, code: EXIT.ok, status: "ok", message, data };
}
