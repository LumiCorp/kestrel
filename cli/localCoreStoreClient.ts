import { existsSync } from "node:fs";
import path from "node:path";

import { LocalCoreClient } from "../src/localCore/client.js";
import { hasLocalCoreDaemonStoreOwnership } from "./localCoreStoreOwnership.js";

export interface LocalCoreStoreClientResolution {
  client: LocalCoreClient;
  homePath: string;
}

export function resolveLocalCoreStoreClient(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalCoreStoreClientResolution | undefined {
  if (
    hasLocalCoreDaemonStoreOwnership()
    || env.KESTREL_LOCAL_CORE_DAEMON === "1"
    || env.KESTREL_LOCAL_CORE_DIRECT === "1"
  ) {
    return ;
  }
  const socketPath = normalizeString(env.KESTREL_LOCAL_CORE_API_SOCKET);
  const token = normalizeString(env.KESTREL_LOCAL_CORE_API_TOKEN);
  const homePath = normalizeString(env.KESTREL_CORE_HOME);
  if (socketPath === undefined || token === undefined || homePath === undefined) {
    return ;
  }
  if (path.resolve(baseDir) !== path.resolve(homePath)) {
    return ;
  }
  if (existsSync(socketPath) === false) {
    return ;
  }
  return {
    homePath,
    client: new LocalCoreClient({ socketPath, token }),
  };
}

export function extractResponseField<T>(
  response: unknown,
  field: string,
  label: string,
): T {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error(`Local Core ${label} response must be an object.`);
  }
  const record = response as Record<string, unknown>;
  if (!(field in record)) {
    throw new Error(`Local Core ${label} response did not include '${field}'.`);
  }
  return record[field] as T;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
