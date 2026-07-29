import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";

import type { DesktopUpdateChannel } from "../apps/desktop/src/builderConfig.js";

export interface DesktopUpdateObjectHead {
  etag?: string | undefined;
  sha256?: string | undefined;
  size?: number | undefined;
}

export type DesktopUpdateObjectBody =
  | { kind: "file"; path: string; size: number }
  | { kind: "text"; value: string };

export interface DesktopUpdateObjectStore {
  head(key: string): Promise<DesktopUpdateObjectHead | undefined>;
  getText(key: string): Promise<string | undefined>;
  put(input: {
    key: string;
    body: DesktopUpdateObjectBody;
    contentType: string;
    cacheControl: string;
    sha256: string;
    condition:
      | { ifNoneMatch: "*" }
      | { ifMatch: string };
  }): Promise<void>;
}

interface UpdateManifestFile {
  url: string;
  sha512: string;
  size: number;
  blockMapSize?: number | undefined;
}

interface UpdateManifest {
  version: string;
  files: UpdateManifestFile[];
  path: string;
  sha512: string;
  releaseDate?: string | undefined;
}

interface ArtifactDigest {
  sha256: string;
  sha512: string;
  size: number;
}

export interface UploadDesktopUpdateReleaseInput {
  outDir: string;
  version: string;
  store: DesktopUpdateObjectStore;
  publicOrigin?: string | undefined;
  prefix?: string | undefined;
}

export interface UploadDesktopUpdateReleaseResult {
  uploaded: string[];
  skipped: string[];
  releaseMetadataKey: string;
}

export interface PromoteDesktopUpdateReleaseInput {
  version: string;
  channel: DesktopUpdateChannel;
  store: DesktopUpdateObjectStore;
  publicOrigin?: string | undefined;
  prefix?: string | undefined;
}

export interface PromoteDesktopUpdateReleaseResult {
  promotedMetadataKey: string;
  releaseMetadataKey: string;
  previousMetadataEtag?: string | undefined;
  alreadyCurrent: boolean;
}

export function parseDesktopUpdatePromotionVersion(args: string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (
    normalized.length !== 2 ||
    normalized[0] !== "--version" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(normalized[1] ?? "")
  ) {
    throw new Error(
      "Desktop promotion requires exactly '--version <semver>'.",
    );
  }
  return normalized[1]!;
}

