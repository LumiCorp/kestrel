import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";

import { parseDesktopUpdateChannel } from "../apps/desktop/src/builderConfig.js";
import {
  publishDesktopUpdate,
  type DesktopUpdateObjectStore,
} from "./desktop-update-publisher.js";

const root = resolveRoot(process.cwd());
const version = readVersion(path.join(root, "apps", "desktop", "package.json"));
const bucket = required("KESTREL_DESKTOP_R2_BUCKET");
const client = new S3Client({
  endpoint: required("KESTREL_DESKTOP_R2_ENDPOINT"),
  region: "auto",
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("KESTREL_DESKTOP_R2_ACCESS_KEY_ID"),
    secretAccessKey: required("KESTREL_DESKTOP_R2_SECRET_ACCESS_KEY"),
  },
});

const store: DesktopUpdateObjectStore = {
  async head(key) {
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        etag: result.ETag,
        sha256: result.Metadata?.sha256,
        size: result.ContentLength,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },
  async put(input) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: input.body.kind === "file"
          ? createReadStream(input.body.path)
          : input.body.value,
        ...(input.body.kind === "file"
          ? { ContentLength: input.body.size }
          : {}),
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
        Metadata: { sha256: input.sha256 },
        ...("ifNoneMatch" in input.condition
          ? { IfNoneMatch: input.condition.ifNoneMatch }
          : { IfMatch: input.condition.ifMatch }),
      }),
    );
  },
};

const result = await publishDesktopUpdate({
  outDir: path.join(root, "apps", "desktop", "out"),
  version,
  channel: parseDesktopUpdateChannel(
    process.env.KESTREL_DESKTOP_UPDATE_CHANNEL,
  ),
  store,
  prefix: process.env.KESTREL_DESKTOP_R2_PREFIX,
});
process.stdout.write(
  `[desktop-update] uploaded=${result.uploaded.length} skipped=${result.skipped.length} promoted=${result.promotedMetadataKey}\n`,
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to publish a Desktop update.`);
  return value;
}

function readVersion(file: string): string {
  const value = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") {
    throw new Error(`Missing package version in ${file}.`);
  }
  return value.version;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown } | undefined;
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function resolveRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (readFileExists(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Unable to find workspace root from ${cwd}.`);
    current = parent;
  }
}

function readFileExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
