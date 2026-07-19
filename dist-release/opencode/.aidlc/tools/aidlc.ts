#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  errorMessage,
  parseWorkspaceCommand,
  workspaceCommandUtilityArgv,
} from "./aidlc-lib.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import {
  installRoot,
  inspectInstalledVersion,
  installedVersionFingerprint,
  machineTransactionRoot,
  projectDirFrom,
  STRICT_SEMVER,
  versionRoot,
} from "./aidlc-install-paths.ts";
import { executePlan, transactionState, writeOperation } from "./aidlc-transaction.ts";
import {
  discoverProjectHarnesses,
  packagedDistributionRoot,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import { cachedUpdateNotice } from "./aidlc-update.ts";
import {
  recoverWindowsUninstallContinuations,
} from "./aidlc-windows-uninstall.ts";

type Classification = "passthrough" | "translation" | "stub" | "routing-only" | "help";
type RouteKind =
  | "top-passthrough"
  | "top-prefix"
  | "top-stub"
  | "top-help"
  | "noun-passthrough"
  | "noun-map"
  | "custom"
  | "routing-only";

type HelpLine = {
  command: string;
  summary: string;
};

type CustomRoute = "workspace" | "config" | "plugin" | "gen";
type RouteOnly = "hook" | "statusline" | "adapter" | "delegate";
type Visibility = "public" | "hidden" | "legacy";
type ProjectRequirement = "none" | "optional" | "required";
type PinPolicy = "active" | "inspect" | "pinned";
type NetworkPolicy = "forbidden" | "explicit-only" | "interactive-bounded" | "required";
type MutationScope = "none" | "project" | "machine" | "project-and-machine";

export type Route = {
  id: string;
  group: string;
  kind: RouteKind;
  classification: Classification;
  verbs: readonly string[];
  tool?: string;
  prefix?: readonly string[];
  targets?: Readonly<Record<string, string>>;
  custom?: CustomRoute;
  routeOnly?: RouteOnly;
  visibility: Visibility;
  projectRequirement: ProjectRequirement;
  pinPolicy: PinPolicy;
  networkPolicy: NetworkPolicy;
  mutationScope: MutationScope;
  outputModes: readonly ("human" | "quiet" | "json")[];
  human?: readonly HelpLine[];
  all?: readonly string[];
};

const PUBLIC_ENGINE = {
  visibility: "public",
  projectRequirement: "required",
  pinPolicy: "pinned",
  networkPolicy: "forbidden",
  mutationScope: "project",
  outputModes: ["human", "json"],
} as const;

const HIDDEN_ENGINE = {
  ...PUBLIC_ENGINE,
  visibility: "hidden",
} as const;

type Alias = {
  from: string;
  to: string;
  irregular?: boolean;
};

export const TOOLS = {
  audit: "aidlc-audit.ts",
  bolt: "aidlc-bolt.ts",
  graph: "aidlc-graph.ts",
  doctor: "aidlc-doctor.ts",
  init: "aidlc-init.ts",
  jump: "aidlc-jump.ts",
  learnings: "aidlc-learnings.ts",
  log: "aidlc-log.ts",
  lifecycle: "aidlc-lifecycle.ts",
  machineConfig: "aidlc-machine-config.ts",
  completions: "aidlc-completions.ts",
  orchestrate: "aidlc-orchestrate.ts",
  plugin: "aidlc-plugin.ts",
  runnerGen: "aidlc-runner-gen.ts",
  runtime: "aidlc-runtime.ts",
  sensor: "aidlc-sensor.ts",
  sensorLinter: "aidlc-sensor-linter.ts",
  sensorRequiredSections: "aidlc-sensor-required-sections.ts",
  sensorTypeCheck: "aidlc-sensor-type-check.ts",
  sensorUpstreamCoverage: "aidlc-sensor-upstream-coverage.ts",
  state: "aidlc-state.ts",
  swarm: "aidlc-swarm.ts",
  utility: "aidlc-utility.ts",
  validate: "aidlc-validate.ts",
  worktree: "aidlc-worktree.ts",
} as const;

export const SLASH_FLAG_ALIASES: readonly Alias[] = [
  { from: "--status", to: "status" },
  { from: "--doctor", to: "doctor" },
  { from: "--help", to: "help" },
  { from: "--version", to: "version" },
  { from: "--resume", to: "next --resume", irregular: true },
  { from: "--scope", to: "next --scope", irregular: true },
  { from: "--upgrade", to: "upgrade", irregular: true },
  { from: "config-change", to: "config set", irregular: true },
  { from: "space-create", to: "space create", irregular: true },
];

// ROUTES_TABLE_START
export const ROUTES: readonly Route[] = [
  {
    id: "top-orchestrate",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["next", "report", "park"],
    tool: TOOLS.orchestrate,
    ...PUBLIC_ENGINE,
    human: [
      { command: "next [args]", summary: "run the next orchestrator action" },
      { command: "report [args]", summary: "render the orchestrator report" },
      { command: "park [args]", summary: "park the current workflow" },
    ],
    all: ["next [args]", "report [args]", "park [args]"],
  },
  {
    id: "top-compose",
    group: "top",
    kind: "top-prefix",
    classification: "translation",
    verbs: ["compose"],
    tool: TOOLS.orchestrate,
    prefix: ["next", "compose"],
    ...PUBLIC_ENGINE,
    human: [{ command: "compose [args]", summary: "start composition through orchestrate next compose" }],
    all: ["compose [args]"],
  },
  {
    id: "top-status",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["status"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    mutationScope: "none",
    human: [
      { command: "status [args]", summary: "show the current AIDLC status" },
    ],
    all: ["status [args]"],
  },
  {
    id: "top-recompose",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["recompose"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    human: [
      { command: "recompose [args]", summary: "rerun composition through the utility handler" },
    ],
    all: ["recompose [args]"],
  },
  {
    id: "top-doctor",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["doctor"],
    tool: TOOLS.doctor,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "inspect",
    networkPolicy: "interactive-bounded",
    mutationScope: "project-and-machine",
    outputModes: ["human", "quiet", "json"],
    human: [
      { command: "doctor [--check-updates]", summary: "run environment diagnostics" },
    ],
    all: [
      "doctor [--verbose] [--json] [--quiet] [--check-updates] [--release-base-url <url>] [--ca-bundle <path>]",
    ],
  },
  {
    id: "top-version",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["version"],
    tool: TOOLS.utility,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human"],
    human: [{ command: "version [args]", summary: "print the installed AIDLC version" }],
    all: ["version [args]"],
  },
  {
    id: "top-help",
    group: "top",
    kind: "top-help",
    classification: "help",
    verbs: ["help"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human"],
    all: ["help [--all]"],
  },
  {
    id: "top-init",
    group: "top",
    kind: "top-passthrough",
    classification: "translation",
    verbs: ["init"],
    tool: TOOLS.init,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "inspect",
    networkPolicy: "forbidden",
    mutationScope: "project",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "init [args]", summary: "initialize or refresh this project" }],
    all: ["init [--harness <name>] [--from <path>] [--dry-run] [--force]"],
  },
  {
    id: "top-upgrade",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["upgrade", "update"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [
      { command: "upgrade [args]", summary: "install and activate a framework release" },
    ],
    all: [
      "upgrade [--version <version>] [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>] [--check|--dry-run]",
      "update [--version <version>] [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>] [--check|--dry-run]",
    ],
  },
  {
    id: "top-rollback",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["rollback"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "rollback [args]", summary: "activate a retained framework release" }],
    all: ["rollback [--version <version>|--list]"],
  },
  {
    id: "top-use",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["use"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "required",
    pinPolicy: "inspect",
    networkPolicy: "forbidden",
    mutationScope: "project-and-machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "use <version|current>", summary: "set or clear this project's version pin" }],
    all: ["use <version|current>"],
  },
  {
    id: "top-uninstall",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["uninstall"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "uninstall [--purge]", summary: "remove the machine installation" }],
    all: ["uninstall [--purge] [--yes]"],
  },
  {
    id: "top-completions",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["completions"],
    tool: TOOLS.completions,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human"],
    human: [{ command: "completions <shell>", summary: "emit shell completion definitions" }],
    all: ["completions <bash|zsh|fish|powershell>"],
  },
  {
    id: "versions-list",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "versions list", summary: "inspect retained releases" }],
    all: ["list"],
  },
  {
    id: "versions-install",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["install"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "versions install", summary: "install a retained release" }],
    all: [
      "install <version> [--harness <name>] [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>]",
    ],
  },
  {
    id: "versions-prune",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["prune"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["prune [--yes]"],
  },
  {
    id: "package-create",
    group: "package",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["create"],
    tool: TOOLS.lifecycle,
    prefix: ["package"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "package create", summary: "create an offline release set" }],
    all: [
      "create [--version <version>] --harness <name> --target <triple> --output <directory> [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>]",
    ],
  },
  {
    id: "package-verify",
    group: "package",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["verify"],
    tool: TOOLS.lifecycle,
    prefix: ["package"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "package verify", summary: "verify an offline release set" }],
    all: ["verify <directory>"],
  },
  {
    id: "harness-add",
    group: "harness",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["add"],
    tool: TOOLS.lifecycle,
    prefix: ["harness"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: [
      "add <name> [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>]",
    ],
  },
  {
    id: "harness-mutate",
    group: "harness",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["remove", "default"],
    tool: TOOLS.lifecycle,
    prefix: ["harness"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["remove <name> [--yes]", "default <name|clear>"],
  },
  {
    id: "harness-list",
    group: "harness",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list"],
    tool: TOOLS.lifecycle,
    prefix: ["harness"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "harness <add|remove|list|default>", summary: "manage installed harnesses" }],
    all: ["list"],
  },
  {
    id: "state-passthrough",
    group: "state",
    kind: "noun-passthrough",
    classification: "passthrough",
    tool: TOOLS.state,
    ...HIDDEN_ENGINE,
    verbs: [
      "get",
      "set",
      "set-skeleton-stance",
      "set-construction-iteration",
      "checkbox",
      "count",
      "advance",
      "finalize",
      "complete-workflow",
      "gate-start",
      "approve",
      "reject",
      "revise",
      "skip",
      "resume",
      "acknowledge-compaction",
      "reuse-artifact",
      "lookup",
      "practices-event",
      "practices-promote",
      "fork",
      "merge",
      "park",
      "unpark",
    ],
  },
  {
    id: "state-utility",
    group: "state",
    kind: "noun-map",
    classification: "translation",
    verbs: ["set-status", "init"],
    tool: TOOLS.utility,
    ...HIDDEN_ENGINE,
    targets: { "set-status": "set-status", init: "state-init" },
  },
  {
    id: "audit-passthrough",
    group: "audit",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["append", "append-raw"],
    tool: TOOLS.audit,
    ...HIDDEN_ENGINE,
  },
  {
    id: "audit-renames",
    group: "audit",
    kind: "noun-map",
    classification: "translation",
    verbs: ["fork", "merge"],
    tool: TOOLS.audit,
    ...HIDDEN_ENGINE,
    targets: { fork: "audit-fork", merge: "audit-merge" },
  },
  {
    id: "graph",
    group: "graph",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: [
      "artifacts",
      "producers",
      "consumers",
      "topo",
      "cycles",
      "scope",
      "validate-scope",
      "validate-grid",
      "compile",
      "resolve",
      "export",
    ],
    tool: TOOLS.graph,
    ...HIDDEN_ENGINE,
  },
  {
    id: "runtime",
    group: "runtime",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["compile", "read", "summary", "fragment-fork", "fragment-merge"],
    tool: TOOLS.runtime,
    ...HIDDEN_ENGINE,
  },
  {
    id: "sensor",
    group: "sensor",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list", "describe", "fire"],
    tool: TOOLS.sensor,
    ...HIDDEN_ENGINE,
  },
  {
    id: "swarm",
    group: "swarm",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["prepare", "check", "finalize"],
    tool: TOOLS.swarm,
    ...HIDDEN_ENGINE,
  },
  {
    id: "bolt",
    group: "bolt",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["start", "complete", "fail", "abort", "set-autonomy", "dispatch-event", "hold-merge", "release-merge"],
    tool: TOOLS.bolt,
    ...HIDDEN_ENGINE,
  },
  {
    id: "worktree",
    group: "worktree",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["create", "merge", "discard", "list", "verify", "info"],
    tool: TOOLS.worktree,
    ...HIDDEN_ENGINE,
  },
  {
    id: "jump",
    group: "jump",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["resolve", "execute"],
    tool: TOOLS.jump,
    ...HIDDEN_ENGINE,
  },
  {
    id: "log",
    group: "log",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["decision", "answer"],
    tool: TOOLS.log,
    ...HIDDEN_ENGINE,
  },
  {
    id: "learnings",
    group: "learnings",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["surface", "persist"],
    tool: TOOLS.learnings,
    ...HIDDEN_ENGINE,
  },
  {
    id: "validate",
    group: "validate",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["outputs"],
    tool: TOOLS.validate,
    ...HIDDEN_ENGINE,
  },
  {
    id: "intent",
    group: "intent",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "birth"],
    custom: "workspace",
    ...PUBLIC_ENGINE,
    human: [{ command: "intent [list|switch|birth]", summary: "list, switch, or create intent context" }],
    all: ["list [--json]", "switch <name>", "<name>", "birth [args]"],
  },
  {
    id: "space",
    group: "space",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "create"],
    custom: "workspace",
    ...PUBLIC_ENGINE,
    human: [{ command: "space [list|switch|create]", summary: "list, switch, or create a space" }],
    all: ["list", "switch <name>", "<name>", "create <name>"],
  },
  {
    id: "scope",
    group: "scope",
    kind: "noun-map",
    classification: "translation",
    verbs: ["change", "detect", "resolve-env"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    targets: { change: "scope-change", detect: "detect-scope", "resolve-env": "resolve-env-scope" },
  },
  {
    id: "config-global",
    group: "config",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["global"],
    tool: TOOLS.machineConfig,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["global <get|set|clear|list>"],
  },
  {
    id: "config",
    group: "config",
    kind: "custom",
    classification: "translation",
    verbs: ["set depth", "set test-strategy", "get", "list"],
    custom: "config",
    ...PUBLIC_ENGINE,
    targets: {
      "set depth": "config-change",
      "set test-strategy": "config-change",
      get: "config-get",
      list: "config-list",
    },
    human: [
      { command: "config get <key>", summary: "print supported project configuration" },
      { command: "config set <key> <value>", summary: "change supported project configuration" },
      { command: "config list", summary: "list supported project configuration" },
    ],
    all: ["set depth <value>", "set test-strategy <value>", "get <key>", "list"],
  },
  {
    id: "plugin",
    group: "plugin",
    kind: "custom",
    classification: "translation",
    verbs: ["select", "sync", "list"],
    custom: "plugin",
    ...PUBLIC_ENGINE,
    targets: { select: "select-plugins", sync: "sync", list: "list" },
    human: [
      { command: "plugin select [names]", summary: "set enabled plugins" },
      { command: "plugin list [--verbose|--json]", summary: "compare installed and composed plugins" },
      { command: "plugin sync [--prune-missing]", summary: "transactionally compose installed plugins" },
    ],
    all: ["select [names]", "sync [--prune-missing] [--yes]", "list [--verbose] [--json]"],
  },
  {
    id: "gen",
    group: "gen",
    kind: "custom",
    classification: "translation",
    verbs: ["runners", "runners --check", "runner-list", "runner-scopes", "stage-table", "scope-table"],
    custom: "gen",
    tool: TOOLS.runnerGen,
    ...HIDDEN_ENGINE,
    all: ["runners [args]", "runners --check", "runner-list", "runner-scopes", "stage-table [args]", "scope-table [args]"],
  },
  {
    id: "workspace",
    group: "workspace",
    kind: "noun-map",
    classification: "translation",
    verbs: ["detect", "codekb"],
    tool: TOOLS.utility,
    ...HIDDEN_ENGINE,
    targets: { detect: "detect", codekb: "codekb-path" },
  },
  {
    id: "delegate",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["__delegate"],
    routeOnly: "delegate",
    visibility: "hidden",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "project-and-machine",
    outputModes: ["human", "quiet", "json"],
    all: [],
  },
  {
    id: "hook",
    group: "hook",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<name>"],
    routeOnly: "hook",
    ...HIDDEN_ENGINE,
    all: ["<name>"],
  },
  {
    id: "statusline",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["statusline"],
    routeOnly: "statusline",
    ...HIDDEN_ENGINE,
    all: ["statusline"],
  },
  {
    id: "adapter",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["adapter"],
    routeOnly: "adapter",
    ...HIDDEN_ENGINE,
    all: ["adapter <harness> <target> [args]"],
  },
];
// ROUTES_TABLE_END

