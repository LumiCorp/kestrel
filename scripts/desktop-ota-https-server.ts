import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:https";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { stringify } from "yaml";

import {
  verifyDesktopUpdateReleaseArtifacts,
  type DesktopUpdateManifest,
} from "./desktop-update-publisher.js";

export const DESKTOP_OTA_SERVER_HOST = "localhost";
export const DESKTOP_OTA_SERVER_PORT = 45_173;
export const DESKTOP_OTA_SERVER_PREFIX = "/desktop/stable/arm64";

export interface DesktopOtaRequestLedgerEntry {
  sequence: number;
  at: string;
  phase: string;
  method: string;
  path: string;
  status: number;
  range?: string | undefined;
  contentRange?: string | undefined;
  bytes: number;
  fault?: "blockmap_503" | undefined;
}

export interface DesktopOtaReleaseCatalogEntry {
  version: string;
  metadata: Buffer;
  artifacts: ReadonlyMap<
    string,
    { path: string; size: number; sha256: string; contentType: string }
  >;
}

export interface DesktopOtaReleaseCatalog {
  releases: ReadonlyMap<string, DesktopOtaReleaseCatalogEntry>;
  artifacts: ReadonlyMap<
    string,
    { path: string; size: number; sha256: string; contentType: string }
  >;
}

export interface DesktopOtaHttpsServer {
  readonly ledger: DesktopOtaRequestLedgerEntry[];
  setPhase(phase: string): void;
  offer(version: string, options?: {
    faultBlockmap?: boolean | undefined;
  }): void;
  close(): Promise<void>;
}

export interface DesktopByteRange {
  start: number;
  end: number;
  length: number;
  contentRange: string;
}

export interface DesktopOtaArtifactResponse {
  status: 200 | 206 | 416 | 503;
  bytes: number;
  byteRange?: DesktopByteRange | undefined;
  contentRange?: string | undefined;
  fault?: "blockmap_503" | undefined;
}

export async function loadDesktopOtaReleaseCatalog(
  releases: ReadonlyArray<{ version: string; outDir: string }>,
): Promise<DesktopOtaReleaseCatalog> {
  const byVersion = new Map<string, DesktopOtaReleaseCatalogEntry>();
  const allArtifacts = new Map<
    string,
    { path: string; size: number; sha256: string; contentType: string }
  >();
  for (const release of releases) {
    if (byVersion.has(release.version)) {
      throw new Error(`Duplicate Desktop OTA release '${release.version}'.`);
    }
    const verified = await verifyDesktopUpdateReleaseArtifacts(release);
    const artifacts = new Map<
      string,
      { path: string; size: number; sha256: string; contentType: string }
    >();
    const realOutDir = realpathSync(release.outDir);
    for (const name of verified.artifactNames) {
      const artifactPath = realpathSync(path.join(release.outDir, name));
      assertPathWithin(realOutDir, artifactPath);
      const size = statSync(artifactPath).size;
      const digest = verified.artifactDigests.get(name);
      if (digest?.size !== size) {
        throw new Error(`Desktop OTA artifact size changed: '${name}'.`);
      }
      const artifact = {
        path: artifactPath,
        size,
        sha256: digest.sha256,
        contentType: desktopOtaContentType(name),
      };
      if (allArtifacts.has(name)) {
        throw new Error(`Desktop OTA artifact name is not unique: '${name}'.`);
      }
      artifacts.set(name, artifact);
      allArtifacts.set(name, artifact);
    }
    byVersion.set(release.version, {
      version: release.version,
      metadata: Buffer.from(renderLocalManifest(verified.manifest)),
      artifacts,
    });
  }
  if (byVersion.size === 0) {
    throw new Error("Desktop OTA server requires at least one verified release.");
  }
  return {
    releases: byVersion,
    artifacts: allArtifacts,
  };
}