export async function uploadDesktopUpdateRelease(
  input: UploadDesktopUpdateReleaseInput,
): Promise<UploadDesktopUpdateReleaseResult> {
  const prefix = normalizePrefix(input.prefix ?? "desktop");
  const publicOrigin = (input.publicOrigin ?? "https://updates.lumicorp.ai")
    .replace(/\/+$/u, "");
  const sourceMetadataPath = path.join(input.outDir, "latest-mac.yml");
  if (!existsSync(sourceMetadataPath)) {
    throw new Error("Desktop update metadata is missing: latest-mac.yml.");
  }
  const manifest = parseManifest(
    readFileSync(sourceMetadataPath, "utf8"),
    input.version,
  );
  const referencedNames = manifest.files.map(({ url }) => artifactName(url));
  if (!referencedNames.some((name) => name.endsWith(".zip"))) {
    throw new Error("latest-mac.yml must reference a ZIP update artifact.");
  }

  const dmgName = readdirSync(input.outDir).find(
    (name) =>
      name === `Kestrel-${input.version}-mac-arm64.dmg`,
  );
  if (!dmgName) {
    throw new Error(
      `Desktop ${input.version} manual-install DMG is missing.`,
    );
  }
  const expectedBlockmaps = [
    `${dmgName}.blockmap`,
    ...referencedNames
      .filter((name) => name.endsWith(".zip"))
      .map((name) => `${name}.blockmap`),
  ];
  const artifactNames = [
    ...new Set([...referencedNames, dmgName, ...expectedBlockmaps]),
  ];
  for (const name of artifactNames) {
    if (!existsSync(path.join(input.outDir, name))) {
      throw new Error(`Desktop update artifact is missing: ${name}.`);
    }
  }

  const artifactDigests = new Map<string, ArtifactDigest>();
  for (const name of artifactNames) {
    artifactDigests.set(
      name,
      await digestFile(path.join(input.outDir, name)),
    );
  }
  assertManifestArtifactIntegrity(manifest, artifactDigests);

  const versionPrefix = `${prefix}/releases/${input.version}/arm64`;
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const checksums: Array<{ name: string; sha256: string }> = [];
  for (const name of artifactNames) {
    const key = `${versionPrefix}/${name}`;
    const artifactPath = path.join(input.outDir, name);
    const { sha256, size } = artifactDigests.get(name)!;
    checksums.push({ name, sha256 });
    const existing = await input.store.head(key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== size) {
        throw new Error(
          `Immutable Desktop artifact mismatch for '${key}'.`,
        );
      }
      skipped.push(key);
      continue;
    }
    try {
      await input.store.put({
        key,
        body: { kind: "file", path: artifactPath, size },
        contentType: contentType(name),
        cacheControl: "public, max-age=31536000, immutable",
        sha256,
        condition: { ifNoneMatch: "*" },
      });
    } catch (error) {
      const raced = await input.store.head(key);
      if (raced?.sha256 === sha256 && raced.size === size) {
        skipped.push(key);
        continue;
      }
      throw error;
    }
    const verified = await input.store.head(key);
    if (
      verified?.sha256 !== sha256 ||
      verified.size !== size
    ) {
      throw new Error(`Unable to verify uploaded Desktop artifact '${key}'.`);
    }
    uploaded.push(key);
  }

  const checksumBody = checksums
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}`)
    .join("\n")
    .concat("\n");
  await publishImmutableText({
    store: input.store,
    key: `${versionPrefix}/SHA256SUMS.txt`,
    value: checksumBody,
    uploaded,
    skipped,
  });

  const promotedManifest: UpdateManifest = {
    ...manifest,
    files: manifest.files.map((file) => {
      const name = artifactName(file.url);
      return {
        ...file,
        url: `${publicOrigin}/${versionPrefix}/${name}`,
      };
    }),
    ...(manifest.path
      ? {
          path: `${publicOrigin}/${versionPrefix}/${artifactName(
            manifest.path,
          )}`,
        }
      : {}),
  };
  const metadataBody = stringify(promotedManifest);
  const releaseMetadataKey = `${versionPrefix}/latest-mac.yml`;
  await publishImmutableText({
    store: input.store,
    key: releaseMetadataKey,
    value: metadataBody,
    uploaded,
    skipped,
    contentType: "text/yaml; charset=utf-8",
  });
  return {
    uploaded,
    skipped,
    releaseMetadataKey,
  };
}

export async function promoteDesktopUpdateRelease(
  input: PromoteDesktopUpdateReleaseInput,
): Promise<PromoteDesktopUpdateReleaseResult> {
  const prefix = normalizePrefix(input.prefix ?? "desktop");
  const publicOrigin = (input.publicOrigin ?? "https://updates.lumicorp.ai")
    .replace(/\/+$/u, "");
  const versionPrefix = `${prefix}/releases/${input.version}/arm64`;
  const releaseMetadataKey = `${versionPrefix}/latest-mac.yml`;
  const metadataBody = await requireVerifiedText(
    input.store,
    releaseMetadataKey,
  );
  const manifest = parseManifest(metadataBody, input.version);
  const expectedPublicPrefix = `${publicOrigin}/${versionPrefix}/`;
  for (const file of manifest.files) {
    const name = artifactName(file.url);
    if (file.url !== `${expectedPublicPrefix}${name}`) {
      throw new Error(
        `Staged Desktop metadata URL must use the immutable release prefix: '${file.url}'.`,
      );
    }
  }
  if (manifest.path !== undefined) {
    const name = artifactName(manifest.path);
    if (manifest.path !== `${expectedPublicPrefix}${name}`) {
      throw new Error(
        `Staged Desktop metadata path must use the immutable release prefix: '${manifest.path}'.`,
      );
    }
  }

  const checksumKey = `${versionPrefix}/SHA256SUMS.txt`;
  const checksumBody = await requireVerifiedText(input.store, checksumKey);
  const checksums = parseChecksums(checksumBody);
  const referencedNames = manifest.files.map(({ url }) => artifactName(url));
  const expectedNames = [
    ...new Set([
      ...referencedNames,
      `Kestrel-${input.version}-mac-arm64.dmg`,
      `Kestrel-${input.version}-mac-arm64.dmg.blockmap`,
      ...referencedNames
        .filter((name) => name.endsWith(".zip"))
        .map((name) => `${name}.blockmap`),
    ]),
  ].sort();
  assertExactArtifactNames(checksums, expectedNames);
  for (const { name, sha256 } of checksums) {
    const key = `${versionPrefix}/${name}`;
    const head = await input.store.head(key);
    if (
      head?.sha256 !== sha256 ||
      typeof head.size !== "number" ||
      head.size < 1
    ) {
      throw new Error(
        `Unable to verify staged Desktop artifact '${key}' before promotion.`,
      );
    }
  }

  const metadataKey = `${prefix}/${input.channel}/arm64/latest-mac.yml`;
  const metadataBytes = Buffer.from(metadataBody);
  const metadataSha256 = digest(metadataBytes);
  const currentMetadata = await input.store.head(metadataKey);
  if (
    currentMetadata?.sha256 === metadataSha256 &&
    currentMetadata.size === metadataBytes.byteLength
  ) {
    return {
      promotedMetadataKey: metadataKey,
      releaseMetadataKey,
      previousMetadataEtag: currentMetadata.etag,
      alreadyCurrent: true,
    };
  }
  if (currentMetadata !== undefined && currentMetadata.etag === undefined) {
    throw new Error(
      `Current Desktop channel metadata '${metadataKey}' has no ETag for conditional promotion.`,
    );
  }
  await input.store.put({
    key: metadataKey,
    body: { kind: "text", value: metadataBody },
    contentType: "text/yaml; charset=utf-8",
    cacheControl: "no-cache, no-store, max-age=0",
    sha256: metadataSha256,
    condition: currentMetadata?.etag === undefined
      ? { ifNoneMatch: "*" }
      : { ifMatch: currentMetadata.etag },
  });
  return {
    promotedMetadataKey: metadataKey,
    releaseMetadataKey,
    previousMetadataEtag: currentMetadata?.etag,
    alreadyCurrent: false,
  };
}

async function publishImmutableText(input: {
  store: DesktopUpdateObjectStore;
  key: string;
  value: string;
  uploaded: string[];
  skipped: string[];
  contentType?: string | undefined;
}): Promise<void> {
  const size = Buffer.byteLength(input.value);
  const sha256 = digest(Buffer.from(input.value));
  const existing = await input.store.head(input.key);
  if (existing) {
    if (existing.sha256 !== sha256 || existing.size !== size) {
      throw new Error(`Immutable Desktop artifact mismatch for '${input.key}'.`);
    }
    input.skipped.push(input.key);
    return;
  }
  try {
    await input.store.put({
      key: input.key,
      body: { kind: "text", value: input.value },
      contentType: input.contentType ?? "text/plain; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
      sha256,
      condition: { ifNoneMatch: "*" },
    });
  } catch (error) {
    const raced = await input.store.head(input.key);
    if (raced?.sha256 === sha256 && raced.size === size) {
      input.skipped.push(input.key);
      return;
    }
    throw error;
  }
  const verified = await input.store.head(input.key);
  if (verified?.sha256 !== sha256 || verified.size !== size) {
    throw new Error(`Unable to verify uploaded Desktop artifact '${input.key}'.`);
  }
  input.uploaded.push(input.key);
}

async function requireVerifiedText(
  store: DesktopUpdateObjectStore,
  key: string,
): Promise<string> {
  const value = await store.getText(key);
  if (value === undefined) {
    throw new Error(`Staged Desktop release object is missing: '${key}'.`);
  }
  const bytes = Buffer.from(value);
  const head = await store.head(key);
  if (
    head?.sha256 !== digest(bytes) ||
    head.size !== bytes.byteLength
  ) {
    throw new Error(`Staged Desktop release object failed verification: '${key}'.`);
  }
  return value;
}

function parseChecksums(value: string): Array<{
  name: string;
  sha256: string;
}> {
  const entries = value
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._+-]+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error("Staged Desktop SHA256SUMS.txt is malformed.");
      }
      return {
        sha256: match[1],
        name: match[2],
      };
    });
  if (entries.length === 0) {
    throw new Error("Staged Desktop SHA256SUMS.txt is empty.");
  }
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
    throw new Error("Staged Desktop SHA256SUMS.txt contains duplicate artifacts.");
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function assertExactArtifactNames(
  checksums: Array<{ name: string }>,
  expectedNames: string[],
): void {
  const actualNames = checksums.map(({ name }) => name).sort();
  if (actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error(
      `Staged Desktop artifact set does not match metadata: expected ${
        expectedNames.join(", ")
      }; found ${actualNames.join(", ")}.`,
    );
  }
}

function parseManifest(value: string, expectedVersion: string): UpdateManifest {
  const parsed = parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("latest-mac.yml must contain an object.");
  }
  const candidate = parsed as {
    version?: unknown;
    files?: unknown;
    path?: unknown;
    sha512?: unknown;
    releaseDate?: unknown;
  };
  if (candidate.version !== expectedVersion) {
    throw new Error(
      `latest-mac.yml version must be ${expectedVersion}; found ${String(
        candidate.version,
      )}.`,
    );
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw new Error("latest-mac.yml must reference at least one artifact.");
  }
  const files = candidate.files.map((file): UpdateManifestFile => {
    if (typeof file !== "object" || file === null) {
      throw new Error("latest-mac.yml contains an invalid files entry.");
    }
    const entry = file as Record<string, unknown>;
    if (typeof entry.url !== "string" || entry.url.trim().length === 0) {
      throw new Error("latest-mac.yml files entries require a URL.");
    }
    const name = artifactName(entry.url);
    const sha512 = requireSha512(
      entry.sha512,
      `latest-mac.yml file '${name}'`,
    );
    const size = requirePositiveInteger(
      entry.size,
      `latest-mac.yml file '${name}' size`,
    );
    const blockMapSize = entry.blockMapSize === undefined
      ? undefined
      : requirePositiveInteger(
        entry.blockMapSize,
        `latest-mac.yml file '${name}' blockMapSize`,
      );
    return {
      url: entry.url,
      sha512,
      size,
      ...(blockMapSize === undefined ? {} : { blockMapSize }),
    };
  });
  if (typeof candidate.path !== "string" || candidate.path.trim().length === 0) {
    throw new Error("latest-mac.yml requires a legacy path.");
  }
  return {
    version: candidate.version,
    files,
    path: candidate.path,
    sha512: requireSha512(
      candidate.sha512,
      "latest-mac.yml legacy path",
    ),
    ...(typeof candidate.releaseDate === "string"
      ? { releaseDate: candidate.releaseDate }
      : {}),
  };
}

function assertManifestArtifactIntegrity(
  manifest: UpdateManifest,
  artifactDigests: ReadonlyMap<string, ArtifactDigest>,
): void {
  for (const file of manifest.files) {
    const name = artifactName(file.url);
    const actual = artifactDigests.get(name);
    if (actual === undefined) {
      throw new Error(`Desktop update artifact is missing: ${name}.`);
    }
    if (file.sha512 !== actual.sha512) {
      throw new Error(
        `latest-mac.yml SHA-512 does not match Desktop update artifact '${name}'.`,
      );
    }
    if (file.size !== actual.size) {
      throw new Error(
        `latest-mac.yml size does not match Desktop update artifact '${name}'.`,
      );
    }
  }

  const legacyName = artifactName(manifest.path);
  const legacyFile = manifest.files.find(
    (file) => artifactName(file.url) === legacyName,
  );
  if (legacyFile === undefined) {
    throw new Error(
      `latest-mac.yml legacy path must identify a files entry: '${manifest.path}'.`,
    );
  }
  if (manifest.sha512 !== legacyFile.sha512) {
    throw new Error(
      `latest-mac.yml legacy SHA-512 does not match files entry '${legacyName}'.`,
    );
  }
}

function requireSha512(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} requires a SHA-512 digest.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== value) {
    throw new Error(`${label} has an invalid SHA-512 digest.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function artifactName(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(value, "https://updates.invalid").pathname);
  } catch {
    throw new Error(`Invalid Desktop artifact URL '${value}'.`);
  }
  const name = path.posix.basename(decoded);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9._+-]+$/u.test(name)
  ) {
    throw new Error(`Invalid Desktop artifact name '${name}'.`);
  }
  return name;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(file: string): Promise<ArtifactDigest> {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sha256.update(bytes);
    sha512.update(bytes);
    size += bytes.byteLength;
  }
  return {
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
    size,
  };
}

function contentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".blockmap")) return "application/octet-stream";
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  return "application/zip";
}

function normalizePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Desktop publication prefix '${value}'.`);
  }
  return normalized;
}