export type Action =
  | { type: "delegate"; tool: string; args: string[] }
  | { type: "hook"; name: string; path: string; projectDir?: string }
  | { type: "statusline"; path: string; projectDir?: string }
  | { type: "adapter"; harness: AdapterHarness; target: string; extraArgs: string[]; path: string; projectDir?: string }
  | { type: "sensor-script-file"; id: string; args: string[]; projectDir?: string }
  | { type: "version" }
  | { type: "stub"; message: string; code: number }
  | { type: "help"; all: boolean }
  | { type: "error"; message: string; code: number };

function text(fd: number, value: string | Uint8Array): void {
  if (typeof value === "string") {
    writeSync(fd, value);
    return;
  }
  writeSync(fd, value);
}

function dispatcherDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function toolsDir(): string {
  // Test seam for parity suites that need one dispatcher copy to delegate to a
  // different generated tools tree. Production resolves sibling tools beside
  // this dispatcher.
  const fromEnv = process.env.AIDLC_DISPATCH_TOOLS_DIR;
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  return dispatcherDir();
}

type AdapterHarness = "codex" | "kiro" | "kiro-ide";

const ADAPTER_HARNESS_LEAF: Record<AdapterHarness, string> = {
  codex: ".codex",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
};

function isAdapterHarness(value: string): value is AdapterHarness {
  return Object.hasOwn(ADAPTER_HARNESS_LEAF, value);
}

