import { lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";

import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import { asRuntimeError } from "../../src/runtime/RuntimeFailure.js";
import {
  createSqlExecutorFromEnv,
  type SqlExecutorStoreHandle,
} from "../../src/store/createSessionStore.js";
import { PostgresSessionStore } from "../../src/store/PostgresSessionStore.js";
import { KestrelChatRuntime, createRuntimeFactoryWithStore } from "../runtime/KestrelChatRuntime.js";
import type { RunnerHost } from "./RunnerHost.js";

type RunnerRuntimeFactory = NonNullable<
  ConstructorParameters<typeof RunnerHost>[1]
>;

export interface HostedRunnerStore {
  store: SessionStore;
  sqlitePath: string;
  close(): Promise<void>;
}

export interface HostedRunnerStoreRecovery {
  sqlitePath: string;
  recoveryPath: string;
}

export function createHostedRunnerRuntimeFactory(
  store: SessionStore,
): RunnerRuntimeFactory {
  const runtimeFactory = createRuntimeFactoryWithStore(store);
  return (
    profile,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
  ) =>
    new KestrelChatRuntime(profile, runtimeFactory, {
      onRunLog,
      onProgress,
      onConsole,
      onReasoning,
      onTaskUpdate,
      onRunEvent,
    });
}

export async function createHostedRunnerStore(input: {
  storeDir: string;
  onStoreQuarantined?:
    | ((recovery: HostedRunnerStoreRecovery) => void | Promise<void>)
    | undefined;
}): Promise<HostedRunnerStore> {
  const sqlitePath = path.join(path.resolve(input.storeDir), "pglite");

  try {
    return await initializeHostedRunnerStore(sqlitePath);
  } catch (error) {
    if (asRuntimeError(error).code !== "STORE_SQLITE_INIT_FAILED") {
      throw error;
    }

    const recoveryPath = createHostedRunnerStoreRecoveryPath(sqlitePath);
    const archived = await archiveStore(sqlitePath, recoveryPath);
    if (archived) {
      await input.onStoreQuarantined?.({ sqlitePath, recoveryPath });
    }
    return await initializeHostedRunnerStore(sqlitePath);
  }
}

export function createHostedRunnerStoreRecoveryPath(
  sqlitePath: string,
  timestampMs = Date.now(),
  pid = process.pid,
): string {
  return `${sqlitePath}.recovery-${timestampMs}-${pid}`;
}

export async function createHostedRunnerStoreFromEnv(input: {
  env?: NodeJS.ProcessEnv | undefined;
  onStoreQuarantined?:
    | ((recovery: HostedRunnerStoreRecovery) => void | Promise<void>)
    | undefined;
} = {}): Promise<HostedRunnerStore | undefined> {
  const storeDir = (
    input.env?.KESTREL_RUNNER_STORE_DIR ??
    process.env.KESTREL_RUNNER_STORE_DIR
  )?.trim();
  if (storeDir === undefined || storeDir.length === 0) {
    return;
  }
  return await createHostedRunnerStore({
    storeDir,
    ...(input.onStoreQuarantined !== undefined
      ? { onStoreQuarantined: input.onStoreQuarantined }
      : {}),
  });
}

async function initializeHostedRunnerStore(
  sqlitePath: string,
): Promise<HostedRunnerStore> {
  let handle: SqlExecutorStoreHandle | undefined;
  try {
    await mkdir(path.dirname(sqlitePath), { recursive: true });
    handle = createSqlExecutorFromEnv({
      driver: "sqlite",
      sqlitePath,
    });
    await handle.executor.query("SELECT 1 AS ready");
    return {
      store: new PostgresSessionStore(handle.executor, {
        enforceSchemaV3: true,
      }),
      sqlitePath,
      close: handle.close,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function archiveStore(
  sqlitePath: string,
  recoveryPath: string,
): Promise<boolean> {
  try {
    await lstat(sqlitePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
  await rename(sqlitePath, recoveryPath);
  return true;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
