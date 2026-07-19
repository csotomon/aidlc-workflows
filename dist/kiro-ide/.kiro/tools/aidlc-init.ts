#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  EXIT,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
} from "./aidlc-command.ts";
import {
  type ProjectionDescriptor,
  projectionFiles,
  sha256Bytes,
  sha256File,
  walkFiles,
} from "./aidlc-distribution.ts";
import { activeVersion, projectDirFrom, runtimeRoot } from "./aidlc-install-paths.ts";
import { defaultHarnessPath } from "./aidlc-machine-config.ts";
import {
  type TransactionOperation,
  type TransactionPlan,
  executePlan,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { compileStageGraph, __resetGraphCache } from "./aidlc-graph.ts";
import {
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
} from "./aidlc-lib.ts";
import { regenerateRunnerSurfaces } from "./aidlc-runner-gen.ts";
import {
  canonicalScopeTableRegion,
  canonicalStageTableRegion,
  renderScopeTable,
  renderStageTable,
} from "./aidlc-utility.ts";
import { aidlcToolInvocation } from "./aidlc-runtime-paths.ts";

type RootContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "json-map"; entries: Record<string, string>; key?: string }
  | { policy: "json-array"; entries: Record<string, string>; key: string }
  | { policy: "whole-file"; hash: string };

type Baseline = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
  mcpMode: "defaults" | "none";
  files: Record<string, string>;
  rootContributions: Record<string, RootContribution>;
};

type PlannedAction = {
  path: string;
  action: "create" | "update" | "merge" | "preserve" | "remove" | "conflict";
  detail?: string;
};

function stripVerb(argv: string[]): string[] {
  return argv[0] === "init" ? argv.slice(1) : argv;
}

