import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type ProjectionStamp = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
};

export type RootIntegration = {
  path: string;
  policy: "managed-block" | "json-map" | "json-array" | "whole-file";
  marker?: string;
  jsonKey?: string;
  optional?: boolean;
};

export type ProjectionDescriptor = {
  schemaVersion: 1;
  distribution: string;
  productName: string;
  initNextStep: string;
  harnessDir: string;
  managedDirectories: string[];
  rootIntegrations: RootIntegration[];
};

function parseJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function safeRelativePath(value: unknown, label: string, topLevel = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    (topLevel && value.includes("/"))
  ) {
    throw new Error(`${label} is not a safe ${topLevel ? "top-level name" : "relative path"}`);
  }
  return value;
}

function validateDescriptor(root: string, stamp: ProjectionStamp, descriptor: ProjectionDescriptor): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(stamp.frameworkVersion)) {
    throw new Error(`${root}: projection stamp has an invalid framework version`);
  }
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(stamp.distribution) ||
    typeof descriptor.productName !== "string" ||
    descriptor.productName.trim().length === 0 ||
    typeof descriptor.initNextStep !== "string" ||
    descriptor.initNextStep.trim().length === 0
  ) {
    throw new Error(`${root}: projection identity is invalid`);
  }
  safeRelativePath(stamp.harnessDir, "harnessDir", true);
  if (!Array.isArray(descriptor.managedDirectories) || !Array.isArray(descriptor.rootIntegrations)) {
    throw new Error(`${root}: projection descriptor lists are invalid`);
  }
  const declared = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    const safe = safeRelativePath(directory, "managed directory", true);
    if (declared.has(safe)) throw new Error(`${root}: duplicate projected path ${safe}`);
    declared.add(safe);
    const path = join(root, safe);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error(`${root}: managed directory is missing or invalid: ${safe}`);
    }
  }
  for (const integration of descriptor.rootIntegrations) {
    if (!integration || typeof integration !== "object") {
      throw new Error(`${root}: root integration is invalid`);
    }
    const safe = safeRelativePath(integration.path, "root integration path");
    if (declared.has(safe)) throw new Error(`${root}: duplicate projected path ${safe}`);
    declared.add(safe);
    const path = join(root, safe);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`${root}: root integration is missing or invalid: ${safe}`);
    }
    if (!["managed-block", "json-map", "json-array", "whole-file"].includes(integration.policy)) {
      throw new Error(`${root}: ${safe} has an invalid integration policy`);
    }
    if (
      integration.policy === "managed-block" &&
      (typeof integration.marker !== "string" || !/^[a-z0-9-]+$/.test(integration.marker))
    ) {
      throw new Error(`${root}: ${safe} has an invalid managed-block marker`);
    }
    if (
      (integration.policy === "json-map" || integration.policy === "json-array") &&
      (typeof integration.jsonKey !== "string" || integration.jsonKey.length === 0)
    ) {
      throw new Error(`${root}: ${safe} has an invalid JSON integration key`);
    }
  }
}

export function projectionFiles(root: string): {
  stamp: ProjectionStamp;
  descriptor: ProjectionDescriptor;
} {
  const candidates = readdirSync(root)
    .filter((name) => existsSync(join(root, name, "tools", "data", "aidlc-stamp.json")))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `${root}: expected exactly one projected harness directory, found ${candidates.length}`,
    );
  }
  const harnessDir = candidates[0];
  const data = join(root, harnessDir, "tools", "data");
  const stamp = parseJson<ProjectionStamp>(join(data, "aidlc-stamp.json"));
  const descriptor = parseJson<ProjectionDescriptor>(join(data, "aidlc-projection.json"));
  if (
    stamp.schemaVersion !== 1 ||
    descriptor.schemaVersion !== 1 ||
    stamp.harnessDir !== harnessDir ||
    descriptor.harnessDir !== harnessDir ||
    stamp.distribution !== descriptor.distribution
  ) {
    throw new Error(`${root}: projection stamp and descriptor do not describe one distribution`);
  }
  validateDescriptor(root, stamp, descriptor);
  const allowedTopLevel = new Set([
    ...descriptor.managedDirectories,
    ...descriptor.rootIntegrations.map((item) => item.path.split(/[\\/]/)[0]),
  ]);
  const unexpected = readdirSync(root).filter((entry) => !allowedTopLevel.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`${root}: unclassified projection entries: ${unexpected.sort().join(", ")}`);
  }
  return { stamp, descriptor };
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
      else throw new Error(`${path}: links and special files are not valid projection content`);
    }
  };
  visit(root);
  return files;
}