export async function startDesktopOtaHttpsServer(input: {
  certificatePath: string;
  privateKeyPath: string;
  catalog: DesktopOtaReleaseCatalog;
}): Promise<DesktopOtaHttpsServer> {
  let phase = "preflight";
  let offeredVersion: string | undefined;
  let faultBlockmapName: string | undefined;
  const ledger: DesktopOtaRequestLedgerEntry[] = [];
  const server = createServer(
    {
      cert: readFileSync(input.certificatePath),
      key: readFileSync(input.privateKeyPath),
      minVersion: "TLSv1.2",
    },
    (request, response) => {
      void serveRequest(request, response).catch((error) => {
        if (response.headersSent === false) {
          response.writeHead(500, {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
          });
        }
        response.end("Controlled OTA server failure.\n");
        process.stderr.write(
          `[desktop-ota-server] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      DESKTOP_OTA_SERVER_PORT,
      DESKTOP_OTA_SERVER_HOST,
      () => resolve(),
    );
  });

  return {
    ledger,
    setPhase(nextPhase) {
      if (!/^[a-z0-9_.-]+$/u.test(nextPhase)) {
        throw new Error(`Invalid Desktop OTA server phase '${nextPhase}'.`);
      }
      phase = nextPhase;
    },
    offer(version, options = {}) {
      const release = input.catalog.releases.get(version);
      if (release === undefined) {
        throw new Error(`Desktop OTA release '${version}' is not verified.`);
      }
      offeredVersion = version;
      faultBlockmapName = options.faultBlockmap
        ? [...release.artifacts.keys()].find((name) =>
            name.endsWith(".zip.blockmap")
          )
        : undefined;
      if (options.faultBlockmap && faultBlockmapName === undefined) {
        throw new Error(
          `Desktop OTA release '${version}' has no ZIP blockmap to fault.`,
        );
      }
    },
    async close() {
      await closeServer(server);
    },
  };

  async function serveRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "";
    const requestTarget = request.url ?? "";
    const requestPath = resolveDesktopOtaRequestPath(requestTarget);
    const rangeHeader = normalizeHeader(request.headers.range);
    const baseLedger = {
      sequence: ledger.length + 1,
      at: new Date().toISOString(),
      phase,
      method,
      path: requestTarget,
      ...(rangeHeader === undefined ? {} : { range: rangeHeader }),
    };
    const record = (
      status: number,
      bytes: number,
      extra: Pick<
        DesktopOtaRequestLedgerEntry,
        "contentRange" | "fault"
      > = {},
    ): void => {
      ledger.push({ ...baseLedger, status, bytes, ...extra });
    };

    if (normalizeHeader(request.headers.host) !==
      `${DESKTOP_OTA_SERVER_HOST}:${DESKTOP_OTA_SERVER_PORT}`) {
      respondText(response, method, 421, "Unexpected host.\n");
      record(421, method === "HEAD" ? 0 : 17);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      respondText(response, method, 405, "Method not allowed.\n");
      record(405, method === "HEAD" ? 0 : 20);
      return;
    }
    if (requestPath === undefined) {
      respondText(response, method, 400, "Invalid OTA path.\n");
      record(400, method === "HEAD" ? 0 : 18);
      return;
    }
    if (offeredVersion === undefined) {
      respondText(response, method, 503, "No release offered.\n");
      record(503, method === "HEAD" ? 0 : 20);
      return;
    }
    if (requestPath === `${DESKTOP_OTA_SERVER_PREFIX}/latest-mac.yml`) {
      const release = input.catalog.releases.get(offeredVersion)!;
      response.writeHead(200, {
        "cache-control": "no-cache, no-store, max-age=0",
        "content-length": release.metadata.byteLength,
        "content-type": "text/yaml; charset=utf-8",
      });
      if (method === "HEAD") response.end();
      else response.end(release.metadata);
      record(200, method === "HEAD" ? 0 : release.metadata.byteLength);
      return;
    }
    const prefix = `${DESKTOP_OTA_SERVER_PREFIX}/`;
    if (!requestPath.startsWith(prefix)) {
      respondText(response, method, 404, "Not found.\n");
      record(404, method === "HEAD" ? 0 : 11);
      return;
    }
    const name = requestPath.slice(prefix.length);
    if (!/^[A-Za-z0-9._+-]+$/u.test(name)) {
      respondText(response, method, 400, "Invalid artifact name.\n");
      record(400, method === "HEAD" ? 0 : 23);
      return;
    }
    const artifact = input.catalog.artifacts.get(name);
    if (artifact === undefined) {
      respondText(response, method, 404, "Not found.\n");
      record(404, method === "HEAD" ? 0 : 11);
      return;
    }
    const artifactResponse = resolveDesktopOtaArtifactResponse({
      name,
      size: artifact.size,
      range: rangeHeader,
      faultBlockmapName,
    });
    if (artifactResponse.status === 503) {
      respondText(response, method, 503, "Injected blockmap failure.\n");
      record(503, method === "HEAD" ? 0 : 27, {
        fault: "blockmap_503",
      });
      return;
    }

    if (artifactResponse.status === 416) {
      response.writeHead(416, {
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
        "content-range": artifactResponse.contentRange!,
        "content-type": artifact.contentType,
      });
      response.end();
      record(416, 0, { contentRange: artifactResponse.contentRange });
      return;
    }
    const byteRange = artifactResponse.byteRange;
    const status = artifactResponse.status;
    const contentLength = artifactResponse.bytes;
    response.writeHead(status, {
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": contentLength,
      "content-type": artifact.contentType,
      ...(byteRange === undefined
        ? {}
        : { "content-range": byteRange.contentRange }),
    });
    if (method === "HEAD") {
      response.end();
      record(status, 0, {
        ...(byteRange === undefined
          ? {}
          : { contentRange: byteRange.contentRange }),
      });
      return;
    }
    const stream = createReadStream(artifact.path, {
      ...(byteRange === undefined
        ? {}
        : { start: byteRange.start, end: byteRange.end }),
    });
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
    record(status, contentLength, {
      ...(byteRange === undefined
        ? {}
        : { contentRange: byteRange.contentRange }),
    });
  }
}

export function parseDesktopByteRange(
  value: string,
  size: number,
): DesktopByteRange {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Desktop OTA range size must be a positive integer.");
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (
    match === null ||
    (match[1] === "" && match[2] === "") ||
    value.includes(",")
  ) {
    throw new Error(`Invalid Desktop OTA Range '${value}'.`);
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      throw new Error(`Invalid Desktop OTA Range '${value}'.`);
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    throw new Error(`Unsatisfiable Desktop OTA Range '${value}'.`);
  }
  end = Math.min(end, size - 1);
  return {
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export function resolveDesktopOtaArtifactResponse(input: {
  name: string;
  size: number;
  range?: string | undefined;
  faultBlockmapName?: string | undefined;
}): DesktopOtaArtifactResponse {
  if (input.name === input.faultBlockmapName) {
    return {
      status: 503,
      bytes: 27,
      fault: "blockmap_503",
    };
  }
  if (input.range === undefined) {
    return {
      status: 200,
      bytes: input.size,
    };
  }
  try {
    const byteRange = parseDesktopByteRange(input.range, input.size);
    return {
      status: 206,
      bytes: byteRange.length,
      byteRange,
      contentRange: byteRange.contentRange,
    };
  } catch {
    return {
      status: 416,
      bytes: 0,
      contentRange: `bytes */${input.size}`,
    };
  }
}

export function isValidDesktopOtaRequestPath(value: string): boolean {
  return (
    value.startsWith(`${DESKTOP_OTA_SERVER_PREFIX}/`) &&
    !value.includes("%") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("..")
  );
}

export function resolveDesktopOtaRequestPath(
  requestTarget: string,
): string | undefined {
  if (!requestTarget.startsWith("/") || requestTarget.includes("#")) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(requestTarget, "https://localhost");
  } catch {
    return undefined;
  }
  if (!isValidDesktopOtaRequestPath(parsed.pathname)) {
    return undefined;
  }
  if (parsed.search === "") {
    return parsed.pathname;
  }
  if (
    parsed.pathname !== `${DESKTOP_OTA_SERVER_PREFIX}/latest-mac.yml` ||
    [...parsed.searchParams.keys()].length !== 1 ||
    parsed.searchParams.getAll("noCache").length !== 1
  ) {
    return undefined;
  }
  const noCache = parsed.searchParams.get("noCache");
  return noCache !== null && noCache.length > 0 && noCache.length <= 256
    ? parsed.pathname
    : undefined;
}

export function summarizeDesktopOtaTransfer(input: {
  ledger: readonly DesktopOtaRequestLedgerEntry[];
  phase: string;
  targetZipName: string;
  targetZipSize: number;
}): {
  fullBytes: number;
  rangeBytes: number;
  rangeRequests: number;
  partialResponses: number;
  faultResponses: number;
  differential: boolean;
} {
  const requests = input.ledger.filter(
    (entry) =>
      entry.phase === input.phase &&
      entry.path.endsWith(`/${input.targetZipName}`),
  );
  const fullBytes = requests
    .filter((entry) => entry.status === 200 && entry.method === "GET")
    .reduce((total, entry) => total + entry.bytes, 0);
  const rangeRequests = requests.filter((entry) => entry.range !== undefined);
  const rangeBytes = rangeRequests.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  const partialResponses = rangeRequests.filter(
    (entry) => entry.status === 206 && entry.contentRange !== undefined,
  ).length;
  return {
    fullBytes,
    rangeBytes,
    rangeRequests: rangeRequests.length,
    partialResponses,
    faultResponses: input.ledger.filter(
      (entry) => entry.phase === input.phase && entry.fault !== undefined,
    ).length,
    differential:
      rangeRequests.length > 0 &&
      partialResponses === rangeRequests.length &&
      rangeBytes < input.targetZipSize &&
      fullBytes === 0,
  };
}

function renderLocalManifest(manifest: DesktopUpdateManifest): string {
  return stringify({
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      url: artifactName(file.url),
    })),
    path: artifactName(manifest.path),
  });
}

function artifactName(value: string): string {
  const parsed = new URL(value, "https://updates.invalid");
  const name = path.posix.basename(decodeURIComponent(parsed.pathname));
  if (!/^[A-Za-z0-9._+-]+$/u.test(name)) {
    throw new Error(`Invalid Desktop OTA artifact '${value}'.`);
  }
  return name;
}

function assertPathWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Desktop OTA artifact escapes its release root: ${candidate}`);
  }
}

function desktopOtaContentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

function normalizeHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function respondText(
  response: ServerResponse,
  method: string,
  status: number,
  value: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
    "content-type": "text/plain; charset=utf-8",
  });
  if (method === "HEAD") response.end();
  else response.end(value);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