function readBaseline(path: string): Baseline | null {
  if (!pathPresent(path)) return null;
  if (!regularFile(path)) throw new Error(`cannot refresh from ${path}: baseline is not a regular file`);
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Baseline;
    if (value.schemaVersion !== 1) throw new Error(`unsupported schema ${value.schemaVersion}`);
    return value;
  } catch (error) {
    throw new Error(`cannot refresh from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expected(path: string): string | "absent" {
  return transactionState(path);
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function regularFile(path: string): boolean {
  return pathPresent(path) && lstatSync(path).isFile();
}

function regularFilesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
    }
  };
  visit(root);
  return files;
}

function runtimeGenerated(
  rel: string,
  harnessDir: string,
  regenerated: ReadonlySet<string>,
): boolean {
  const normalized = rel.replaceAll("\\", "/");
  return regenerated.has(normalized) || [
    `${harnessDir}/tools/data/harness.json`,
    `${harnessDir}/tools/data/stage-graph.json`,
    `${harnessDir}/tools/data/scope-grid.json`,
  ].includes(normalized);
}

type StageContribRecord = {
  produces?: string[];
  sensors?: string[];
  consumes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
};

function resetProjectionCaches(): void {
  __resetGraphCache();
  _resetHarnessDataForTests();
  _resetScopeMappingForTests();
  _resetStageGraphForTests();
}

function mergeListField(content: string, field: string, items: readonly string[]): string {
  if (items.length === 0) return content;
  const empty = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (empty.test(content)) {
    return content.replace(empty, `${field}:\n${items.map((item) => `  - ${item}`).join("\n")}`);
  }
  const block = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const match = content.match(block);
  if (!match) return content;
  const existing = new Set(
    [...match[1].matchAll(/^ {2}- (.+)$/gm)].map((item) =>
      item[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    ),
  );
  const additions = items.filter((item) => !existing.has(item));
  if (additions.length === 0) return content;
  const quoted = field === "required_sections";
  return content.replace(
    block,
    `${match[1]}${additions.map((item) => `  - ${quoted ? JSON.stringify(item) : item}`).join("\n")}\n`,
  );
}

function mergeRequiredSections(content: string, record: StageContribRecord): string {
  const items = record.required_sections ?? [];
  if (items.length === 0) return content;
  if (/^required_sections:/m.test(content)) {
    return mergeListField(content, "required_sections", items);
  }
  const close = /^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/.exec(content);
  if (!close) return content;
  const at = (close.index ?? 0) + close[0].lastIndexOf("---");
  return `${content.slice(0, at)}required_sections:\n${
    items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")
  }\n${content.slice(at)}`;
}

function consumeBlocks(content: string, names: ReadonlySet<string>): string[] {
  const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => names.has(entry[1]))
    .map((entry) => entry[0].trimEnd());
}

function mergeConsumes(content: string, blocks: readonly string[]): string {
  if (blocks.length === 0) return content;
  if (/^consumes:\s*\[\s*\]\s*$/m.test(content)) {
    return content.replace(/^consumes:\s*\[\s*\]\s*$/m, `consumes:\n${blocks.join("\n")}`);
  }
  const match = /^(consumes:\n(?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!match) return content;
  const existing = new Set([...match[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((item) => item[1]));
  const additions = blocks.filter((block) => {
    const name = /- artifact:\s*([\w-]+)/.exec(block)?.[1];
    return name && !existing.has(name);
  });
  return additions.length === 0
    ? content
    : content.replace(match[0], `${match[1]}${additions.join("\n")}\n`);
}

function stripRecordedContributions(content: string, record: StageContribRecord): string {
  let value = content;
  for (const [field, items] of [
    ["produces", record.produces],
    ["sensors", record.sensors],
    ["required_sections", record.required_sections],
  ] as const) {
    if (!items?.length) continue;
    const values = new Set(items);
    const block = new RegExp(`^${field}:\\n((?: {2}- .+\\n)*)`, "m");
    const match = value.match(block);
    if (!match) continue;
    const kept = [...match[1].matchAll(/^ {2}- (.+)$/gm)]
      .map((item) => item[1])
      .filter((item) => !values.has(item.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")));
    const replacement = kept.length > 0
      ? `${field}:\n${kept.map((item) => `  - ${item}`).join("\n")}\n`
      : field === "required_sections" && record.required_sections_created
      ? ""
      : `${field}: []\n`;
    value = value.replace(block, replacement);
  }
  if (record.consumes?.length) {
    const names = new Set(record.consumes);
    const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(value);
    if (block) {
      const kept = [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
        .filter((entry) => !names.has(entry[1]))
        .map((entry) => entry[0]);
      value = value.replace(block[0], kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n");
    }
  }
  return stripPluginFragments(value);
}

function stripPluginFragments(content: string): string {
  return content.replace(
    /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->\n[\s\S]*?<!-- \/plugin:\1:\2:\3:\4 -->\n?/g,
    "",
  ).replace(/\n{3,}/g, "\n\n");
}

function pluginFragments(content: string): Array<{ marker: string; anchor: string; block: string }> {
  const fragments: Array<{ marker: string; anchor: string; block: string }> = [];
  const open = /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->/g;
  for (const match of content.matchAll(open)) {
    const marker = match[0];
    const close = `<!-- /plugin:${match[1]}:${match[2]}:${match[3]}:${match[4]} -->`;
    const end = content.indexOf(close, match.index);
    if (end < 0) continue;
    fragments.push({
      marker,
      anchor: match[2],
      block: content.slice(match.index, end + close.length),
    });
  }
  return fragments;
}

function anchorOffset(content: string, anchor: string): number {
  const step = /^(after|before)-step:(\d+)$/.exec(anchor);
  if (step) {
    const wanted = Number(step[2]);
    for (const match of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const low = Number(match[1]);
      const high = match[2] ? Number(match[2]) : low;
      if (wanted < low || wanted > high) continue;
      if (step[1] === "before") return match.index ?? -1;
      const from = (match.index ?? 0) + match[0].length;
      const next = content.slice(from).search(/^#{2,3} /m);
      return next < 0 ? content.length : from + next;
    }
    return -1;
  }
  if (anchor === "end-of-steps") {
    const section = /^## Steps\b.*$/m.exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const section = new RegExp(`^## ${anchor.slice(3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "m")
      .exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  return -1;
}

function mergePluginFragments(
  fresh: string,
  fragments: readonly { marker: string; anchor: string; block: string }[],
): string {
  let value = fresh;
  for (const fragment of fragments) {
    if (value.includes(fragment.marker)) continue;
    const offset = anchorOffset(value, fragment.anchor);
    if (offset < 0) {
      throw new Error(`cannot reapply plugin fragment at missing anchor ${fragment.anchor}`);
    }
    value = `${value.slice(0, offset)}\n${fragment.block}\n${value.slice(offset)}`;
  }
  return value;
}

function replaceGeneratedRegion(current: string, generated: string, begin: string, end: string): string {
  const currentBegin = current.indexOf(begin);
  const currentEnd = current.indexOf(end, currentBegin + begin.length);
  const generatedBegin = generated.indexOf(begin);
  const generatedEnd = generated.indexOf(end, generatedBegin + begin.length);
  if (currentBegin < 0 || currentEnd < 0 || generatedBegin < 0 || generatedEnd < 0) return generated;
  return `${current.slice(0, currentBegin)}${
    generated.slice(generatedBegin, generatedEnd + end.length)
  }${current.slice(currentEnd + end.length)}`;
}

function generatedOverlayCandidate(rel: string, harnessDir: string): boolean {
  return rel.startsWith(`${harnessDir}/aidlc-common/stages/`) ||
    rel.startsWith(`${harnessDir}/scopes/`) ||
    rel.startsWith(`${harnessDir}/agents/`) ||
    rel.startsWith(`${harnessDir}/knowledge/`) ||
    rel.startsWith(`${harnessDir}/sensors/`) ||
    rel.startsWith(`${harnessDir}/tools/`) ||
    rel.startsWith(`${harnessDir}/skills/`) ||
    rel.startsWith(".agents/skills/");
}

function prepareRefreshSource(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
): { root: string; cleanup?: string; regenerated: Set<string> } {
  if (!prior) return { root: sourceRoot, regenerated: new Set() };
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-init-refresh-"));
  try {
  const root = join(cleanup, "projection");
  cpSync(sourceRoot, root, { recursive: true, preserveTimestamps: true });
  const regenerated = new Set<string>();
  const currentHarness = join(projectDir, descriptor.harnessDir);
  const stagedHarness = join(root, descriptor.harnessDir);

  const currentHarnessData = join(currentHarness, "tools", "data", "harness.json");
  const stagedHarnessData = join(stagedHarness, "tools", "data", "harness.json");
  if (regularFile(currentHarnessData)) {
    const current = JSON.parse(readFileSync(currentHarnessData, "utf-8")) as Record<string, unknown>;
    const staged = JSON.parse(readFileSync(stagedHarnessData, "utf-8")) as Record<string, unknown>;
    if (Array.isArray(current.plugins)) staged.plugins = current.plugins;
    writeFileSync(stagedHarnessData, `${JSON.stringify(staged, null, 2)}\n`);
    regenerated.add(`${descriptor.harnessDir}/tools/data/harness.json`);
  }

  const currentGrid = join(currentHarness, "tools", "data", "scope-grid.json");
  const stagedGrid = join(stagedHarness, "tools", "data", "scope-grid.json");
  if (regularFile(currentGrid)) {
    cpSync(currentGrid, stagedGrid);
    regenerated.add(`${descriptor.harnessDir}/tools/data/scope-grid.json`);
  }

  for (const directory of descriptor.managedDirectories) {
    if (directory !== descriptor.harnessDir && directory !== ".agents") continue;
    const currentDir = join(projectDir, directory);
    if (!pathPresent(currentDir) || !lstatSync(currentDir).isDirectory()) continue;
    for (const nested of regularFilesBelow(currentDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      const staged = join(root, rel);
      if (
        existsSync(staged) ||
        prior.files[rel] ||
        !generatedOverlayCandidate(rel, descriptor.harnessDir)
      ) continue;
      mkdirSync(dirname(staged), { recursive: true });
      cpSync(join(projectDir, rel), staged, { preserveTimestamps: true });
      regenerated.add(rel);
    }
  }

  const records = new Map<string, StageContribRecord>();
  const dataDir = join(currentHarness, "tools", "data");
  if (pathPresent(dataDir) && lstatSync(dataDir).isDirectory()) {
    for (const file of readdirSync(dataDir).filter((name) => /^plugin-contrib-.+\.json$/.test(name))) {
      if (!regularFile(join(dataDir, file))) continue;
      const parsed = JSON.parse(readFileSync(join(dataDir, file), "utf-8")) as Record<string, StageContribRecord>;
      for (const [slug, record] of Object.entries(parsed)) {
        const priorRecord = records.get(slug) ?? {};
        records.set(slug, {
          produces: [...new Set([...(priorRecord.produces ?? []), ...(record.produces ?? [])])],
          sensors: [...new Set([...(priorRecord.sensors ?? []), ...(record.sensors ?? [])])],
          consumes: [...new Set([...(priorRecord.consumes ?? []), ...(record.consumes ?? [])])],
          required_sections: [
            ...new Set([...(priorRecord.required_sections ?? []), ...(record.required_sections ?? [])]),
          ],
          required_sections_created:
            priorRecord.required_sections_created || record.required_sections_created,
        });
      }
    }
  }

  const stageRoot = join(currentHarness, "aidlc-common", "stages");
  if (pathPresent(stageRoot) && lstatSync(stageRoot).isDirectory()) {
    for (const phase of readdirSync(stageRoot)) {
      const currentPhase = join(stageRoot, phase);
      if (!lstatSync(currentPhase).isDirectory()) continue;
      for (const file of readdirSync(currentPhase).filter((name) => name.endsWith(".md"))) {
        const rel = `${descriptor.harnessDir}/aidlc-common/stages/${phase}/${file}`;
        const priorHash = prior.files[rel];
        const currentPath = join(projectDir, rel);
        const stagedPath = join(root, rel);
        if (!priorHash || !regularFile(currentPath) || !existsSync(stagedPath)) continue;
        const current = readFileSync(currentPath, "utf-8");
        const record = records.get(file.slice(0, -3)) ?? {};
        const fragments = pluginFragments(current);
        const hasRecordedContribution = Object.entries(record).some(([key, value]) =>
          key === "required_sections_created" ? value === true : Array.isArray(value) && value.length > 0
        );
        if (fragments.length === 0 && !hasRecordedContribution) {
          continue;
        }
        if (sha256Bytes(stripRecordedContributions(current, record)) !== priorHash) continue;
        let fresh = readFileSync(stagedPath, "utf-8");
        fresh = mergeListField(fresh, "produces", record.produces ?? []);
        fresh = mergeListField(fresh, "sensors", record.sensors ?? []);
        fresh = mergeConsumes(fresh, consumeBlocks(current, new Set(record.consumes ?? [])));
        fresh = mergeRequiredSections(fresh, record);
        fresh = mergePluginFragments(fresh, fragments);
        writeFileSync(stagedPath, fresh);
        regenerated.add(rel);
      }
    }
  }

  const envKeys = [
    "AIDLC_PROJECT_DIR",
    "AIDLC_HARNESS_DIR",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_RULES_DIR",
    "AIDLC_STAGE_GRAPH",
    "AIDLC_SCOPE_GRID",
    "AIDLC_SCOPES_DIR",
    "AIDLC_SENSORS_DIR",
    "AIDLC_AGENTS_DIR",
  ] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AIDLC_PROJECT_DIR = root;
    process.env.AIDLC_HARNESS_DIR = descriptor.harnessDir;
    process.env.AIDLC_RUNTIME_HARNESS_ROOT = stagedHarness;
    process.env.AIDLC_RULES_DIR = join(root, "aidlc", "spaces", "default", "memory");
    process.env.AIDLC_STAGE_GRAPH = join(stagedHarness, "tools", "data", "stage-graph.json");
    process.env.AIDLC_SCOPE_GRID = stagedGrid;
    process.env.AIDLC_SCOPES_DIR = join(stagedHarness, "scopes");
    process.env.AIDLC_SENSORS_DIR = join(stagedHarness, "sensors");
    process.env.AIDLC_AGENTS_DIR = join(stagedHarness, "agents");
    resetProjectionCaches();
    const compiled = compileStageGraph();
    writeFileSync(process.env.AIDLC_STAGE_GRAPH, compiled.json);
    writeFileSync(stagedGrid, compiled.gridJson);
    resetProjectionCaches();
    regenerateRunnerSurfaces();
    resetProjectionCaches();

    const skillPath = existsSync(join(stagedHarness, "skills", "aidlc", "SKILL.md"))
      ? join(stagedHarness, "skills", "aidlc", "SKILL.md")
      : join(root, ".agents", "skills", "aidlc", "SKILL.md");
    if (existsSync(skillPath)) {
      let generated = readFileSync(skillPath, "utf-8");
      generated = replaceGeneratedRegion(
        generated,
        canonicalStageTableRegion(renderStageTable()),
        `<!-- BEGIN: compiled stage graph via \`${aidlcToolInvocation("utility", undefined, false)} stage-table\` - do NOT hand-edit -->`,
        "<!-- END: compiled stage graph -->",
      );
      generated = replaceGeneratedRegion(
        generated,
        canonicalScopeTableRegion(renderScopeTable()),
        `<!-- BEGIN: compiled scope grid via \`${aidlcToolInvocation("utility", undefined, false)} scope-table\` - do NOT hand-edit -->`,
        "<!-- END: compiled scope grid -->",
      );
      const rel = relative(root, skillPath).replaceAll("\\", "/");
      const currentSkill = join(projectDir, rel);
      if (regularFile(currentSkill)) {
        generated = replaceGeneratedRegion(
          readFileSync(currentSkill, "utf-8"),
          generated,
          `<!-- BEGIN: compiled stage graph via \`${aidlcToolInvocation("utility", undefined, false)} stage-table\` - do NOT hand-edit -->`,
          "<!-- END: compiled stage graph -->",
        );
        generated = replaceGeneratedRegion(
          generated,
          canonicalScopeTableRegion(renderScopeTable()),
          `<!-- BEGIN: compiled scope grid via \`${aidlcToolInvocation("utility", undefined, false)} scope-table\` - do NOT hand-edit -->`,
          "<!-- END: compiled scope grid -->",
        );
      }
      writeFileSync(skillPath, generated);
      regenerated.add(rel);
    }
    regenerated.add(`${descriptor.harnessDir}/tools/data/stage-graph.json`);
    for (const directory of [join(stagedHarness, "skills"), join(root, ".agents", "skills")]) {
      if (!existsSync(directory)) continue;
      for (const nested of walkFiles(directory)) {
        const path = join(directory, nested);
        if (readFileSync(path, "utf-8").includes("generated-by: aidlc-runner-gen")) {
          regenerated.add(relative(root, path).replaceAll("\\", "/"));
        }
      }
    }
  } finally {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProjectionCaches();
  }
  return { root, cleanup, regenerated };
  } catch (error) {
    rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
}

function blockMarkers(path: string, identity: string): { begin: string; end: string } {
  return path.endsWith(".md")
    ? {
        begin: `<!-- BEGIN AI-DLC:${identity} -->`,
        end: `<!-- END AI-DLC:${identity} -->`,
      }
    : {
        begin: `# BEGIN AI-DLC:${identity}`,
        end: `# END AI-DLC:${identity}`,
      };
}

function mergeBlock(
  path: string,
  current: string,
  shipped: string,
  identity: string,
): { value?: string; currentHash?: string; nextHash?: string; error?: string } {
  const { begin, end } = blockMarkers(path, identity);
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || (begins === 1) !== (ends === 1)) {
    return { error: "managed markers are missing, duplicated, or malformed" };
  }
  const beginAt = current.indexOf(begin);
  const endAt = current.indexOf(end);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const body = shipped.trim().replace(/\r?\n/g, newline);
  const block = `${begin}${newline}${body}${newline}${end}`;
  if (beginAt >= 0) {
    if (endAt < beginAt) return { error: "managed end marker precedes its begin marker" };
    const currentBlock = current.slice(beginAt, endAt + end.length);
    return {
      value: `${current.slice(0, beginAt)}${block}${current.slice(endAt + end.length)}`,
      currentHash: sha256Bytes(currentBlock),
      nextHash: sha256Bytes(block),
    };
  }
  if (/\baidlc\b|AI-DLC/i.test(current)) {
    return { error: "legacy root integration ambiguous; move or delete the unmarked AI-DLC content" };
  }
  const prefix = current.length === 0 || current.endsWith(newline) ? current : `${current}${newline}`;
  return {
    value: `${prefix}${prefix ? newline : ""}${block}${newline}`,
    nextHash: sha256Bytes(block),
  };
}

function installedSources(requiredVersion?: string): string[] {
  const roots: string[] = [];
  const explicit = process.env.AIDLC_RUNTIME_ROOT;
  if (explicit && existsSync(explicit)) {
    for (const entry of readdirSync(explicit).sort()) {
      const candidate = join(explicit, entry);
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    }
    try {
      projectionFiles(explicit);
      roots.push(explicit);
    } catch {
      // The explicit root may be a parent of distributions.
    }
  }
  const active = activeVersion();
  if (active) {
    const root = runtimeRoot(active);
    if (existsSync(root)) {
      for (const entry of readdirSync(root).sort()) {
        const candidate = join(root, entry);
        if (statSync(candidate).isDirectory()) roots.push(candidate);
      }
    }
  }
  if (requiredVersion && requiredVersion !== active) {
    const root = runtimeRoot(requiredVersion);
    if (existsSync(root)) {
      for (const entry of readdirSync(root).sort()) {
        const candidate = join(root, entry);
        if (statSync(candidate).isDirectory()) roots.push(candidate);
      }
    }
  }
  const executableRuntime = join(dirname(process.execPath), "runtime");
  if (existsSync(executableRuntime)) {
    for (const entry of readdirSync(executableRuntime).sort()) {
      const candidate = join(executableRuntime, entry);
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    }
  }
  return [...new Set(roots)];
}

function materializeSource(path: string): { root: string; cleanup?: string } {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) throw new Error(`init source does not exist: ${absolute}`);
  if (statSync(absolute).isDirectory()) return { root: absolute };
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-init-source-"));
  extractTarGz(absolute, temporary);
  return { root: temporary, cleanup: temporary };
}

