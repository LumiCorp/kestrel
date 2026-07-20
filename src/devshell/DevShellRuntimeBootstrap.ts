import { rename } from "node:fs/promises";

import { asRuntimeError } from "../runtime/RuntimeFailure.js";
import {
  createSqlExecutorFromEnv,
  type SqlExecutorStoreHandle,
} from "../store/createSessionStore.js";
import { runDevShellDatabaseMigrations } from "./DevShellDatabaseMigrations.js";
import { PostgresDevShellStore } from "./PostgresDevShellStore.js";
import { DevShellSupervisor } from "./DevShellSupervisor.js";

interface RecoverableDevShellStoreHandle {
  driver: string;
  close(): Promise<void>;
}

interface InitializableDevShellRuntime {
  initialize(): Promise<void>;
}

export interface DevShellRuntimeRecoveryOperations<
  TStoreHandle extends RecoverableDevShellStoreHandle,
  TRuntime extends InitializableDevShellRuntime,
> {
  createStoreHandle(): TStoreHandle | Promise<TStoreHandle>;
  createRuntime(storeHandle: TStoreHandle): TRuntime;
  isRecoverableStoreFailure(storeHandle: TStoreHandle, error: unknown): boolean;
  createRecoveryPath(sqlitePath: string): string;
  quarantineStore(sqlitePath: string, recoveryPath: string): Promise<void>;
  onStoreQuarantined?(input: { sqlitePath: string; recoveryPath: string }): void | Promise<void>;
}

export async function initializeDevShellRuntimeWithRecovery<
  TStoreHandle extends RecoverableDevShellStoreHandle,
  TRuntime extends InitializableDevShellRuntime,
>(input: {
  sqlitePath: string;
  operations: DevShellRuntimeRecoveryOperations<TStoreHandle, TRuntime>;
}): Promise<{ storeHandle: TStoreHandle; supervisor: TRuntime }> {
  const firstAttempt = await initializeAttempt(input.operations);
  if (firstAttempt.ok) {
    return firstAttempt.value;
  }
  if (input.operations.isRecoverableStoreFailure(firstAttempt.storeHandle, firstAttempt.error) === false) {
    throw firstAttempt.error;
  }

  const recoveryPath = input.operations.createRecoveryPath(input.sqlitePath);
  await input.operations.quarantineStore(input.sqlitePath, recoveryPath);
  await input.operations.onStoreQuarantined?.({
    sqlitePath: input.sqlitePath,
    recoveryPath,
  });

  const recoveryAttempt = await initializeAttempt(input.operations);
  if (recoveryAttempt.ok) {
    return recoveryAttempt.value;
  }
  throw recoveryAttempt.error;
}

export function createDevShellStoreRecoveryPath(
  sqlitePath: string,
  timestampMs = Date.now(),
  pid = process.pid,
): string {
  return `${sqlitePath}.recovery-${timestampMs}-${pid}`;
}

export async function createInitializedDevShellRuntime(input: {
  repoRoot: string;
  sqlitePath: string;
  onStoreQuarantined?: ((input: { sqlitePath: string; recoveryPath: string }) => void | Promise<void>) | undefined;
}): Promise<{
  storeHandle: SqlExecutorStoreHandle;
  supervisor: DevShellSupervisor;
}> {
  return initializeDevShellRuntimeWithRecovery({
    sqlitePath: input.sqlitePath,
    operations: {
      createStoreHandle: () => createDevShellStoreHandle(input),
      createRuntime: (storeHandle) =>
        new DevShellSupervisor(new PostgresDevShellStore(storeHandle.executor)),
      isRecoverableStoreFailure: (storeHandle, error) =>
        storeHandle.driver === "sqlite" && asRuntimeError(error).code === "STORE_SQLITE_INIT_FAILED",
      createRecoveryPath: createDevShellStoreRecoveryPath,
      quarantineStore: rename,
      ...(input.onStoreQuarantined !== undefined
        ? { onStoreQuarantined: input.onStoreQuarantined }
        : {}),
    },
  });
}

type InitializationAttempt<TStoreHandle, TRuntime> =
  | {
      ok: true;
      value: { storeHandle: TStoreHandle; supervisor: TRuntime };
    }
  | {
      ok: false;
      storeHandle: TStoreHandle;
      error: unknown;
    };

async function initializeAttempt<
  TStoreHandle extends RecoverableDevShellStoreHandle,
  TRuntime extends InitializableDevShellRuntime,
>(
  operations: DevShellRuntimeRecoveryOperations<TStoreHandle, TRuntime>,
): Promise<InitializationAttempt<TStoreHandle, TRuntime>> {
  const storeHandle = await operations.createStoreHandle();
  try {
    const supervisor = operations.createRuntime(storeHandle);
    await supervisor.initialize();
    return {
      ok: true,
      value: { storeHandle, supervisor },
    };
  } catch (error) {
    await storeHandle.close().catch(() => {});
    return {
      ok: false,
      storeHandle,
      error,
    };
  }
}

async function createDevShellStoreHandle(input: {
  repoRoot: string;
  sqlitePath: string;
}): Promise<SqlExecutorStoreHandle> {
  const storeHandle = createSqlExecutorFromEnv({ sqlitePath: input.sqlitePath });
  if (storeHandle.driver !== "postgres") {
    return storeHandle;
  }
  if (storeHandle.databaseUrl === undefined) {
    await storeHandle.close().catch(() => {});
    throw new Error("DATABASE_URL is required for dev shell service.");
  }
  try {
    await runDevShellDatabaseMigrations({
      repoRoot: input.repoRoot,
      databaseUrl: storeHandle.databaseUrl,
    });
    return storeHandle;
  } catch (error) {
    await storeHandle.close().catch(() => {});
    throw error;
  }
}
