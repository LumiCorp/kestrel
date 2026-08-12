import { lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import { asRuntimeError } from "../../src/runtime/RuntimeFailure.js";
import {
  createSqlExecutorFromEnv,
  type SqlExecutorStoreHandle,
} from "../../src/store/createSessionStore.js";
import { PostgresSessionStore } from "../../src/store/PostgresSessionStore.js";
import { KestrelChatRuntime, createRuntimeFactoryWithStore } from "../runtime/KestrelChatRuntime.js";
import {
  createLiveOnlyProgressListener,
  type RunnerHost,
} from "./RunnerHost.js";
import { composeHydraRuntime } from "../runtime/HydraRuntime.js";
import {
  FileClaudeSessionStore,
  FileRuntimeNativeSessionStore,
} from "../../src/runtimes/FileRuntimeStateStore.js";
import { resolveGatewayCredentialLease } from "../runtime/gateway-credential-broker.js";
import {
  buildRuntimeChildEnvironment,
  fingerprintRuntimeEnvironment,
} from "../../src/runtimes/RuntimeChildEnvironment.js";

type RunnerRuntimeFactory = NonNullable<
  ConstructorParameters<typeof RunnerHost>[1]
>;

export interface HostedRunnerStore {
  store: SessionStore;
  sqlitePath: string;
  ready(): Promise<void>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export interface HostedRunnerStoreRecovery {
  sqlitePath: string;
  recoveryPath: string;
}

export function createHostedRunnerRuntimeFactory(
  store: SessionStore,
  runtimeStateRoot = process.env.KESTREL_RUNNER_STORE_DIR,
): RunnerRuntimeFactory {
  const runtimeFactory = createRuntimeFactoryWithStore(store);
  const stateRoot = path.join(
    path.resolve(runtimeStateRoot ?? ".kestrel-runner"),
    "native-runtimes",
  );
  const nativeSessionStore = new FileRuntimeNativeSessionStore(stateRoot);
  const claudeSessionStore = new FileClaudeSessionStore(stateRoot);
  return (
    profile,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
    _onDetachedTurnEvent,
    onInteractionDelivered,
    onNativeSessionEstablished,
  ) => {
    const kestrel = new KestrelChatRuntime(profile, runtimeFactory, {
      onRunLog,
      onProgress: createLiveOnlyProgressListener(onProgress),
      onConsole,
      onReasoning,
      onTaskUpdate,
      onRunEvent,
    });
    return composeHydraRuntime({
      profile,
      kestrel,
      callbacks: {
        onRunLog,
        onProgress,
        onConsole,
        onReasoning,
        onRunEvent,
        onInteractionDelivered,
        onNativeSessionEstablished,
      },
      runtimeEnv: process.env,
      nativeSessionStore,
      claudeSessionStore,
      resolveRuntimeEnvironment: async (runtimeId) => {
        if (profile.modelCredential === undefined) {
          throw new Error(
            `${runtimeId === "codex" ? "Codex" : "Claude Code"} requires a tenant-scoped managed credential lease in hosted execution.`,
          );
        }
        const lease = await resolveGatewayCredentialLease(profile);
        const expectedProtocol = runtimeId === "codex" ? "openai" : "anthropic";
        if (lease.protocol !== expectedProtocol) {
          throw new Error(
            `${runtimeId === "codex" ? "Codex" : "Claude Code"} requires a ${expectedProtocol}-compatible credential lease.`,
          );
        }
        if (
          lease.organizationId !== profile.modelCredential.organizationId ||
          lease.environmentId !== profile.modelCredential.environmentId ||
          lease.gatewayId !== profile.modelCredential.gatewayId ||
          lease.rawModelId !== profile.modelCredential.rawModelId
        ) {
          throw new Error("The Runtime credential lease does not match the selected tenant, Environment, gateway, and model.");
        }
        const expiresAtMs = Date.parse(lease.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
          throw new Error("The Runtime credential lease is expired.");
        }
        const tenantScope = createHash("sha256")
          .update(`${lease.organizationId}\0${lease.environmentId}`)
          .digest("hex");
        const leaseScope = createHash("sha256")
          .update(`${lease.leaseId}\0${lease.expiresAt}`)
          .digest("hex");
        const tenantStateRoot = path.join(
          stateRoot,
          "tenants",
          tenantScope,
          runtimeId,
          leaseScope,
        );
        const providerEnvironment: NodeJS.ProcessEnv = {};
        if (runtimeId === "codex") {
          if (lease.apiKey) providerEnvironment.OPENAI_API_KEY = lease.apiKey;
          if (lease.baseUrl) providerEnvironment.OPENAI_BASE_URL = lease.baseUrl;
          providerEnvironment.OPENAI_MODEL = lease.rawModelId;
        } else {
          if (lease.apiKey) providerEnvironment.ANTHROPIC_API_KEY = lease.apiKey;
          if (lease.baseUrl) providerEnvironment.ANTHROPIC_BASE_URL = lease.baseUrl;
          providerEnvironment.ANTHROPIC_MODEL = lease.rawModelId;
        }
        const env = buildRuntimeChildEnvironment({
          runtimeId,
          baseEnvironment: process.env,
          runtimeEnvironment: providerEnvironment,
          configurationDirectory: tenantStateRoot,
        });
        return {
          env,
          credentialFingerprint: fingerprintRuntimeEnvironment({
            runtimeId,
            environment: env,
            scope: [lease.leaseId, lease.expiresAt],
          }),
          expiresAt: lease.expiresAt,
        };
      },
    });
  };
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
      ready: handle.ready,
      probe: handle.probe,
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