function configuredDefaultHarness(): string | undefined {
  const path = defaultHarnessPath();
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf-8").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(
      `${path} contains an invalid harness name; run aidlc harness default clear`,
    );
  }
  return value;
}

function selectSource(
  requested: string | undefined,
  from: string | undefined,
  existingDistribution: string | undefined,
  requiredVersion?: string,
): { root: string; cleanup?: string } {
  if (from) {
    const source = materializeSource(from);
    const { stamp } = projectionFiles(source.root);
    if (requested && stamp.distribution !== requested) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`source is ${stamp.distribution}, not requested harness ${requested}`);
    }
    if (existingDistribution && stamp.distribution !== existingDistribution) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`existing project uses ${existingDistribution}; refusing ${stamp.distribution}`);
    }
    return source;
  }
  const candidates = installedSources(requiredVersion).flatMap((root) => {
    try {
      const projection = projectionFiles(root);
      return [{ root, stamp: projection.stamp, descriptor: projection.descriptor }];
    } catch {
      return [];
    }
  });
  const selectedName = existingDistribution || requested;
  const versionFiltered = requiredVersion
    ? candidates.filter((candidate) =>
        candidate.stamp.frameworkVersion === requiredVersion
      )
    : candidates;
  if (selectedName) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === selectedName
    );
    if (selected.length === 1) return { root: selected[0].root };
    throw new Error(
      requiredVersion && versionFiltered.length === 0
        ? `project requires ${requiredVersion}, which is not installed; run aidlc versions install ${requiredVersion}`
        : requiredVersion
        ? `harness ${selectedName} is not installed in ${requiredVersion}; run aidlc versions install ${requiredVersion} --harness ${selectedName}`
        : `harness ${selectedName} is not installed`,
    );
  }
  const configuredDefault = configuredDefaultHarness();
  if (configuredDefault) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === configuredDefault
    );
    if (selected.length === 1) return { root: selected[0].root };
    if (versionFiltered.length > 0) {
      throw new Error(
        requiredVersion
          ? `configured default harness ${configuredDefault} is not installed in ${requiredVersion}; run aidlc versions install ${requiredVersion} --harness ${configuredDefault} or aidlc harness default clear`
          : `configured default harness ${configuredDefault} is unavailable; install it or run aidlc harness default clear`,
      );
    }
  }
  if (versionFiltered.length === 1) return { root: versionFiltered[0].root };
  if (versionFiltered.length === 0) {
    throw new Error(
      requiredVersion
        ? `project requires ${requiredVersion}, which is not installed; run aidlc versions install ${requiredVersion}`
        : "no installed harness runtime is available",
    );
  }
  if (process.stdin.isTTY) {
    process.stdout.write("Select a harness for this project:\n");
    for (const [index, candidate] of versionFiltered.entries()) {
      process.stdout.write(
        `  ${index + 1}) ${candidate.stamp.distribution} - ${candidate.descriptor.productName}\n`,
      );
    }
    const answer = prompt(`Harness [1-${versionFiltered.length}]:`);
    const selected = answer && /^\d+$/.test(answer)
      ? versionFiltered[Number(answer) - 1]
      : undefined;
    if (selected) return { root: selected.root };
    throw new Error("harness selection cancelled; pass --harness <name>");
  }
  throw new Error(
    `multiple harnesses are installed; pass --harness <${
      versionFiltered.map((item) => item.stamp.distribution).join("|")
    }>`,
  );
}

