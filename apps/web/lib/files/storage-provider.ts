import "server-only";

import type { Readable } from "node:stream";
import { getStorageAdapter } from "@/lib/storage";

export type FileStorageProvider = {
  buildOriginalKey(input: { organizationId: string; blobId: string }): string;
  buildDerivativeKey(input: { organizationId: string; blobId: string; name: string }): string;
  putStream(input: {
    key: string;
    body: Readable;
    contentType: string;
    contentDisposition?: string | undefined;
  }): Promise<void>;
  readBuffer(key: string): Promise<Buffer>;
  readStream(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  signedReadUrl?(key: string, expiresInSeconds: number): Promise<string>;
};

export function getManagedFileStorageProvider(): FileStorageProvider {
  const storage = getStorageAdapter();
  return {
    buildOriginalKey: ({ organizationId, blobId }) =>
      storage.buildObjectKey("files", organizationId, blobId, "original"),
    buildDerivativeKey: ({ organizationId, blobId, name }) =>
      storage.buildObjectKey("files", organizationId, blobId, "representations", name),
    async putStream(input) {
      await storage.putObjectStream({
        key: input.key,
        body: input.body,
        contentType: input.contentType,
        ...(input.contentDisposition ? { contentDisposition: input.contentDisposition } : {}),
      });
    },
    readBuffer: async (key) => await storage.getObjectBuffer(key),
    readStream: async (key) => await storage.getObjectStream(key),
    delete: async (key) => await storage.deleteObject(key),
    exists: async (key) => await storage.objectExists(key),
    ...(storage.getSignedDownloadUrl
      ? { signedReadUrl: async (key: string, expiresInSeconds: number) =>
          await storage.getSignedDownloadUrl?.(key, expiresInSeconds) as string }
      : {}),
  };
}
