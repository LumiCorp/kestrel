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
  sha512?: string | undefined;
  size?: number | undefined;
  blockMapSize?: number | undefined;
}

interface UpdateManifest {
  version: string;
  files: UpdateManifestFile[];
  path?: string | undefined;
  sha512?: string | undefined;
  releaseDate?: string | undefined;
}

export interface PublishDesktopUpdateInput {
  outDir: string;
  version: string;
  channel: DesktopUpdateChannel;
  store: DesktopUpdateObjectStore;
  publicOrigin?: string | undefined;
  prefix?: string | undefined;
}

export interface PublishDesktopUpdateResult {
  uploaded: string[];
  skipped: string[];
  promotedMetadataKey: string;
}

export async function publishDesktopUpdate(
  input: PublishDesktopUpdateInput,
): Promise<PublishDesktopUpdateResult> {
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

  const versionPrefix = `${prefix}/releases/${input.version}/arm64`;
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const checksums: Array<{ name: string; sha256: string }> = [];
  for (const name of artifactNames) {
    const key = `${versionPrefix}/${name}`;
    const artifactPath = path.join(input.outDir, name);
    const { sha256, size } = await digestFile(artifactPath);
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
  const metadataKey = `${prefix}/${input.channel}/arm64/latest-mac.yml`;
  const currentMetadata = await input.store.head(metadataKey);
  await input.store.put({
    key: metadataKey,
    body: { kind: "text", value: metadataBody },
    contentType: "text/yaml; charset=utf-8",
    cacheControl: "no-cache, no-store, max-age=0",
    sha256: digest(Buffer.from(metadataBody)),
    condition: currentMetadata?.etag === undefined
      ? { ifNoneMatch: "*" }
      : { ifMatch: currentMetadata.etag },
  });
  return {
    uploaded,
    skipped,
    promotedMetadataKey: metadataKey,
  };
}

async function publishImmutableText(input: {
  store: DesktopUpdateObjectStore;
  key: string;
  value: string;
  uploaded: string[];
  skipped: string[];
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
      contentType: "text/plain; charset=utf-8",
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
    return {
      url: entry.url,
      ...(typeof entry.sha512 === "string" ? { sha512: entry.sha512 } : {}),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      ...(typeof entry.blockMapSize === "number"
        ? { blockMapSize: entry.blockMapSize }
        : {}),
    };
  });
  return {
    version: candidate.version,
    files,
    ...(typeof candidate.path === "string" ? { path: candidate.path } : {}),
    ...(typeof candidate.sha512 === "string"
      ? { sha512: candidate.sha512 }
      : {}),
    ...(typeof candidate.releaseDate === "string"
      ? { releaseDate: candidate.releaseDate }
      : {}),
  };
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

async function digestFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), size };
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
