import "server-only";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type StorageProvider = "local" | "local-s3" | "s3" | "r2";

export type StorageConfig = {
  provider: StorageProvider;
  localRootDir?: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  keyPrefix: string;
};

export type PutObjectInput = {
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  contentDisposition?: string;
};

export type StorageAdapter = {
  buildObjectKey(...segments: string[]): string;
  putObject(input: PutObjectInput): Promise<{ key: string }>;
  getObjectBuffer(key: string): Promise<Buffer>;
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>;
  deleteObject(key: string): Promise<void>;
  getSignedDownloadUrl?(
    key: string,
    expiresInSeconds?: number
  ): Promise<string>;
};

function sanitizeKeySegment(value: string) {
  return value.replace(/[^A-Za-z0-9!_.*'()/-]/g, "-").replace(/\/+/g, "/");
}

function joinKeySegments(segments: string[]) {
  return segments
    .map((segment) => sanitizeKeySegment(segment).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

async function bodyToBuffer(body: unknown) {
  if (!body) {
    throw new Error("Object body is empty");
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }

  const stream =
    body instanceof Readable
      ? body
      : Readable.from(body as AsyncIterable<Uint8Array>);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createS3Client(config: StorageConfig) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function createS3CompatibleStorageAdapter(
  config: StorageConfig
): StorageAdapter {
  const client = createS3Client(config);

  return {
    buildObjectKey(...segments) {
      return joinKeySegments([config.keyPrefix, ...segments]);
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentDisposition: input.contentDisposition,
          Metadata: input.metadata,
        })
      );

      return { key: input.key };
    },
    async getObjectBuffer(key) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      );

      return bodyToBuffer(response.Body);
    },
    async getObjectStream(key) {
      const buffer = await this.getObjectBuffer(key);
      return Readable.from(buffer);
    },
    async deleteObject(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      );
    },
    getSignedDownloadUrl(key, expiresInSeconds = 900) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
        { expiresIn: expiresInSeconds }
      );
    },
  };
}

export function createLocalFilesystemStorageAdapter(
  config: StorageConfig
): StorageAdapter {
  const rootDir =
    config.localRootDir || path.join(process.cwd(), ".local", "storage");

  function resolvePath(key: string) {
    return path.join(rootDir, key);
  }

  return {
    buildObjectKey(...segments) {
      return joinKeySegments([config.keyPrefix, ...segments]);
    },
    async putObject(input) {
      const filePath = resolvePath(input.key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from(input.body));
      return { key: input.key };
    },
    async getObjectBuffer(key) {
      return readFile(resolvePath(key));
    },
    async getObjectStream(key) {
      const buffer = await readFile(resolvePath(key));
      return Readable.from(buffer);
    },
    async deleteObject(key) {
      await rm(resolvePath(key), { force: true });
    },
  };
}
