#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTarGz,
  type ArchiveEntry,
} from "../../core/tools/aidlc-archive.ts";
import {
  projectionFiles,
  walkFiles,
} from "../../core/tools/aidlc-distribution.ts";
import {
  requireVersion,
  targetTriple,
} from "../../core/tools/aidlc-install-paths.ts";
import {
  digest,
  type ReleaseManifest,
} from "../../core/tools/aidlc-release.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function archiveEntries(root: string): ArchiveEntry[] {
  return walkFiles(root).map((path) => ({
    path: path.replaceAll("\\", "/"),
    type: "file",
    mode: statSync(join(root, path)).mode & 0o777,
    data: readFileSync(join(root, path)),
  }));
}

export type ReleaseFixtureOptions = {
  root: string;
  repoRoot?: string;
  version?: string;
  reportedVersion?: string;
  distributions?: readonly string[];
  target?: string;
  hostileRoot?: string;
};

export type ReleaseFixture = {
  root: string;
  manifest: ReleaseManifest;
  binaryName: string;
  hostileArchives: string[];
};

export function writeReleaseFixture(options: ReleaseFixtureOptions): ReleaseFixture {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const version = requireVersion(options.version ?? AIDLC_VERSION);
  const reportedVersion = requireVersion(options.reportedVersion ?? version);
  const target = options.target ?? targetTriple();
  const releaseProjectionRoot = join(repoRoot, "dist-release");
  const distributions = [...(options.distributions ??
    readdirSync(releaseProjectionRoot)
      .filter((name) => statSync(join(releaseProjectionRoot, name)).isDirectory())
      .sort())];
  if (distributions.length === 0) throw new Error("release fixture requires at least one distribution");
  if (existsSync(options.root) && readdirSync(options.root).length > 0) {
    throw new Error(`release fixture output must be empty: ${options.root}`);
  }
  mkdirSync(options.root, { recursive: true, mode: 0o700 });

  const binaryName = `aidlc-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
  writeFileSync(
    join(options.root, binaryName),
    [
      "#!/bin/sh",
      `if [ "$1" = "version" ]; then printf 'aidlc %s\\n' '${reportedVersion}'; exit 0; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(options.root, "install.sh"),
    readFileSync(join(repoRoot, "scripts", "install.sh")),
    { mode: 0o755 },
  );

  const distributionRows: Array<{ name: string; productName: string }> = [];
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-release-fixture-"));
  try {
    for (const distribution of distributions) {
      const source = join(releaseProjectionRoot, distribution);
      if (!existsSync(source)) throw new Error(`unknown release fixture distribution: ${distribution}`);
      const projection = join(scratch, distribution);
      cpSync(source, projection, { recursive: true });
      const { stamp, descriptor } = projectionFiles(projection);
      const stampPath = join(
        projection,
        stamp.harnessDir,
        "tools",
        "data",
        "aidlc-stamp.json",
      );
      writeFileSync(stampPath, `${JSON.stringify({ ...stamp, frameworkVersion: version }, null, 2)}\n`);
      writeFileSync(
        join(options.root, `aidlc-data-${distribution}.tgz`),
        createTarGz(archiveEntries(projection)),
      );
      distributionRows.push({ name: distribution, productName: descriptor.productName });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const names = [
    binaryName,
    ...distributions.map((distribution) => `aidlc-data-${distribution}.tgz`),
    "install.sh",
  ];
  const assets = names.map((name) => ({
    name,
    sha256: digest(join(options.root, name)),
    bytes: statSync(join(options.root, name)).size,
    kind: name.endsWith(".tgz")
      ? "data" as const
      : name === "install.sh"
      ? "installer" as const
      : "binary" as const,
    ...(name.endsWith(".tgz")
      ? { distribution: name.slice("aidlc-data-".length, -".tgz".length) }
      : name === "install.sh"
      ? {}
      : { target }),
  }));
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version,
    date: "2026-07-17",
    distributions: distributionRows,
    assets,
  };
  writeFileSync(
    join(options.root, "version.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(options.root, "checksums.txt"),
    `${
      [
        `${digest(join(options.root, "version.json"))}  version.json`,
        ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
      ].join("\n")
    }\n`,
  );

  const hostileArchives: string[] = [];
  if (options.hostileRoot) {
    mkdirSync(options.hostileRoot, { recursive: true, mode: 0o700 });
    const malformed = join(options.hostileRoot, "malformed-gzip.tgz");
    writeFileSync(malformed, "not a gzip stream\n");
    hostileArchives.push(malformed);
    const safeArchive = join(options.root, `aidlc-data-${distributions[0]}.tgz`);
    const safeBytes = readFileSync(safeArchive);
    const truncated = join(options.hostileRoot, "truncated-archive.tgz");
    writeFileSync(truncated, safeBytes.subarray(0, Math.max(1, Math.floor(safeBytes.length / 2))));
    hostileArchives.push(truncated);
  }

  return { root: options.root, manifest, binaryName, hostileArchives };
}

export type ReleaseServerFault =
  | { kind: "none" }
  | { kind: "redirect" }
  | { kind: "delay"; asset?: string; milliseconds: number }
  | { kind: "truncate"; asset: string }
  | { kind: "captive-portal"; asset?: string }
  | { kind: "oversized"; asset: string; bytes?: number }
  | { kind: "missing"; asset: string };

function contentType(name: string): string {
  if (name === "version.json") return "application/json";
  if (name === "checksums.txt") return "text/plain";
  return "application/octet-stream";
}

export function serveReleaseFixture(
  root: string,
  fault: ReleaseServerFault = { kind: "none" },
): {
  baseUrl: string;
  requests: string[];
  stop(): void;
} {
  const requests: string[] = [];
  let port = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const name = basename(url.pathname);
      if (fault.kind === "redirect" && !url.pathname.startsWith("/fixture-assets/")) {
        return Response.redirect(`http://127.0.0.1:${port}/fixture-assets/${name}`, 302);
      }
      if (fault.kind === "missing" && name === fault.asset) {
        return new Response("missing", { status: 404 });
      }
      if (
        fault.kind === "captive-portal" &&
        (!fault.asset || name === fault.asset)
      ) {
        return new Response("<html>sign in</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (fault.kind === "oversized" && name === fault.asset) {
        return new Response(Buffer.alloc(fault.bytes ?? 1024 * 1024 + 1));
      }
      if (fault.kind === "delay" && (!fault.asset || name === fault.asset)) {
        await Bun.sleep(fault.milliseconds);
      }
      const path = join(root, name);
      if (!existsSync(path) || !statSync(path).isFile()) {
        return new Response("missing", { status: 404 });
      }
      const data = readFileSync(path);
      const body = fault.kind === "truncate" && name === fault.asset
        ? data.subarray(0, Math.max(1, Math.floor(data.length / 2)))
        : data;
      return new Response(body, { headers: { "content-type": contentType(name) } });
    },
  });
  port = server.port ?? 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function acceptedReleaseContentType(value: string | null): boolean {
  const type = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return [
    "application/json",
    "text/json",
    "text/plain",
    "application/octet-stream",
    "binary/octet-stream",
  ].includes(type);
}