function resolveHookPath(
  file: string,
  harness?: AdapterHarness,
  projectDir = process.cwd(),
): string {
  const moduleRelative = join(dispatcherDir(), "..", "hooks", file);
  const runtimeLeaf = harness
    ? ADAPTER_HARNESS_LEAF[harness]
    : runtimeHarnessDir(projectDir);
  const leaves = harness
    ? [ADAPTER_HARNESS_LEAF[harness]]
    : [
        runtimeLeaf,
        ...discoverProjectHarnesses(projectDir).map((candidate) => candidate.harnessDir),
      ].filter((value, index, values): value is string =>
        typeof value === "string" && value.length > 0 && values.indexOf(value) === index
      );
  const installed = leaves.map((leaf) => join(projectDir, leaf, "hooks", file));
  const executableRelative = join(
    packagedDistributionRoot(runtimeLeaf, harness),
    runtimeLeaf,
    "hooks",
    file,
  );
  const candidates = [moduleRelative, ...installed, executableRelative];
  return candidates.find((candidate) => existsSync(candidate)) ?? moduleRelative;
}

function routeForms(route: Route): string[] {
  if (route.all) return [...route.all];
  return [...route.verbs];
}

export function listRoutes(): readonly Route[] {
  return ROUTES;
}

export function renderHumanHelp(): string {
  const lines: string[] = ["aidlc <noun> <verb> [args]", "", "Human commands:"];
  const commands = ROUTES.flatMap((route) => [...(route.human ?? [])]);
  const width = Math.max(...commands.map((line) => line.command.length));
  for (const line of commands) {
    lines.push(`  ${line.command.padEnd(width)}  ${line.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderAllHelp(): string {
  const lines: string[] = ["aidlc <noun> <verb> [args]", "", "Top level:"];
  for (const route of ROUTES.filter((item) => item.group === "top")) {
    for (const form of routeForms(route)) lines.push(`  ${form}`);
  }

  lines.push("", "conductor protocol - not a stable scripting interface", "Plumbing:");
  const grouped = new Map<string, string[]>();
  for (const route of ROUTES.filter((item) => item.group !== "top")) {
    grouped.set(route.group, [...(grouped.get(route.group) ?? []), ...routeForms(route)]);
  }
  for (const [group, forms] of grouped) {
    lines.push(`  ${group}: ${forms.join(", ")}`);
  }

  lines.push("", "Slash-flag aliases:");
  for (const alias of SLASH_FLAG_ALIASES) {
    const mark = alias.irregular ? " (irregular)" : "";
    lines.push(`  ${alias.from} -> ${alias.to}${mark}`);
  }
  return `${lines.join("\n")}\n`;
}

function topLevelError(command: string): Action {
  return {
    type: "error",
    code: 2,
    message: `aidlc: unknown command or noun '${command}'; try 'aidlc --help'\n`,
  };
}

function nounError(noun: string, verb: string | undefined): Action {
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    type: "error",
    code: 2,
    message: `aidlc: ${detail} for noun '${noun}'; try 'aidlc help --all'\n`,
  };
}

function requireValue(noun: string, verb: string, value: string | undefined): Action | undefined {
  if (value) return undefined;
  return nounError(noun, verb);
}

function isSafeName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

// TRANSLATION_LOGIC_START
function handleWorkspace(argv: string[]): Action {
  const command = parseWorkspaceCommand(argv);
  if (command.kind === "not-workspace") return nounError(argv[0], argv[1]);
  if (command.kind === "error") {
    return { type: "error", code: 2, message: `${command.message}\n` };
  }
  const utilityArgv = workspaceCommandUtilityArgv(command);
  if (utilityArgv === null) return nounError(argv[0], argv[1]);
  return { type: "delegate", tool: TOOLS.utility, args: utilityArgv };
}

function handleConfig(route: Route, argv: string[]): Action {
  const verb = argv[1];
  if (argv.includes("--global")) {
    const args = argv.filter((value) => value !== "--global");
    if (["get", "set", "clear", "list"].includes(verb ?? "")) {
      return {
        type: "delegate",
        tool: TOOLS.machineConfig,
        args: ["global", verb, ...args.slice(2)],
      };
    }
  }
  if (verb === "get" || verb === "list") {
    const target = route.targets?.[verb];
    if (target) return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  if (verb !== "set") return nounError("config", verb);

  const key = argv[2];
  const value = argv[3];
  if (key === "depth") {
    const missing = requireValue("config", "set depth", value);
    if (missing) return missing;
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", "--depth", value, ...argv.slice(4)] };
  }
  if (key === "test-strategy") {
    const missing = requireValue("config", "set test-strategy", value);
    if (missing) return missing;
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", "--test-strategy", value, ...argv.slice(4)] };
  }
  return nounError("config", key ? `set ${key}` : "set");
}

function handlePlugin(route: Route, argv: string[]): Action {
  const verb = argv[1];
  if (verb === "select") {
    const target = route.targets?.select ?? "select-plugins";
    return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  if (verb === "sync" || verb === "list") {
    const target = route.targets?.[verb];
    if (target) return { type: "delegate", tool: TOOLS.plugin, args: [target, ...argv.slice(2)] };
  }
  return nounError("plugin", verb);
}

function handleGen(argv: string[]): Action {
  const verb = argv[1];
  if (verb === "runners") {
    // Keep --check as a flag-shaped route. Other runner flags are passed
    // through unchanged, including Windows callers that avoid shell redirects.
    if (argv[2] === "--check") {
      return { type: "delegate", tool: TOOLS.runnerGen, args: ["check", ...argv.slice(3)] };
    }
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["write", ...argv.slice(2)] };
  }
  if (verb === "runner-list") {
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["list", ...argv.slice(2)] };
  }
  if (verb === "runner-scopes") {
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["scopes", ...argv.slice(2)] };
  }
  if (verb === "stage-table" || verb === "scope-table") {
    return { type: "delegate", tool: TOOLS.utility, args: [verb, ...argv.slice(2)] };
  }
  return nounError("gen", verb);
}

function handleCustom(route: Route, argv: string[]): Action {
  if (route.custom === "workspace") return handleWorkspace(argv);
  if (route.custom === "config") return handleConfig(route, argv);
  if (route.custom === "plugin") return handlePlugin(route, argv);
  if (route.custom === "gen") return handleGen(argv);
  return nounError(argv[0], argv[1]);
}

function handleRouteOnly(route: Route, argv: string[]): Action {
  if (route.routeOnly === "delegate") {
    const name = argv[1];
    if (!name || !isSafeName(name)) return topLevelError(argv.slice(0, 2).join(" "));
    const byStem: Readonly<Record<string, string>> = {
      audit: TOOLS.audit,
      bolt: TOOLS.bolt,
      graph: TOOLS.graph,
      doctor: TOOLS.doctor,
      init: TOOLS.init,
      jump: TOOLS.jump,
      learnings: TOOLS.learnings,
      lifecycle: TOOLS.lifecycle,
      "machine-config": TOOLS.machineConfig,
      completions: TOOLS.completions,
      log: TOOLS.log,
      orchestrate: TOOLS.orchestrate,
      "runner-gen": TOOLS.runnerGen,
      runtime: TOOLS.runtime,
      sensor: TOOLS.sensor,
      "sensor-linter": TOOLS.sensorLinter,
      "sensor-required-sections": TOOLS.sensorRequiredSections,
      "sensor-type-check": TOOLS.sensorTypeCheck,
      "sensor-upstream-coverage": TOOLS.sensorUpstreamCoverage,
      state: TOOLS.state,
      swarm: TOOLS.swarm,
      utility: TOOLS.utility,
      validate: TOOLS.validate,
      worktree: TOOLS.worktree,
    };
    const tool = byStem[name];
    return tool
      ? { type: "delegate", tool, args: argv.slice(2) }
      : topLevelError(argv.slice(0, 2).join(" "));
  }
  if (route.routeOnly === "hook") {
    const name = argv[1];
    if (!name) return nounError("hook", undefined);
    if (!isSafeName(name)) return nounError("hook", name);
    return { type: "hook", name, path: resolveHookPath(`aidlc-${name}.ts`) };
  }
  if (route.routeOnly === "statusline") {
    return { type: "statusline", path: resolveHookPath("aidlc-statusline.ts") };
  }
  if (route.routeOnly === "adapter") {
    const harness = argv[1];
    const target = argv[2];
    if (!harness) return nounError("adapter", undefined);
    if (!isAdapterHarness(harness)) return nounError("adapter", harness);
    if (!target) return nounError("adapter", undefined);
    if (!isSafeName(target)) return nounError("adapter", target);
    const file = harness === "codex" ? "aidlc-codex-adapter.ts" : "aidlc-kiro-adapter.ts";
    return {
      type: "adapter",
      harness,
      target,
      extraArgs: argv.slice(3),
      path: resolveHookPath(file, harness),
    };
  }
  return nounError(argv[0], argv[1]);
}

function resolveAlias(argv: string[]): Action | undefined {
  const head = argv[0];
  if (head === "space-create") return handleWorkspace(argv);
  if (head === "__sensor-script-file") {
    const id = argv[1];
    if (!id || !isSafeName(id)) {
      return topLevelError(argv.slice(0, 2).join(" "));
    }
    return {
      type: "sensor-script-file",
      id,
      args: argv.slice(2),
    };
  }
  if (head === "__sensor-script") {
    const scripts: Record<string, string> = {
      linter: TOOLS.sensorLinter,
      "required-sections": TOOLS.sensorRequiredSections,
      "type-check": TOOLS.sensorTypeCheck,
      "upstream-coverage": TOOLS.sensorUpstreamCoverage,
    };
    const tool = scripts[argv[1] ?? ""];
    return tool
      ? { type: "delegate", tool, args: argv.slice(2) }
      : topLevelError(argv.slice(0, 2).join(" "));
  }
  if (head === "--status") return { type: "delegate", tool: TOOLS.utility, args: ["status", ...argv.slice(1)] };
  if (head === "--doctor") return { type: "delegate", tool: TOOLS.doctor, args: ["doctor", ...argv.slice(1)] };
  if (head === "--version") return { type: "version" };
  if (head === "--resume") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--resume", ...argv.slice(1)] };
  if (head === "--scope") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--scope", ...argv.slice(1)] };
  if (head === "--upgrade") return { type: "delegate", tool: TOOLS.lifecycle, args: ["upgrade", ...argv.slice(1)] };
  if (head === "config-change") {
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", ...argv.slice(1)] };
  }
  return undefined;
}

function resolveTop(argv: string[]): Action | undefined {
  const verb = argv[0];
  for (const route of ROUTES.filter((item) => item.group === "top")) {
    if (!route.verbs.includes(verb)) continue;

    if (route.kind === "top-passthrough" && route.tool) {
      if (verb === "version") return { type: "version" };
      return { type: "delegate", tool: route.tool, args: [verb, ...argv.slice(1)] };
    }
    if (route.kind === "top-prefix" && route.tool && route.prefix) {
      return { type: "delegate", tool: route.tool, args: [...route.prefix, ...argv.slice(1)] };
    }
    if (route.kind === "top-stub") {
      return {
        type: "stub",
        code: 3,
        message: "reserved; not available in this install\n",
      };
    }
    if (route.kind === "top-help") return { type: "help", all: argv[1] === "--all" };
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);
  }
  return undefined;
}

function resolveNoun(argv: string[]): Action | undefined {
  const noun = argv[0];
  const routes = ROUTES.filter((item) => item.group === noun);
  if (routes.length === 0) return undefined;

  for (const route of routes) {
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);

    const verb = argv[1];
    if (!verb || !route.verbs.includes(verb)) continue;

    if (route.kind === "top-stub") {
      return {
        type: "stub",
        code: 3,
        message: `${noun} ${verb} is reserved for the next lifecycle release\n`,
      };
    }
    if (route.kind === "noun-passthrough" && route.tool) {
      return {
        type: "delegate",
        tool: route.tool,
        args: [...(route.prefix ?? []), verb, ...argv.slice(2)],
      };
    }
    if (route.kind === "noun-map" && route.tool && route.targets) {
      return { type: "delegate", tool: route.tool, args: [route.targets[verb], ...argv.slice(2)] };
    }
  }

  const custom = routes.find((route) => route.kind === "custom");
  if (custom) return handleCustom(custom, argv);
  return nounError(noun, argv[1]);
}

function resolveActionWithoutGlobalFlags(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { type: "help", all: false };
  }
  if (argv[0] === "help") {
    return { type: "help", all: argv[1] === "--all" };
  }

  const alias = resolveAlias(argv);
  if (alias) return alias;

  const top = resolveTop(argv);
  if (top) return top;

  const noun = resolveNoun(argv);
  if (noun) return noun;

  return topLevelError(argv[0]);
}

export function resolveAction(argv: string[]): Action {
  const clean: string[] = [];
  const globalFlags: string[] = [];
  let projectDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (["--json", "--quiet", "--no-color", "--yes", "--offline", "--verbose"].includes(argv[i])) {
      globalFlags.push(argv[i]);
      continue;
    }
    if (argv[i] !== "--project-dir") {
      clean.push(argv[i]);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      return {
        type: "error",
        code: 2,
        message: "aidlc: --project-dir requires a path value\n",
      };
    }
    projectDir = value;
  }

  const action = resolveActionWithoutGlobalFlags(clean);
  if (projectDir) {
    const absoluteProjectDir = isAbsolute(projectDir)
      ? projectDir
      : resolve(process.cwd(), projectDir);
    if (action.type === "delegate") {
      action.args.push("--project-dir", absoluteProjectDir);
    } else if (action.type === "hook") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath(`aidlc-${action.name}.ts`, undefined, absoluteProjectDir);
    } else if (action.type === "statusline") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath("aidlc-statusline.ts", undefined, absoluteProjectDir);
    } else if (action.type === "adapter") {
      action.projectDir = absoluteProjectDir;
      const file = action.harness === "codex"
        ? "aidlc-codex-adapter.ts"
        : "aidlc-kiro-adapter.ts";
      action.path = resolveHookPath(file, action.harness, absoluteProjectDir);
    } else if (action.type === "sensor-script-file") {
      action.projectDir = absoluteProjectDir;
    }
  }
  if (action.type === "delegate") action.args.push(...globalFlags);
  return action;
}
// TRANSLATION_LOGIC_END

function toolPath(tool: string): string {
  return join(toolsDir(), tool);
}

function bunExecutable(): string {
  return basename(process.execPath).startsWith("bun") ? process.execPath : "bun";
}

function delegatedProjectDir(args: readonly string[]): string | undefined {
  const index = args.indexOf("--project-dir");
  return index >= 0 ? args[index + 1] : undefined;
}

function runDelegateDev(tool: string, args: string[]): number {
  try {
    const child = Bun.spawnSync([bunExecutable(), toolPath(tool), ...args], { /* dev-mode bun spawn */
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        ...(delegatedProjectDir(args)
          ? { AIDLC_PROJECT_DIR: delegatedProjectDir(args) }
          : {}),
      },
    });
    return child.exitCode ?? 1;
  } catch (error) {
    text(2, `aidlc: failed to spawn ${tool}: ${String(error)}\n`);
    return 1;
  }
}

type DelegateModule = {
  main(argv: string[]): void | Promise<void>;
};

async function loadDelegate(tool: string): Promise<DelegateModule | null> {
  switch (tool) {
    case TOOLS.audit:
      return import("./aidlc-audit.ts");
    case TOOLS.bolt:
      return import("./aidlc-bolt.ts");
    case TOOLS.graph:
      return import("./aidlc-graph.ts");
    case TOOLS.doctor:
      return import("./aidlc-doctor.ts");
    case TOOLS.init:
      return import("./aidlc-init.ts");
    case TOOLS.jump:
      return import("./aidlc-jump.ts");
    case TOOLS.learnings:
      return import("./aidlc-learnings.ts");
    case TOOLS.log:
      return import("./aidlc-log.ts");
    case TOOLS.lifecycle:
      return import("./aidlc-lifecycle.ts");
    case TOOLS.machineConfig:
      return import("./aidlc-machine-config.ts");
    case TOOLS.completions:
      return import("./aidlc-completions.ts");
    case TOOLS.orchestrate:
      return import("./aidlc-orchestrate.ts");
    case TOOLS.plugin:
      return import("./aidlc-plugin.ts");
    case TOOLS.runnerGen:
      return import("./aidlc-runner-gen.ts");
    case TOOLS.runtime:
      return import("./aidlc-runtime.ts");
    case TOOLS.sensor:
      return import("./aidlc-sensor.ts");
    case TOOLS.sensorLinter:
      return import("./aidlc-sensor-linter.ts");
    case TOOLS.sensorRequiredSections:
      return import("./aidlc-sensor-required-sections.ts");
    case TOOLS.sensorTypeCheck:
      return import("./aidlc-sensor-type-check.ts");
    case TOOLS.sensorUpstreamCoverage:
      return import("./aidlc-sensor-upstream-coverage.ts");
    case TOOLS.state:
      return import("./aidlc-state.ts");
    case TOOLS.swarm:
      return import("./aidlc-swarm.ts");
    case TOOLS.utility:
      return import("./aidlc-utility.ts");
    case TOOLS.validate:
      return import("./aidlc-validate.ts");
    case TOOLS.worktree:
      return import("./aidlc-worktree.ts");
    default:
      return null;
  }
}

async function runDelegateInProcess(tool: string, args: string[]): Promise<number> {
  const previousProjectDir = process.env.AIDLC_PROJECT_DIR;
  const projectDir = delegatedProjectDir(args);
  if (projectDir) process.env.AIDLC_PROJECT_DIR = projectDir;
  try {
    const mod = await loadDelegate(tool);
    if (mod === null || typeof mod.main !== "function") {
      text(2, `${JSON.stringify({ error: `${tool} does not export main(argv)` })}\n`);
      return 1;
    }
    await mod.main(args);
    const code = process.exitCode;
    if (typeof code === "number") return code;
    return code ? Number(code) || 1 : 0;
  } catch (error) {
    text(2, `${JSON.stringify({ error: errorMessage(error) })}\n`);
    return 1;
  } finally {
    if (previousProjectDir === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = previousProjectDir;
  }
}

let bufferedStdin: string | null = null;

async function readStdin(): Promise<string> {
  if (bufferedStdin === null) bufferedStdin = await Bun.stdin.text();
  return bufferedStdin;
}

async function withProjectDir(
  projectDir: string | undefined,
  run: () => Promise<number>,
): Promise<number> {
  if (!projectDir) return await run();
  const previousAidlc = process.env.AIDLC_PROJECT_DIR;
  const previousClaude = process.env.CLAUDE_PROJECT_DIR;
  process.env.AIDLC_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  try {
    return await run();
  } finally {
    if (previousAidlc === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = previousAidlc;
    if (previousClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousClaude;
  }
}

async function runHook(action: Extract<Action, { type: "hook" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, `aidlc hook ${action.name}: not available in this install\n`);
    return 1;
  }
  const mod = await import(pathToFileURL(action.path).href);
  if (typeof mod.run !== "function") {
    text(2, `aidlc hook ${action.name}: hook does not export run(input)\n`);
    return 1;
  }
  return await mod.run(await readStdin());
}

async function runStatusline(action: Extract<Action, { type: "statusline" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, "aidlc statusline: not available in this install\n");
    return 1;
  }
  const mod = await import(pathToFileURL(action.path).href);
  if (typeof mod.run !== "function") {
    text(2, "aidlc statusline: hook does not export run(input)\n");
    return 1;
  }
  return await mod.run(await readStdin());
}

async function runAdapter(action: Extract<Action, { type: "adapter" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, `aidlc adapter ${action.harness} ${action.target}: not available in this install\n`);
    return 1;
  }
  const previousHarness = process.env.AIDLC_HARNESS_DIR;
  const previousExecutable = process.env.AIDLC_COMPILED_EXECUTABLE;
  process.env.AIDLC_HARNESS_DIR = ADAPTER_HARNESS_LEAF[action.harness];
  if (import.meta.url.includes("/$bunfs/")) {
    process.env.AIDLC_COMPILED_EXECUTABLE = process.execPath;
  }
  try {
    const mod = await import(pathToFileURL(action.path).href);
    if (typeof mod.run !== "function") {
      text(2, `aidlc adapter ${action.harness} ${action.target}: adapter does not export run(target, input, extraArgs)\n`);
      return 1;
    }
    const input = action.harness === "kiro-ide"
      ? (bufferedStdin ?? "")
      : await readStdin();
    return await mod.run(action.target, input, action.extraArgs);
  } finally {
    if (previousHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = previousHarness;
    if (previousExecutable === undefined) delete process.env.AIDLC_COMPILED_EXECUTABLE;
    else process.env.AIDLC_COMPILED_EXECUTABLE = previousExecutable;
  }
}

async function runSensorScriptFile(
  action: Extract<Action, { type: "sensor-script-file" }>,
): Promise<number> {
  const sensorModule = await import("./aidlc-sensor.ts") as {
    resolveSensorScriptPath?: (id: string) => string;
  };
  if (typeof sensorModule.resolveSensorScriptPath !== "function") {
    text(2, "aidlc sensor worker: resolver unavailable\n");
    return 1;
  }
  let path: string;
  try {
    path = sensorModule.resolveSensorScriptPath(action.id);
  } catch (error) {
    text(2, `aidlc sensor worker: ${errorMessage(error)}\n`);
    return 1;
  }
  if (!existsSync(path)) {
    text(2, `aidlc sensor worker: not found: ${path}\n`);
    return 1;
  }
  const mod = await import(pathToFileURL(path).href) as {
    main?: (argv: string[]) => void | Promise<void>;
  };
  if (typeof mod.main !== "function") {
    text(2, `aidlc sensor worker: ${path} does not export main(argv)\n`);
    return 1;
  }
  await mod.main(action.args);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function execute(action: Action): Promise<number> {
  const isCompiled = import.meta.url.includes("/$bunfs/");
  if (action.type === "delegate") {
    // Tool modules are imported lazily in compiled mode to keep dev-mode startup
    // fast and to avoid loading every tool for help/version calls.
    return isCompiled
      ? await runDelegateInProcess(action.tool, action.args)
      : runDelegateDev(action.tool, action.args);
  }
  if (action.type === "help") {
    text(1, action.all ? renderAllHelp() : renderHumanHelp());
    if (!action.all && process.stdout.isTTY) {
      try {
        const notice = cachedUpdateNotice();
        if (notice) text(1, `\n${notice}\n`);
      } catch {
        // Ambient discovery never makes help fail.
      }
    }
    return 0;
  }
  if (action.type === "version") {
    text(1, `aidlc ${AIDLC_VERSION}\n`);
    return 0;
  }
  if (action.type === "hook") {
    return await withProjectDir(action.projectDir, () => runHook(action));
  }
  if (action.type === "statusline") {
    return await withProjectDir(action.projectDir, () => runStatusline(action));
  }
  if (action.type === "adapter") {
    return await withProjectDir(action.projectDir, () => runAdapter(action));
  }
  if (action.type === "sensor-script-file") {
    return await withProjectDir(action.projectDir, () => runSensorScriptFile(action));
  }
  if (action.type === "stub" || action.type === "error") {
    text(2, action.message);
    return action.code;
  }
  return 1;
}

function withoutProjectDirFlag(argv: readonly string[]): string[] {
  const clean: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (["--json", "--quiet", "--no-color", "--yes", "--offline", "--verbose"].includes(argv[index])) {
      continue;
    }
    if (argv[index] === "--project-dir") {
      index++;
      continue;
    }
    clean.push(argv[index]);
  }
  return clean;
}

function routeById(id: string): Route {
  const route = ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`dispatcher route registry is missing ${id}`);
  return route;
}

export function routePolicyFor(argv: readonly string[]): Route | null {
  const clean = withoutProjectDirFlag(argv);
  const head = clean[0];
  if (!head || head === "--help" || head === "-h" || head === "help") {
    return routeById("top-help");
  }
  const aliasRoutes: Readonly<Record<string, string>> = {
    "--status": "top-status",
    "--doctor": "top-doctor",
    "--version": "top-version",
    "--resume": "top-orchestrate",
    "--scope": "top-orchestrate",
    "--upgrade": "top-upgrade",
    "config-change": "config",
    "space-create": "space",
    "__sensor-script": "sensor",
    "__sensor-script-file": "sensor",
  };
  if (aliasRoutes[head]) return routeById(aliasRoutes[head]);

  if (head === "__delegate") {
    const delegate = clean[1];
    const command = clean[2];
    if (delegate === "lifecycle") {
      if (command === "upgrade" || command === "update") return routeById("top-upgrade");
      if (command === "rollback") return routeById("top-rollback");
      if (command === "use") return routeById("top-use");
      if (command === "versions") {
        return routeById(
          clean[3] === "list"
            ? "versions-list"
            : clean[3] === "prune"
            ? "versions-prune"
            : "versions-install",
        );
      }
      if (command === "harness") {
        return routeById(clean[3] === "list" ? "harness-list" : clean[3] === "add" ? "harness-add" : "harness-mutate");
      }
      if (command === "uninstall") return routeById("top-uninstall");
      if (command === "package") {
        return routeById(clean[3] === "verify" ? "package-verify" : "package-create");
      }
      return routeById("delegate");
    }
    if (delegate === "init") return routeById("top-init");
    if (delegate === "utility") {
      const utilityRoutes: Readonly<Record<string, string>> = {
        help: "top-help",
        version: "top-version",
        status: "top-status",
        doctor: "top-doctor",
        "intent-birth": "intent",
        intent: "intent",
        space: "space",
        "space-create": "space",
        "codekb-path": "workspace",
        detect: "workspace",
        "select-plugins": "plugin",
        "plugin-list": "plugin",
        "plugin-sync": "plugin",
        init: "top-init",
        "state-init": "state-utility",
        upgrade: "top-upgrade",
        "scope-change": "scope",
        recompose: "top-recompose",
        "config-change": "config",
        "config-get": "config",
        "config-list": "config",
        "set-status": "state-utility",
        "detect-scope": "scope",
        "resolve-env-scope": "scope",
        "scope-table": "gen",
        "stage-table": "gen",
      };
      const routeId = utilityRoutes[command ?? ""];
      if (routeId) return routeById(routeId);
      return routeById("delegate");
    }
    const toolByDelegate: Readonly<Record<string, string>> = {
      audit: TOOLS.audit,
      bolt: TOOLS.bolt,
      graph: TOOLS.graph,
      jump: TOOLS.jump,
      learnings: TOOLS.learnings,
      log: TOOLS.log,
      orchestrate: TOOLS.orchestrate,
      "runner-gen": TOOLS.runnerGen,
      runtime: TOOLS.runtime,
      sensor: TOOLS.sensor,
      "sensor-linter": TOOLS.sensorLinter,
      "sensor-required-sections": TOOLS.sensorRequiredSections,
      "sensor-type-check": TOOLS.sensorTypeCheck,
      "sensor-upstream-coverage": TOOLS.sensorUpstreamCoverage,
      state: TOOLS.state,
      swarm: TOOLS.swarm,
      validate: TOOLS.validate,
      worktree: TOOLS.worktree,
    };
    const tool = toolByDelegate[delegate ?? ""];
    if (!tool) return routeById("delegate");
    const exact = ROUTES.find((route) =>
      route.tool === tool &&
      (route.verbs.includes(command ?? "") ||
        Object.values(route.targets ?? {}).includes(command ?? ""))
    );
    return exact ?? ROUTES.find((route) => route.tool === tool) ?? routeById("delegate");
  }

  const top = ROUTES.find((route) =>
    route.group === "top" && route.verbs.includes(head)
  );
  if (top) return top;
  const nounRoutes = ROUTES.filter((route) => route.group === head);
  if (nounRoutes.length === 0) return null;
  const verb = clean[1];
  if (head === "config" && clean.includes("--global")) return routeById("config-global");
  return nounRoutes.find((route) => route.verbs.includes(verb ?? "")) ??
    nounRoutes.find((route) =>
      route.kind === "routing-only" && route.verbs.includes("<name>")
    ) ??
    nounRoutes.find((route) => route.kind === "custom") ??
    null;
}

function routePinPolicy(argv: readonly string[]): PinPolicy {
  return routePolicyFor(argv)?.pinPolicy ?? "active";
}

function projectDistribution(projectDir: string): string | null {
  const harnessDir = runtimeHarnessDir(projectDir);
  return discoverProjectHarnesses(projectDir)
    .find((candidate) => candidate.harnessDir === harnessDir)?.distribution ?? null;
}

type PinResolutionCache = {
  schemaVersion: 1;
  session: string;
  version: string;
  distribution: string | null;
  fingerprint: string;
  validatedAt: number;
};

const PIN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pinSessionId(argv: readonly string[], input: string | null): string | null {
  if (input) {
    try {
      const value = JSON.parse(input) as { session_id?: unknown };
      if (typeof value.session_id === "string" && value.session_id.length > 0) {
        return value.session_id;
      }
    } catch {
      // Host-specific fallbacks below cover transports without JSON stdin.
    }
  }
  const clean = withoutProjectDirFlag(argv);
  if (clean[0] === "adapter" && clean[1] === "kiro-ide") {
    const vscodePid = process.env.VSCODE_PID?.trim();
    const vscodeIpc = process.env.VSCODE_IPC_HOOK?.trim();
    if (vscodePid || vscodeIpc) {
      return `kiro-ide:${vscodePid ?? ""}:${vscodeIpc ?? ""}`;
    }
  }
  return null;
}

function pinCachePath(projectDir: string, sessionId: string): string {
  const project = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
  return join(
    installRoot(),
    "pin-resolution-cache",
    `${hashIdentity(project)}-${hashIdentity(sessionId)}.json`,
  );
}

function readPinCache(projectDir: string, sessionId: string): PinResolutionCache | null {
  try {
    const value = JSON.parse(
      readFileSync(pinCachePath(projectDir, sessionId), "utf-8"),
    ) as PinResolutionCache;
    return value.schemaVersion === 1 &&
        typeof value.session === "string" &&
        typeof value.version === "string" &&
        (value.distribution === null || typeof value.distribution === "string") &&
        typeof value.fingerprint === "string" &&
        typeof value.validatedAt === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}

function writePinCache(
  projectDir: string,
  sessionId: string,
  version: string,
  distribution: string | null,
  fingerprint: string,
): void {
  const path = pinCachePath(projectDir, sessionId);
  const root = machineTransactionRoot();
  const value: PinResolutionCache = {
    schemaVersion: 1,
    session: hashIdentity(sessionId),
    version,
    distribution,
    fingerprint,
    validatedAt: Date.now(),
  };
  executePlan({
    schemaVersion: 1,
    root,
    operations: [writeOperation(
      relative(root, path),
      `${JSON.stringify(value, null, 2)}\n`,
      transactionState(path),
    )],
  });
}

function completePinnedVersion(
  projectDir: string,
  sessionId: string | null,
  version: string,
  distribution: string | null,
): boolean {
  try {
    const fingerprint = installedVersionFingerprint(version);
    if (sessionId && fingerprint) {
      const cache = readPinCache(projectDir, sessionId);
      if (
        cache &&
        cache.session === hashIdentity(sessionId) &&
        cache.version === version &&
        cache.distribution === distribution &&
        cache.fingerprint === fingerprint &&
        Date.now() - cache.validatedAt >= 0 &&
        Date.now() - cache.validatedAt <= PIN_CACHE_MAX_AGE_MS
      ) {
        return true;
      }
    }
    const inspection = inspectInstalledVersion(version, distribution);
    if (!inspection.complete) return false;
    const verifiedFingerprint = installedVersionFingerprint(version);
    if (!verifiedFingerprint || (fingerprint && fingerprint !== verifiedFingerprint)) return false;
    if (sessionId) {
      try {
        writePinCache(projectDir, sessionId, version, distribution, verifiedFingerprint);
      } catch {
        // A cache failure may cost latency, but cannot weaken or block pin enforcement.
      }
    }
    return true;
  } catch {
    return false;
  }
}

function reconcilePinRegistration(projectDir: string, version: string): void {
  const path = join(installRoot(), "pins.json");
  let pins: Record<string, string> = {};
  try {
    if (existsSync(path)) pins = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return;
  }
  const project = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
  let changed = pins[project] !== version;
  for (const [registered, pinned] of Object.entries(pins)) {
    if (pinned === version && registered !== project && !existsSync(registered)) {
      delete pins[registered];
      changed = true;
    }
  }
  if (!changed) return;
  pins[project] = version;
  const machineRoot = machineTransactionRoot();
  executePlan({
    schemaVersion: 1,
    root: machineRoot,
    operations: [writeOperation(
      relative(machineRoot, path),
      `${JSON.stringify(pins, null, 2)}\n`,
      transactionState(path),
    )],
  });
}

function dispatchPinnedVersion(argv: string[], input: string | null): number | null {
  if (routePinPolicy(argv) !== "pinned") return null;
  const projectDir = projectDirFrom(argv);
  const pinPath = join(projectDir, ".aidlc-version");
  if (!existsSync(pinPath)) return null;
  const version = readFileSync(pinPath, "utf-8").trim();
  if (!STRICT_SEMVER.test(version)) {
    return renderDispatcherFailure(
      argv,
      2,
      `${pinPath} must contain one strict semver`,
      "aidlc use current",
    );
  }
  if (process.env.AIDLC_PIN_DISPATCHED === version) return null;
  const distribution = projectDistribution(projectDir);
  if (!completePinnedVersion(projectDir, pinSessionId(argv, input), version, distribution)) {
    return renderDispatcherFailure(
      argv,
      1,
      `this project requires ${version}, which is not installed completely`,
      `aidlc versions install ${version}`,
    );
  }
  reconcilePinRegistration(projectDir, version);
  if (version === AIDLC_VERSION) return null;
  const executable = join(versionRoot(version), process.platform === "win32" ? "aidlc.exe" : "aidlc");
  const child = Bun.spawnSync([executable, ...argv], {
    cwd: process.cwd(),
    stdin: input === null ? "inherit" : new TextEncoder().encode(input),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, AIDLC_PIN_DISPATCHED: version, AIDLC_ACTIVE_VERSION: AIDLC_VERSION },
  });
  return child.exitCode ?? 1;
}

function refuseUnpinnedMajorSkew(argv: readonly string[]): number | null {
  if (routePinPolicy(argv) !== "pinned") return null;
  const projectDir = projectDirFrom(argv);
  if (existsSync(join(projectDir, ".aidlc-version"))) return null;
  for (const harness of discoverProjectHarnesses(projectDir)) {
    if (
      harness.frameworkVersion &&
      harness.frameworkVersion.split(".")[0] !== AIDLC_VERSION.split(".")[0]
    ) {
      return renderDispatcherFailure(
        argv,
        1,
        `project runtime ${harness.frameworkVersion} is incompatible with selected engine ${AIDLC_VERSION}`,
        "aidlc use <installed-version> or aidlc init",
      );
    }
  }
  return null;
}

function requestedOutputMode(argv: readonly string[]): "human" | "quiet" | "json" {
  if (argv.includes("--json")) return "json";
  if (argv.includes("--quiet")) return "quiet";
  return "human";
}

function renderDispatcherFailure(
  argv: readonly string[],
  code: number,
  message: string,
  remediation?: string,
): number {
  const cleanMessage = message.replace(/^aidlc:\s*/, "").trim();
  const mode = requestedOutputMode(argv);
  if (mode === "json") {
    text(1, `${
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        code,
        status: code === 2 ? "usage" : code === 3 ? "unavailable" : "failed",
        message: cleanMessage,
        ...(remediation ? { remediation } : {}),
      })
    }\n`);
  } else if (mode === "quiet") {
    text(1, `${remediation ?? cleanMessage}\n`);
  } else {
    text(2, `aidlc: ${cleanMessage}\n`);
    if (remediation) text(2, `Run: ${remediation}\n`);
  }
  return code;
}

function basicPolicyError(route: Route, argv: readonly string[]): string | null {
  const output = requestedOutputMode(argv);
  if (!route.outputModes.includes(output)) {
    return `${route.id} does not support --${output}`;
  }
  if (route.networkPolicy === "required" && argv.includes("--offline")) {
    return `${route.id} requires network access and cannot run with --offline`;
  }
  return null;
}

function projectPolicyError(route: Route, argv: readonly string[]): string | null {
  if (route.projectRequirement !== "required") return null;
  const projectDir = projectDirFrom(argv);
  const recognized = [
    ".git",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "aidlc",
  ].some((entry) => existsSync(join(projectDir, entry))) ||
    discoverProjectHarnesses(projectDir).length > 0;
  return recognized
    ? null
    : `${route.id} requires an installed project harness or recognized project directory; run aidlc init`;
}

async function withRoutePolicy(route: Route, argv: readonly string[], run: () => Promise<number>): Promise<number> {
  const values: Record<string, string> = {
    AIDLC_ROUTE_ID: route.id,
    AIDLC_ROUTE_NETWORK_POLICY: route.networkPolicy,
    AIDLC_ROUTE_MUTATION_SCOPE: route.mutationScope,
    AIDLC_ROUTE_PROJECT_DIR: projectDirFrom(argv),
    AIDLC_ROUTE_OUTPUT_MODE: requestedOutputMode(argv),
  };
  const prior = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  process.exitCode = 0;
  bufferedStdin = null;
  if (import.meta.url.includes("/$bunfs/") && !process.env.AIDLC_HARNESS_DIR) {
    // Compiled, no explicit harness: discover the project install from its
    // shipped stamp/harness metadata. Module-relative derivation cannot work
    // from $bunfs, and every delegate and sibling tool reads this env, so pin
    // the discovered answer once here. Falls back to .claude when no install
    // is present.
    process.env.AIDLC_HARNESS_DIR = runtimeHarnessDir();
  }
  if (
    process.platform === "win32" &&
    !["doctor", "--doctor", "uninstall"].includes(argv[0] ?? "")
  ) {
    try {
      const recovered = recoverWindowsUninstallContinuations();
      if (recovered > 0) {
        process.exitCode = renderDispatcherFailure(
          argv,
          3,
          `resumed ${recovered} pending Windows uninstall continuation(s); this command was not run`,
        );
        return;
      }
    } catch (error) {
      process.exitCode = renderDispatcherFailure(
        argv,
        1,
        `Windows uninstall recovery failed: ${errorMessage(error)}`,
        "aidlc doctor",
      );
      return;
    }
  }
  const route = routePolicyFor(argv);
  if (route) {
    const error = basicPolicyError(route, argv);
    if (error) {
      process.exitCode = renderDispatcherFailure(argv, 2, error);
      return;
    }
  }
  if (
    route?.routeOnly === "hook" ||
    route?.routeOnly === "statusline" ||
    (route?.routeOnly === "adapter" && withoutProjectDirFlag(argv)[1] !== "kiro-ide")
  ) {
    await readStdin();
  }
  const pinnedCode = dispatchPinnedVersion(argv, bufferedStdin);
  if (pinnedCode !== null) {
    process.exitCode = pinnedCode;
    return;
  }
  const skewCode = refuseUnpinnedMajorSkew(argv);
  if (skewCode !== null) {
    process.exitCode = skewCode;
    return;
  }
  if (route) {
    const error = projectPolicyError(route, argv);
    if (error) {
      process.exitCode = renderDispatcherFailure(argv, 1, error);
      return;
    }
  }
  const action = resolveAction(argv);
  if (
    (action.type === "error" || action.type === "stub") &&
    requestedOutputMode(argv) !== "human"
  ) {
    process.exitCode = renderDispatcherFailure(argv, action.code, action.message);
    return;
  }
  const code = route
    ? await withRoutePolicy(route, argv, () => execute(action))
    : await execute(action);
  process.exitCode = code;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.exitCode = renderDispatcherFailure(
      process.argv.slice(2),
      1,
      errorMessage(error),
    );
  });
}
