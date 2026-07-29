import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";

import type { DesktopUpdateObjectStore } from "./desktop-update-publisher.js";

export function createDesktopUpdateR2StoreFromEnvironment(): {
  store: DesktopUpdateObjectStore;
  prefix?: string | undefined;
} {
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
    async getText(key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (result.Body === undefined) {
          throw new Error(`Desktop update object '${key}' has no body.`);
        }
        return await result.Body.transformToString("utf-8");
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
  return {
    store,
    prefix: process.env.KESTREL_DESKTOP_R2_PREFIX?.trim() || undefined,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Desktop update publication.`);
  }
  return value;
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