function existingProject(projectDir: string): {
  distribution?: string;
  baseline?: Baseline;
} {
  for (const harnessDir of [".claude", ".kiro", ".codex"]) {
    const baselinePath = join(projectDir, harnessDir, "tools", "data", "aidlc-manifest.json");
    const baseline = readBaseline(baselinePath);
    if (baseline) return { distribution: baseline.distribution, baseline };
    const stampPath = join(projectDir, harnessDir, "tools", "data", "aidlc-stamp.json");
    if (regularFile(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { distribution?: string };
      if (stamp.distribution) return { distribution: stamp.distribution };
    }
  }
  return {};
}

function planManagedFiles(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  nextHashes: Record<string, string>,
  regenerated: ReadonlySet<string>,
): void {
  const shipped = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    const sourceDir = join(sourceRoot, directory);
    if (!existsSync(sourceDir)) throw new Error(`projection is missing managed directory ${directory}`);
    for (const nested of walkFiles(sourceDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      shipped.add(rel);
      const source = join(sourceRoot, rel);
      const target = join(projectDir, rel);
      const targetExists = pathPresent(target);
      const targetRegular = targetExists && lstatSync(target).isFile();
      const hash = sha256File(source);
      const seedOnly = rel === "aidlc/active-space" ||
        (rel.startsWith("aidlc/spaces/") && rel.includes("/memory/"));
      if (seedOnly) {
        if (targetExists) {
          actions.push({ path: rel, action: "preserve", detail: "project-owned seed" });
        } else {
          operations.push({
            kind: "copy",
            path: rel,
            source,
            sourceHash: hash,
            expected: "absent",
            mode: statSync(source).mode & 0o777,
          });
          actions.push({ path: rel, action: "create" });
        }
        continue;
      }
      if (runtimeGenerated(rel, descriptor.harnessDir, regenerated)) {
        if (targetRegular && sha256File(target) === hash) {
          actions.push({ path: rel, action: "preserve", detail: "runtime-generated" });
          continue;
        }
        if (targetExists && !targetRegular && !force) {
          actions.push({ path: rel, action: "conflict", detail: "managed path is not a regular file" });
          continue;
        }
        operations.push({
          kind: "copy",
          path: rel,
          source,
          sourceHash: hash,
          expected: expected(target),
          mode: statSync(source).mode & 0o777,
        });
        actions.push({
          path: rel,
          action: targetExists ? "update" : "create",
          detail: "runtime-generated",
        });
        continue;
      }
      nextHashes[rel] = hash;
      if (targetRegular && sha256File(target) === hash) {
        actions.push({ path: rel, action: "preserve" });
        continue;
      }
      const priorHash = prior?.files[rel];
      if (
        targetExists &&
        (!targetRegular || !priorHash || sha256File(target) !== priorHash) &&
        !force
      ) {
        actions.push({ path: rel, action: "conflict", detail: "locally modified or unowned" });
        continue;
      }
      operations.push({
        kind: "copy",
        path: rel,
        source,
        sourceHash: hash,
        expected: expected(target),
        mode: statSync(source).mode & 0o777,
      });
      actions.push({ path: rel, action: targetExists ? "update" : "create" });
    }
  }
  for (const [rel, priorHash] of Object.entries(prior?.files ?? {})) {
    if (shipped.has(rel) || rel.endsWith("/tools/data/aidlc-manifest.json")) continue;
    const target = join(projectDir, rel);
    if (!pathPresent(target)) continue;
    if ((!regularFile(target) || sha256File(target) !== priorHash) && !force) {
      actions.push({ path: rel, action: "conflict", detail: "removed upstream but locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path: rel, expected: expected(target) });
    actions.push({ path: rel, action: "remove" });
  }
}

function planRootIntegrations(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  mcpMode: "defaults" | "none",
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  contributions: Record<string, RootContribution>,
): void {
  for (const integration of descriptor.rootIntegrations) {
    const sourcePath = join(sourceRoot, integration.path);
    const targetPath = join(projectDir, integration.path);
    const targetExists = pathPresent(targetPath);
    const targetRegular = targetExists && lstatSync(targetPath).isFile();
    if (targetExists && !targetRegular && !force) {
      actions.push({
        path: integration.path,
        action: "conflict",
        detail: "root integration is not a regular file",
      });
      continue;
    }
    const current = targetRegular ? readFileSync(targetPath, "utf-8") : "";
    const priorContribution = prior?.rootContributions[integration.path];
    if (integration.policy === "managed-block") {
      const merged = mergeBlock(
        integration.path,
        current,
        readFileSync(sourcePath, "utf-8"),
        integration.marker || basename(integration.path),
      );
      if (merged.error) {
        actions.push({ path: integration.path, action: "conflict", detail: merged.error });
        continue;
      }
      const value = merged.value as string;
      const priorHash = priorContribution?.policy === "managed-block"
        ? priorContribution.hash
        : undefined;
      if (
        merged.currentHash &&
        merged.currentHash !== merged.nextHash &&
        merged.currentHash !== priorHash &&
        !force
      ) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: priorHash ? "managed block was locally modified" : "managed block has no ownership baseline",
        });
        continue;
      }
      contributions[integration.path] = {
        policy: "managed-block",
        hash: merged.nextHash as string,
        marker: integration.marker,
      };
      if (value === current) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "json-map") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const target = targetValue;
      const source = sourceValue;
      const key = integration.jsonKey as string;
      const rawTargetMap = target[key] ?? {};
      const rawSourceMap = source[key] ?? {};
      if (!isRecord(rawTargetMap) || !isRecord(rawSourceMap)) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: `${key} must be a JSON object`,
        });
        continue;
      }
      const targetMap = { ...rawTargetMap };
      const sourceMap = rawSourceMap;
      const priorEntries = priorContribution?.policy === "json-map"
        ? priorContribution.entries
        : {};
      const nextEntries: Record<string, string> = {};
      if (!current && integration.optional && mcpMode === "none") {
        contributions[integration.path] = {
          policy: "json-map",
          entries: {},
          key: integration.jsonKey,
        };
        actions.push({ path: integration.path, action: "preserve", detail: "optional integration disabled" });
        continue;
      }
      if (mcpMode === "defaults") {
        for (const [entry, value] of Object.entries(sourceMap)) {
          const desiredHash = sha256Bytes(canonical(value));
          if (!(entry in targetMap)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
            continue;
          }
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          const priorHash = priorEntries[entry];
          if (priorHash && (currentHash === priorHash || force)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
          } else if (priorHash && currentHash === desiredHash) {
            nextEntries[entry] = desiredHash;
          }
        }
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (entry in sourceMap || !(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) delete targetMap[entry];
        }
      } else {
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (!(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) {
            delete targetMap[entry];
          }
        }
      }
      if (Object.keys(targetMap).length > 0) target[key] = targetMap;
      else delete target[key];
      contributions[integration.path] = {
        policy: "json-map",
        entries: nextEntries,
        key: integration.jsonKey,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        const value = `${JSON.stringify(target, null, 2)}\n`;
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "json-array") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const key = integration.jsonKey as string;
      const targetArray = targetValue[key] ?? [];
      const sourceArray = sourceValue[key] ?? [];
      if (
        !Array.isArray(targetArray) ||
        !Array.isArray(sourceArray) ||
        !targetArray.every((item) => typeof item === "string") ||
        !sourceArray.every((item) => typeof item === "string")
      ) {
        actions.push({ path: integration.path, action: "conflict", detail: `${key} must be a string array` });
        continue;
      }
      const priorEntries = priorContribution?.policy === "json-array"
        ? priorContribution.entries
        : {};
      const desired = new Map(
        sourceArray.map((item) => [item, sha256Bytes(canonical(item))]),
      );
      const nextEntries: Record<string, string> = {};
      const retained = targetArray.filter((item) => {
        const priorHash = priorEntries[item];
        if (priorHash && desired.has(item)) nextEntries[item] = desired.get(item) as string;
        return !priorHash || desired.has(item) || sha256Bytes(canonical(item)) !== priorHash;
      });
      for (const item of sourceArray) {
        if (!retained.includes(item)) {
          retained.push(item);
          nextEntries[item] = desired.get(item) as string;
        }
      }
      if (retained.length > 0) targetValue[key] = retained;
      else delete targetValue[key];
      contributions[integration.path] = {
        policy: "json-array",
        entries: nextEntries,
        key,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(
          integration.path,
          `${JSON.stringify(targetValue, null, 2)}\n`,
          expected(targetPath),
        ));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    const shipped = readFileSync(sourcePath);
    const shippedHash = sha256Bytes(shipped);
    const priorHash = priorContribution?.policy === "whole-file"
      ? priorContribution.hash
      : undefined;
    contributions[integration.path] = { policy: "whole-file", hash: shippedHash };
    if (targetExists && sha256Bytes(current) !== priorHash && sha256Bytes(current) !== shippedHash && !force) {
      actions.push({ path: integration.path, action: "conflict", detail: "unowned whole file" });
    } else if (sha256Bytes(current) === shippedHash) {
      actions.push({ path: integration.path, action: "preserve" });
    } else {
      operations.push(writeOperation(integration.path, shipped, expected(targetPath)));
      actions.push({ path: integration.path, action: targetExists ? "update" : "create" });
    }
  }
}

