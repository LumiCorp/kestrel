import "server-only";

import {
  createLocalFilesystemStorageAdapter,
  createS3CompatibleStorageAdapter,
  type StorageAdapter,
  type StorageConfig,
  type StorageProvider,
} from "./adapter";

let storageAdapter: StorageAdapter | null = null;

function parseStorageProvider(value: string | undefined): StorageProvider {
  switch (value) {
    case "local":
    case "s3":
    case "r2":
    case "local-s3":
      return value;
    default:
      return "local";
  }
}

export function getStorageConfig(): StorageConfig {
  const provider = parseStorageProvider(process.env.STORAGE_PROVIDER);
  const isLocalS3 = provider === "local-s3";

  return {
    provider,
    localRootDir:
      process.env.STORAGE_LOCAL_ROOT?.trim() ||
      `${process.cwd()}/.local/storage`,
    bucket: process.env.STORAGE_BUCKET?.trim() || "unified-app-storage",
    region: process.env.STORAGE_REGION?.trim() || "us-east-1",
    endpoint:
      process.env.STORAGE_ENDPOINT?.trim() ||
      (isLocalS3 ? "http://localhost:9000" : undefined),
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID?.trim() || "minioadmin",
    secretAccessKey:
      process.env.STORAGE_SECRET_ACCESS_KEY?.trim() || "minioadmin",
    forcePathStyle:
      process.env.STORAGE_FORCE_PATH_STYLE?.trim() === "true" || isLocalS3,
    keyPrefix: process.env.STORAGE_KEY_PREFIX?.trim() || "app",
  };
}

export function getStorageAdapter() {
  if (!storageAdapter) {
    const config = getStorageConfig();
    storageAdapter =
      config.provider === "local"
        ? createLocalFilesystemStorageAdapter(config)
        : createS3CompatibleStorageAdapter(config);
  }

  return storageAdapter;
}

export function resetStorageAdapterForTests() {
  storageAdapter = null;
}
