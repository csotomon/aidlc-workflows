#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGz, type ArchiveEntry } from "../core/tools/aidlc-archive.ts";
import { projectionFiles, walkFiles } from "../core/tools/aidlc-distribution.ts";
import { targetTriple } from "../core/tools/aidlc-install-paths.ts";
import { digest, type ReleaseAsset, type ReleaseManifest } from "../core/tools/aidlc-release.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function entriesFor(root: string): ArchiveEntry[] {
  return walkFiles(root).map((path) => ({
    path: path.replaceAll("\\", "/"),
    type: "file",
    mode: statSync(join(root, path)).mode & 0o777,
    data: readFileSync(join(root, path)),
  }));
}

function outputName(target: string, source: string): string {
  const normalized = target === "native" ? targetTriple() : target;
  return `aidlc-${normalized}${source.endsWith(".exe") ? ".exe" : ""}`;
}

function build(argv: string[]): void {
  const output = valueAfter(argv, "--output") || join(REPO_ROOT, "build", "release");
  const binaries = valueAfter(argv, "--binaries") || join(REPO_ROOT, "build", "binaries");
  const check = spawnSync("bun", [join(REPO_ROOT, "scripts", "package.ts"), "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (check.status !== 0) throw new Error(`package drift guard failed\n${check.stderr}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const assets: ReleaseAsset[] = [];
  const distributions: ReleaseManifest["distributions"] = [];

  for (const distribution of readdirSync(join(REPO_ROOT, "dist-release")).sort()) {
    const root = join(REPO_ROOT, "dist-release", distribution);
    const projection = projectionFiles(root);
    distributions.push({
      name: projection.stamp.distribution,
      productName: projection.descriptor.productName,
    });
    const name = `aidlc-data-${distribution}.tgz`;
    const path = join(output, name);
    writeFileSync(path, createTarGz(entriesFor(root)));
    assets.push({
      name,
      sha256: digest(path),
      bytes: statSync(path).size,
      kind: "data",
      distribution,
    });
  }

  for (const target of readdirSync(binaries).sort()) {
    if (target === "build-results.json") continue;
    const directory = join(binaries, target);
    if (!statSync(directory).isDirectory()) continue;
    const candidates = ["aidlc", "aidlc.exe"].map((name) => join(directory, name)).filter(existsSync);
    if (candidates.length !== 1) throw new Error(`${directory}: expected one aidlc binary`);
    const source = candidates[0];
    const name = outputName(target, source);
    const path = join(output, name);
    copyFileSync(source, path);
    chmodSync(path, 0o755);
    assets.push({
      name,
      sha256: digest(path),
      bytes: statSync(path).size,
      kind: "binary",
      target: target === "native" ? targetTriple() : target,
    });
  }
  if (argv.includes("--require-release-matrix")) {
    const expected = [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
    ];
    const actual = new Set(
      assets.filter((asset) => asset.kind === "binary").map((asset) => asset.target),
    );
    const missing = expected.filter((target) => !actual.has(target));
    if (missing.length > 0) {
      throw new Error(`release binary matrix is incomplete: ${missing.join(", ")}`);
    }
  }

  const installer = join(output, "install.sh");
  copyFileSync(join(REPO_ROOT, "scripts", "install.sh"), installer);
  chmodSync(installer, 0o755);
  assets.push({
    name: "install.sh",
    sha256: digest(installer),
    bytes: statSync(installer).size,
    kind: "installer",
  });

  assets.sort((a, b) => a.name.localeCompare(b.name));
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf-8");
  const releaseDate = new RegExp(
    `^## \\[${AIDLC_VERSION.replaceAll(".", "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`,
    "m",
  ).exec(changelog)?.[1];
  if (!releaseDate) throw new Error(`CHANGELOG.md has no dated ${AIDLC_VERSION} release heading`);
  const date = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().slice(0, 10)
    : releaseDate;
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: AIDLC_VERSION,
    date,
    distributions,
    assets,
  };
  writeFileSync(join(output, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(output, "checksums.txt"),
    `${
      [
        `${digest(join(output, "version.json"))}  version.json`,
        ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
      ].join("\n")
    }\n`,
  );
  console.log(`packaged ${assets.length} release assets in ${relative(REPO_ROOT, output)}`);
}

try {
  build(process.argv.slice(2));
} catch (error) {
  console.error(`package-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
