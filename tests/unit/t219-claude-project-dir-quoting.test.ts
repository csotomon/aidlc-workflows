// covers: file:settings.json
//
// t219 - Claude settings must use native aidlc commands.
//
// Regression pin for issue 519: Claude Code expands settings commands through a
// shell, so project-relative Bun script paths could split when the workspace
// path contained spaces. Native installs remove that path argument entirely.
// The authored settings use the projection token and the generated settings use
// `aidlc`; neither executable surface may retain Bun or CLAUDE_PROJECT_DIR.
//
// Mechanism: none. This reads and parses the two static JSON files on disk,
// walks only command fields and permission entries (the executable surfaces),
// and checks the exact bug shape cannot reappear.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const SUBJECTS = [
  {
    label: "authored Claude harness settings",
    path: join(REPO_ROOT, "harness", "claude", "settings.json"),
    invoke: "{{INVOKE}}",
  },
  {
    label: "generated Claude dist settings",
    path: join(REPO_ROOT, "dist", "claude", ".claude", "settings.json"),
    invoke: "aidlc",
  },
] as const;

const EXPECTED_COMMANDS = 13;

interface Settings {
  permissions?: { allow?: unknown };
}

function readSettings(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectCommandStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCommandStrings(item, out);
    return out;
  }

  if (!isRecord(value)) return out;

  for (const [key, child] of Object.entries(value)) {
    if (key === "command" && typeof child === "string") out.push(child);
    collectCommandStrings(child, out);
  }
  return out;
}

function permissionEntries(settings: unknown): string[] {
  const allow = (settings as Settings).permissions?.allow;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function executableSettingsStrings(settings: unknown): string[] {
  return [...collectCommandStrings(settings), ...permissionEntries(settings)];
}

describe("t219 Claude settings use native commands without project paths", () => {
  for (const subject of SUBJECTS) {
    test(`${subject.label}: every executable setting uses the projected native invocation`, () => {
      const settings = readSettings(subject.path);
      const commands = collectCommandStrings(settings);
      const values = executableSettingsStrings(settings);

      expect(commands).toHaveLength(EXPECTED_COMMANDS);
      expect(commands.every((value) => value.startsWith(subject.invoke))).toBe(true);
      expect(permissionEntries(settings)).toContain(`Bash(${subject.invoke} *)`);
      expect(values.some((value) => value.includes("CLAUDE_PROJECT_DIR"))).toBe(false);
      expect(values.some((value) => /\bbun\b/.test(value))).toBe(false);
    });
  }
});