export async function checkLiveReleaseContract(
  baseUrl = "https://github.com/awslabs/aidlc-workflows/releases",
): Promise<{ version: string; assets: string[] }> {
  const clean = baseUrl.replace(/\/+$/, "");
  const fetchMetadata = async (name: string): Promise<string> => {
    const response = await fetch(`${clean}/latest/download/${name}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    if (!acceptedReleaseContentType(response.headers.get("content-type"))) {
      throw new Error(`${name} has unexpected content type ${response.headers.get("content-type")}`);
    }
    return response.text();
  };
  const manifestText = await fetchMetadata("version.json");
  const checksumsText = await fetchMetadata("checksums.txt");
  const manifest = JSON.parse(manifestText) as ReleaseManifest;
  requireVersion(manifest.version);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error("live version.json has an unsupported shape");
  }
  const assetNames = manifest.assets.map((asset) => asset.name).sort();
  const expected = [
    "install.sh",
    ...manifest.distributions.map((distribution) => `aidlc-data-${distribution.name}.tgz`),
  ];
  for (const name of expected) {
    if (!assetNames.includes(name)) throw new Error(`live release is missing ${name}`);
  }
  if (!assetNames.some((name) => /^aidlc-(?:darwin|linux)-/.test(name))) {
    throw new Error("live release has no macOS/Linux binary asset");
  }
  const checksumNames = new Set<string>();
  for (const line of checksumsText.trim().split(/\r?\n/)) {
    const match = /^[a-f0-9]{64} {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`live checksums.txt has a malformed row: ${line}`);
    checksumNames.add(match[1]);
  }
  for (const name of ["version.json", ...assetNames]) {
    if (!checksumNames.has(name)) throw new Error(`live checksums.txt is missing ${name}`);
  }
  return { version: manifest.version, assets: assetNames };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const hostileIndex = args.indexOf("--hostile-output");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!output) {
    process.stderr.write(
      "Usage: bun tests/harness/release-fixture.ts --output <dir> [--hostile-output <dir>]\n",
    );
    process.exit(2);
  }
  const fixture = writeReleaseFixture({
    root: output,
    hostileRoot: hostileIndex >= 0 ? args[hostileIndex + 1] : undefined,
  });
  process.stdout.write(`${JSON.stringify({
    root: fixture.root,
    version: fixture.manifest.version,
    assets: fixture.manifest.assets.map((asset) => asset.name),
    hostileArchives: fixture.hostileArchives,
  })}\n`);
}
