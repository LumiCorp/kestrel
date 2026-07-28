import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";

import type { DesktopUpdateChannel } from "../apps/desktop/src/builderConfig.js";

export interface DesktopUpdateObjectHead {
  sha256?: string | undefined;
  size?: number | undefined;
}

export interface DesktopUpdateObjectStore {
  head(key: string): Promise<DesktopUpdateObjectHead | undefined>;
  put(input: {
    key: string;
    body: Uint8Array | string;
    contentType: string;
    cacheControl: string;
    sha256: string;
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
  const artifactNames = [...new Set([...referencedNames, dmgName])];
  for (const name of artifactNames) {
    if (!existsSync(path.join(input.outDir, name))) {
      throw new Error(`Desktop update artifact is missing: ${name}.`);
    }
  }

  const versionPrefix = `${prefix}/releases/${input.version}/arm64`;
  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const name of artifactNames) {
    const key = `${versionPrefix}/${name}`;
    const body = readFileSync(path.join(input.outDir, name));
    const sha256 = digest(body);
    const existing = await input.store.head(key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== body.byteLength) {
        throw new Error(
          `Immutable Desktop artifact mismatch for '${key}'.`,
        );
      }
      skipped.push(key);
      continue;
    }
    await input.store.put({
      key,
      body,
      contentType: contentType(name),
      cacheControl: "public, max-age=31536000, immutable",
      sha256,
    });
    const verified = await input.store.head(key);
    if (
      verified?.sha256 !== sha256 ||
      verified.size !== body.byteLength
    ) {
      throw new Error(`Unable to verify uploaded Desktop artifact '${key}'.`);
    }
    uploaded.push(key);
  }

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
  await input.store.put({
    key: metadataKey,
    body: metadataBody,
    contentType: "text/yaml; charset=utf-8",
    cacheControl: "no-cache, no-store, max-age=0",
    sha256: digest(Buffer.from(metadataBody)),
  });
  return {
    uploaded,
    skipped,
    promotedMetadataKey: metadataKey,
  };
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

function contentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
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
