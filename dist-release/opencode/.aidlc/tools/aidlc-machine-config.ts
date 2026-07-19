#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  type CommandResult,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
} from "./aidlc-command.ts";
import {
  installRoot,
  machineTransactionRoot,
} from "./aidlc-install-paths.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";

export type MachineConfig = {
  schemaVersion: 1;
  "update-check"?: boolean;
  offline?: boolean;
  "release-base-url"?: string;
  "ca-bundle"?: string;
};

export type MachineConfigKey = Exclude<keyof MachineConfig, "schemaVersion">;

const CONFIG_KEYS: readonly MachineConfigKey[] = [
  "update-check",
  "offline",
  "release-base-url",
  "ca-bundle",
];

export function machineConfigPath(): string {
  return join(installRoot(), "config.json");
}

export function updateCachePath(): string {
  return join(installRoot(), "update-check.json");
}

export function defaultHarnessPath(): string {
  return join(installRoot(), "default-harness");
}

function validReleaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) return false;
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"));
  } catch {
    return false;
  }
}

function validateMachineConfig(value: unknown): MachineConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("machine config must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", ...CONFIG_KEYS]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`machine config contains unknown key(s): ${unknown.join(", ")}`);
  }
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported machine config schema ${String(record.schemaVersion)}`);
  }
  for (const key of ["update-check", "offline"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`machine config ${key} must be true or false`);
    }
  }
  if (
    record["release-base-url"] !== undefined &&
    (typeof record["release-base-url"] !== "string" ||
      !validReleaseUrl(record["release-base-url"]))
  ) {
    throw new Error(
      "machine config release-base-url must be HTTPS without credentials, query, or fragment",
    );
  }
  if (
    record["ca-bundle"] !== undefined &&
    (typeof record["ca-bundle"] !== "string" ||
      !isAbsolute(record["ca-bundle"]))
  ) {
    throw new Error("machine config ca-bundle must be an absolute path");
  }
  return record as MachineConfig;
}

export function readMachineConfig(): MachineConfig {
  const path = machineConfigPath();
  if (!existsSync(path)) return { schemaVersion: 1 };
  try {
    return validateMachineConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeMachineConfig(config: MachineConfig): void {
  const valid = validateMachineConfig(config);
  const path = machineConfigPath();
  const root = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, path),
      `${JSON.stringify(valid, null, 2)}\n`,
      transactionState(path),
      0o600,
    )],
  });
}

export function resolvedReleaseSettings(options: {
  offline?: boolean;
  baseUrl?: string;
  caBundle?: string;
} = {}): {
  offline: boolean;
  baseUrl?: string;
  caBundle?: string;
} {
  const config = readMachineConfig();
  const envOffline = process.env.AIDLC_OFFLINE;
  return {
    offline: options.offline ??
      (envOffline === "1" ? true : envOffline === "0" ? false : undefined) ??
      config.offline ??
      false,
    baseUrl: options.baseUrl ||
      process.env.AIDLC_RELEASE_BASE_URL ||
      config["release-base-url"],
    caBundle: options.caBundle ||
      process.env.AIDLC_CA_BUNDLE ||
      config["ca-bundle"],
  };
}

function parseBoolean(value: string): boolean | null {
  if (["true", "on", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "off", "0", "no"].includes(value.toLowerCase())) return false;
  return null;
}

function parseValue(key: MachineConfigKey, value: string): string | boolean {
  if (key === "update-check" || key === "offline") {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      throw new Error(`${key} expects true/false or on/off`);
    }
    return parsed;
  }
  if (key === "release-base-url") {
    if (!validReleaseUrl(value)) {
      throw new Error(
        "release-base-url must be HTTPS without credentials, query, or fragment",
      );
    }
    return value.replace(/\/+$/, "");
  }
  if (!isAbsolute(value)) throw new Error("ca-bundle must be an absolute path");
  return value;
}

function machineConfigCommand(argv: string[]): CommandResult {
  if (argv[0] !== "global") {
    return usage("usage: aidlc config global <get|set|clear|list>");
  }
  const verb = argv[1];
  let config: MachineConfig;
  try {
    config = readMachineConfig();
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      2,
      "repair or remove the invalid machine config",
    );
  }
  if (verb === "list") {
    return success(
      CONFIG_KEYS.map((key) =>
        `${key}=${config[key] === undefined ? "<default>" : String(config[key])}`
      ).join("\n"),
      { config },
    );
  }
  const key = argv[2] as MachineConfigKey | undefined;
  if (!key || !CONFIG_KEYS.includes(key)) {
    return usage(`config global ${verb ?? "<verb>"} requires one of: ${CONFIG_KEYS.join(", ")}`);
  }
  if (verb === "get") {
    return success(
      `${key}=${config[key] === undefined ? "<default>" : String(config[key])}`,
      { key, value: config[key] ?? null },
    );
  }
  if (verb === "clear") {
    try {
      delete config[key];
      writeMachineConfig(config);
      return success(`cleared machine config ${key}`, { key, value: null });
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (verb !== "set") {
    return usage("usage: aidlc config global <get|set|clear|list>");
  }
  const raw = argv[3];
  if (!raw || raw.startsWith("--")) {
    return usage(`config global set ${key} requires a value`);
  }
  try {
    const value = parseValue(key, raw);
    Object.assign(config, { [key]: value });
    writeMachineConfig(config);
    return success(`set machine config ${key}=${String(value)}`, { key, value });
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      2,
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  let result = machineConfigCommand(argv);
  if (
    result.ok &&
    argv[1] === "list" &&
    globalOptions(argv).mode === "human" &&
    process.stdout.isTTY
  ) {
    try {
      const { cachedUpdateNotice } = await import("./aidlc-update.ts");
      const notice = cachedUpdateNotice();
      if (notice) result = { ...result, message: `${result.message}\n${notice}` };
    } catch {
      // Ambient config discovery is cache-only and never makes listing fail.
    }
  }
  emitResult(result, globalOptions(argv));
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