function planRemovedRootIntegrations(
  projectDir: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
): void {
  const current = new Set(descriptor.rootIntegrations.map((item) => item.path));
  for (const [path, contribution] of Object.entries(prior?.rootContributions ?? {})) {
    if (current.has(path)) continue;
    const targetPath = join(projectDir, path);
    if (!pathPresent(targetPath)) continue;
    if (!regularFile(targetPath)) {
      if (!force) {
        actions.push({ path, action: "conflict", detail: "retired root integration is not a regular file" });
        continue;
      }
      operations.push({ kind: "remove", path, expected: expected(targetPath) });
      actions.push({ path, action: "remove" });
      continue;
    }
    const text = readFileSync(targetPath, "utf-8");
    if (contribution.policy === "managed-block") {
      const fallback = basename(path).replace(/\.[^.]+$/, "").toLowerCase();
      const { begin, end } = blockMarkers(path, contribution.marker ?? fallback);
      const beginAt = text.indexOf(begin);
      const endAt = text.indexOf(end, beginAt + begin.length);
      if (beginAt < 0 || endAt < beginAt) {
        actions.push({ path, action: "conflict", detail: "retired managed block markers are missing" });
        continue;
      }
      const blockEnd = endAt + end.length;
      if (sha256Bytes(text.slice(beginAt, blockEnd)) !== contribution.hash && !force) {
        actions.push({ path, action: "conflict", detail: "retired managed block was locally modified" });
        continue;
      }
      let value = `${text.slice(0, beginAt)}${text.slice(blockEnd)}`;
      value = value.replace(/^\r?\n/, "").replace(/\r?\n\r?\n$/, "\n");
      if (!value) {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove" });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired managed block" });
      }
      continue;
    }
    if (contribution.policy === "json-map") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed)) {
        actions.push({ path, action: "conflict", detail: "retired JSON integration root is not an object" });
        continue;
      }
      const maps = contribution.key && isRecord(parsed[contribution.key])
        ? [parsed[contribution.key] as Record<string, unknown>]
        : Object.values(parsed).filter(isRecord);
      let conflict = false;
      for (const [entry, priorHash] of Object.entries(contribution.entries)) {
        for (const map of maps) {
          if (!(entry in map)) continue;
          if (sha256Bytes(canonical(map[entry])) !== priorHash && !force) conflict = true;
          else delete map[entry];
        }
      }
      if (conflict) {
        actions.push({ path, action: "conflict", detail: "retired JSON entry was locally modified" });
        continue;
      }
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON entries" });
      continue;
    }
    if (contribution.policy === "json-array") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed) || !Array.isArray(parsed[contribution.key])) {
        actions.push({ path, action: "conflict", detail: "retired JSON array integration is malformed" });
        continue;
      }
      const values = parsed[contribution.key] as unknown[];
      const retired = new Set(Object.keys(contribution.entries));
      parsed[contribution.key] = values.filter((value) =>
        typeof value !== "string" || !retired.has(value) ||
        sha256Bytes(canonical(value)) !== contribution.entries[value]
      );
      if ((parsed[contribution.key] as unknown[]).length === 0) delete parsed[contribution.key];
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON array entries" });
      continue;
    }
    if (sha256File(targetPath) !== contribution.hash && !force) {
      actions.push({ path, action: "conflict", detail: "retired whole-file integration was locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path, expected: expected(targetPath) });
    actions.push({ path, action: "remove" });
  }
}

export async function main(input: string[]): Promise<void> {
  const argv = stripVerb(input);
  const options = globalOptions(argv);
  const requestedHarness = valueAfter(argv, "--harness");
  const from = valueAfter(argv, "--from");
  const mcpValue = valueAfter(argv, "--mcp");
  if (argv.includes("--harness") && !requestedHarness) {
    emitResult(usage("--harness requires a distribution name"), options);
    return;
  }
  if (mcpValue && mcpValue !== "defaults" && mcpValue !== "none") {
    emitResult(usage("--mcp must be defaults or none"), options);
    return;
  }
  const projectDir = projectDirFrom(argv);
  const explicitProject = argv.includes("--project-dir") ||
    Boolean(process.env.AIDLC_PROJECT_DIR) ||
    Boolean(process.env.CLAUDE_PROJECT_DIR) ||
    Boolean(process.env.KIRO_PROJECT_DIR);
  const recognized = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]
    .some((entry) => existsSync(join(projectDir, entry)));
  if (!recognized && !explicitProject && !options.yes) {
    if (!process.stdin.isTTY) {
      emitResult(usage("non-interactive init outside a recognized project requires --project-dir"), options);
      return;
    }
    const answer = prompt(`Initialize AI-DLC in ${projectDir}? [y/N]:`);
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage("initialization cancelled; pass --project-dir to select the target explicitly"), options);
      return;
    }
  }
  const existing = existingProject(projectDir);
  let selected: { root: string; cleanup?: string } | null = null;
  let prepared: { root: string; cleanup?: string; regenerated: Set<string> } | null = null;
  try {
    const pinPath = join(projectDir, ".aidlc-version");
    if (pathPresent(pinPath) && !regularFile(pinPath)) {
      throw new Error("project pin .aidlc-version is not a regular file");
    }
    const requiredVersion = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
    selected = selectSource(requestedHarness, from, existing.distribution, requiredVersion);
    const { stamp, descriptor } = projectionFiles(selected.root);
    if (existing.distribution && existing.distribution !== stamp.distribution) {
      throw new Error(`project uses ${existing.distribution}; refusing ${stamp.distribution}`);
    }
    if (regularFile(pinPath) && readFileSync(pinPath, "utf-8").trim() !== stamp.frameworkVersion) {
      throw new Error(
        `project pin requires ${readFileSync(pinPath, "utf-8").trim()}, but source is ${stamp.frameworkVersion}; run aidlc versions install ${readFileSync(pinPath, "utf-8").trim()}`,
      );
    }
    const baselinePath = join(projectDir, descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    const prior = readBaseline(baselinePath);
    prepared = prepareRefreshSource(projectDir, selected.root, descriptor, prior);
    let mcpMode = (mcpValue ?? prior?.mcpMode) as "defaults" | "none" | undefined;
    if (
      !mcpMode &&
      process.stdin.isTTY &&
      descriptor.rootIntegrations.some((integration) =>
        integration.policy === "json-map" && integration.optional
      )
    ) {
      const answer = prompt("Configure optional AI-DLC MCP servers? [y/N]:");
      mcpMode = answer && /^y(?:es)?$/i.test(answer.trim()) ? "defaults" : "none";
    }
    mcpMode ??= "none";
    const operations: TransactionOperation[] = [];
    const actions: PlannedAction[] = [];
    const files: Record<string, string> = {};
    const rootContributions: Record<string, RootContribution> = {};
    planManagedFiles(
      projectDir,
      prepared.root,
      descriptor,
      prior,
      argv.includes("--force"),
      operations,
      actions,
      files,
      prepared.regenerated,
    );
    planRootIntegrations(
      projectDir,
      prepared.root,
      descriptor,
      prior,
      mcpMode,
      argv.includes("--force"),
      operations,
      actions,
      rootContributions,
    );
    planRemovedRootIntegrations(
      projectDir,
      descriptor,
      prior,
      argv.includes("--force"),
      operations,
      actions,
    );
    const conflicts = actions.filter((action) => action.action === "conflict");
    if (conflicts.length > 0) {
      actions.sort((left, right) =>
        left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
      );
      const counts = Object.fromEntries(
        ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
          name,
          actions.filter((item) => item.action === name).length,
        ]),
      );
      emitResult({
        ...failure(
          `${conflicts.length} init conflict(s): ${conflicts.map((item) => `${item.path} (${item.detail})`).join(", ")}`,
          EXIT.integrity,
          "aidlc init --dry-run --verbose",
        ),
        data: { projectDir, distribution: stamp.distribution, counts, actions },
      }, options);
      return;
    }
    const baseline: Baseline = {
      schemaVersion: 1,
      frameworkVersion: stamp.frameworkVersion,
      distribution: stamp.distribution,
      harnessDir: stamp.harnessDir,
      mcpMode,
      files,
      rootContributions,
    };
    const baselineRel = join(descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    operations.push(writeOperation(
      baselineRel,
      `${JSON.stringify(baseline, null, 2)}\n`,
      expected(baselinePath),
    ));
    actions.push({ path: baselineRel, action: pathPresent(baselinePath) ? "update" : "create" });
    actions.sort((left, right) =>
      left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
    );
    const counts = Object.fromEntries(
      ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
        name,
        actions.filter((item) => item.action === name).length,
      ]),
    );
    const plan: TransactionPlan = { schemaVersion: 1, root: projectDir, operations };
    const approvalPlan = {
      ...plan,
      operations: plan.operations.map((operation) =>
        operation.kind === "copy"
          ? {
              ...operation,
              source: {
                sha256: sha256File(operation.source),
                mode: statSync(operation.source).mode & 0o777,
              },
            }
          : operation
      ),
    };
    const planToken = sha256Bytes(canonical(approvalPlan));
    if (argv.includes("--dry-run")) {
      emitResult(success(
        `init plan for ${projectDir}: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}`,
        { projectDir, distribution: stamp.distribution, counts, actions, planToken },
      ), options);
      return;
    }
    const approvedToken = valueAfter(argv, "--plan-token");
    if (argv.includes("--plan-token") && !approvedToken) {
      emitResult(usage("--plan-token requires the token emitted by init --dry-run"), options);
      return;
    }
    if (approvedToken && approvedToken !== planToken) {
      emitResult(failure(
        "init plan changed after approval; run aidlc init --dry-run again",
        EXIT.integrity,
        "aidlc init --dry-run --json",
      ), options);
      return;
    }
    executePlan(plan);
    emitResult(success(
      `initialized ${projectDir} for ${descriptor.productName} ${stamp.frameworkVersion}; next: ${descriptor.initNextStep}`,
      {
        projectDir,
        distribution: stamp.distribution,
        version: stamp.frameworkVersion,
        counts,
        actions,
        planToken,
      },
    ), options);
  } catch (error) {
    emitResult(failure(
      error instanceof Error ? error.message : String(error),
      EXIT.integrity,
      from ? "aidlc init --from <valid-release-data>" : "aidlc harness add <name>",
    ), options);
  } finally {
    if (prepared?.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
    if (selected?.cleanup) rmSync(selected.cleanup, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc init: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
