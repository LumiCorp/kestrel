import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_CORE_DESKTOP_PROFILE_ID,
  LocalCoreApiError,
  LocalCoreClient,
  acquireCoreLock,
  createDefaultLocalCoreRuntimeConfiguration,
  parseLocalCoreDesktopExecutionConfig,
  resolveLocalCorePaths,
  startLocalCoreApiServer,
} from "../../src/localCore/index.js";
import {
  LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
} from "../../src/localCore/runtimeConfiguration.js";
import {
  closeLocalCoreStore,
  ensureLocalCoreStore,
} from "../../src/localCore/store.js";
import {
  LOCAL_CORE_CREDENTIAL_IDS,
  MemoryLocalCoreCredentialStore,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "../../src/localCore/credentialStore.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { KcronStateStore } from "../../cli/kcron/state.js";
import { readRuntimeSettings, writeRuntimeSettings } from "../../cli/config/RuntimeSettings.js";
import { createConfiguredCliProtocolClient } from "../../cli/client/configuredClient.js";
import { KestrelClient as KestrelSdkClient } from "../../packages/sdk/src/runner.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_COMMAND_CONTRACT_VERSION,
} from "../../packages/protocol/src/index.js";

test("Local Core API serves health/status with bearer token auth", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    const paths = resolveLocalCorePaths(home);
    assert.equal(server.socketPath, paths.apiSocketPath);
    assert.equal((await readFile(paths.apiTokenPath, "utf8")).trim(), server.token);
    assert.equal(server.connection.socketPath, server.socketPath);
    assert.equal(server.connection.authToken, server.token);
    assert.deepEqual(JSON.parse(JSON.stringify(server.connection)), {
      socketPath: server.socketPath,
    });

    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    assert.deepEqual(await client.health(), { ok: true });
    const status = await client.status();
    assert.equal(status.state, "healthy");
    assert.equal(status.home.productRootPath, home);
    assert.equal(status.home.homePath, resolveLocalCorePaths(home).stateRootPath);
    assert.equal(status.lock.state, "live");
    assert.equal(status.lock.lock.socketPath, paths.apiSocketPath);
    assert.equal(status.dbMode, "pglite");

    const runtimeConfiguration = await client.runtimeConfiguration();
    assert.equal(runtimeConfiguration.version, 1);
    assert.equal(runtimeConfiguration.generation, 0);
    assert.equal(runtimeConfiguration.environmentOptionsMode, "inherit");
    assert.equal(runtimeConfiguration.modelPolicy.provider, "openrouter");
    assert.deepEqual(await client.credentialStatus(), {
      backend: "unavailable",
      available: false,
      credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
        id,
        configured: false,
      })),
    });

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      const health = await sdk.getHealth();
      assert.equal(health.service.version, "0.6.0");
      assert.equal(health.contracts.execution, EXECUTION_PROTOCOL_VERSION);
      assert.equal(health.contracts.command, RUNNER_COMMAND_CONTRACT_VERSION);
      assert.deepEqual(await sdk.ping({ nonce: "local-core-sdk" }, {
        actor: {
          actorId: "local-core-api-test",
          actorType: "end_user",
        },
      }), { nonce: "local-core-sdk" });
    } finally {
      await sdk.close();
    }

    const cli = createConfiguredCliProtocolClient({
      KESTREL_LOCAL_CORE_API_SOCKET: server.socketPath,
      KESTREL_LOCAL_CORE_API_TOKEN: server.token,
    });
    try {
      const pong = await cli.sendCommand("runner.ping", {
        nonce: "local-core-cli",
      });
      assert.equal(pong.type, "runner.pong");
      assert.equal(pong.payload.nonce, "local-core-cli");
    } finally {
      await cli.close();
    }

    const runnerEvents: string[] = [];
    await client.sendRunnerCommand(JSON.stringify({
      id: "local-core-desktop-ping",
      type: "runner.ping",
      metadata: {
        actor: {
          actorId: "kestrel-desktop",
          actorType: "operator",
          displayName: "Kestrel Desktop",
        },
      },
      payload: { nonce: "desktop-local-core" },
    }), {
      onLine(line) {
        runnerEvents.push(line);
      },
    });
    assert.equal(runnerEvents.length, 1);
    const runnerEvent = JSON.parse(runnerEvents[0] ?? "{}") as {
      type?: string;
      commandId?: string;
      payload?: { nonce?: string };
    };
    assert.equal(runnerEvent.type, "runner.pong");
    assert.equal(runnerEvent.commandId, "local-core-desktop-ping");
    assert.equal(runnerEvent.payload?.nonce, "desktop-local-core");

    const runs = await client.runs() as { runs?: unknown[] | undefined };
    assert.deepEqual(runs.runs, []);

    const bundleResponse = await client.supportBundle() as {
      supportBundle?: {
        runtime?: {
          home?: { homePath?: string | undefined } | undefined;
          manifest?: { coreVersion?: string | undefined } | null | undefined;
          dbMode?: string | undefined;
          migrations?: unknown;
          socketPresence?: { apiSocketPath?: string | undefined; apiSocketPresent?: boolean | undefined } | undefined;
        } | undefined;
        extra?: { legacyState?: { coreHome?: string | undefined } | undefined } | undefined;
      } | undefined;
    };
    assert.match(bundleResponse.supportBundle?.runtime?.home?.homePath ?? "", /kestrel-core-api-/u);
    assert.equal(bundleResponse.supportBundle?.runtime?.manifest?.coreVersion, "0.6.0");
    assert.equal(bundleResponse.supportBundle?.runtime?.dbMode, "pglite");
    assert.equal("migrations" in (bundleResponse.supportBundle?.runtime ?? {}), true);
    assert.match(bundleResponse.supportBundle?.runtime?.socketPresence?.apiSocketPath ?? "", /core\/api\.sock$/u);
    assert.equal(bundleResponse.supportBundle?.runtime?.socketPresence?.apiSocketPresent, true);
    assert.match(bundleResponse.supportBundle?.extra?.legacyState?.coreHome ?? "", /kestrel-core-api-/u);

    const unauthorized = new LocalCoreClient({ socketPath: server.socketPath, token: "wrong" });
    await assert.rejects(
      () => unauthorized.status(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 401,
    );
    await assert.rejects(
      () => unauthorized.runtimeConfiguration(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 401,
    );
    await assert.rejects(
      () => unauthorized.credentialStatus(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 401,
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API makes existing state and Core authority roots private before serving", {
  skip: process.platform === "win32",
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-private-"));
  const paths = resolveLocalCorePaths(home);
  await chmod(home, 0o755);
  await mkdir(paths.corePath, { recursive: true, mode: 0o755 });
  await chmod(paths.stateRootPath, 0o755);
  await chmod(paths.corePath, 0o755);

  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    assert.equal((await stat(paths.stateRootPath)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.corePath)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.apiTokenPath)).mode & 0o777, 0o600);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API refuses a second execution authority without unlinking its socket", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcauth-"));
  const first = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: home },
        platform: "darwin",
        coreVersion: "0.6.0",
        idleTimeoutMs: 0,
      }),
      /already has an active authority/u,
    );
    assert.equal(existsSync(first.socketPath), true);
    assert.deepEqual(
      await new LocalCoreClient({ socketPath: first.socketPath, token: first.token }).health(),
      { ok: true },
    );
  } finally {
    await first.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API canonicalizes symlink aliases before reserving execution authority", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcauth-real-"));
  const alias = `${home}-alias`;
  await symlink(home, alias, "dir");
  const first = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: alias },
        platform: "darwin",
        coreVersion: "0.6.0",
        idleTimeoutMs: 0,
      }),
      /already has an active authority/u,
    );
    assert.equal(existsSync(first.socketPath), true);
    assert.deepEqual(
      await new LocalCoreClient({ socketPath: first.socketPath, token: first.token }).health(),
      { ok: true },
    );
  } finally {
    await first.close();
    await rm(alias, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API does not adopt another authority instance in the same process", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcinstance-"));
  const paths = resolveLocalCorePaths(home);
  try {
    await acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/embedded/kestrel-core",
      ownerPid: process.pid,
      authorityId: "preexisting-core-instance",
      socketPath: paths.apiSocketPath,
      isPidAlive: () => true,
    });
    await writeFile(paths.apiSocketPath, "preexisting-authority-sentinel\n", "utf8");

    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: home },
        platform: "darwin",
        coreVersion: "0.6.0",
        isPidAlive: () => true,
        idleTimeoutMs: 0,
      }),
      /could not acquire sole execution authority/u,
    );
    assert.equal(await readFile(paths.apiSocketPath, "utf8"), "preexisting-authority-sentinel\n");
    assert.equal(
      JSON.parse(await readFile(paths.lockPath, "utf8")).authorityId,
      "preexisting-core-instance",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API does not steal or unlink another process authority", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcforeign-"));
  const paths = resolveLocalCorePaths(home);
  const foreignPid = process.pid + 100_000;
  try {
    await acquireCoreLock({
      homePath: home,
      coreVersion: "0.6.0",
      ownerExecutable: "/foreign/kestrel-core",
      ownerPid: foreignPid,
      socketPath: paths.apiSocketPath,
      isPidAlive: () => true,
    });
    await writeFile(paths.apiSocketPath, "foreign-authority-sentinel\n", "utf8");

    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: home },
        platform: "darwin",
        coreVersion: "0.6.0",
        isPidAlive: () => true,
        idleTimeoutMs: 0,
      }),
      /could not acquire sole execution authority/u,
    );
    assert.equal(await readFile(paths.apiSocketPath, "utf8"), "foreign-authority-sentinel\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core keeps control authority reachable and resets a broken startup store", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcfail-"));
  const paths = resolveLocalCorePaths(home);
  let server: Awaited<ReturnType<typeof startLocalCoreApiServer>> | undefined;
  try {
    const store = await ensureLocalCoreStore({ homePath: home });
    const canonicalPaths = resolveLocalCorePaths(await realpath(paths.stateRootPath));
    await store.executor.query("DROP TABLE runner_protocol_events");
    await writeFile(path.join(paths.pgliteDataPath, "reset-sentinel"), "archived\n", "utf8");
    await writeFile(path.join(home, "runtime.db"), "legacy-runtime\n", "utf8");
    await mkdir(paths.settingsPath, { recursive: true });
    await writeFile(path.join(paths.settingsPath, "preserve-sentinel"), "settings\n", "utf8");
    await mkdir(paths.workspaceRegistryPath, { recursive: true });
    await writeFile(path.join(paths.workspaceRegistryPath, "preserve-sentinel"), "workspaces\n", "utf8");
    await closeLocalCoreStore(home);

    server = await startLocalCoreApiServer({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.0",
      idleTimeoutMs: 0,
    });
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const blocked = await client.status();
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.lastError?.code, "LOCAL_CORE_EXECUTION_INIT_FAILED");
    assert.match(blocked.lastError?.message ?? "", /runner_protocol_events/u);
    assert.deepEqual(await client.health(), { ok: true });
    assert.equal((await client.runtimeConfiguration()).version, 1);
    assert.equal((await client.credentialStatus()).backend, "unavailable");
    assert.equal(existsSync(paths.lockPath), true);
    assert.equal(existsSync(paths.apiSocketPath), true);
    const tokenBefore = await readFile(paths.apiTokenPath, "utf8");
    const authorityBefore = JSON.parse(await readFile(paths.lockPath, "utf8")).authorityId;
    await assert.rejects(
      () => client.runs(),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 503
        && error.code === "LOCAL_CORE_EXECUTION_UNAVAILABLE",
    );

    const recovered = await client.resetRuntimeStore();
    assert.equal(recovered.status.state, "healthy");
    assert.equal(recovered.reset.storePath, canonicalPaths.pgliteDataPath);
    assert.ok(recovered.reset.archivedStorePath);
    assert.equal(
      await readFile(path.join(recovered.reset.archivedStorePath, "reset-sentinel"), "utf8"),
      "archived\n",
    );
    await assert.rejects(readFile(path.join(paths.pgliteDataPath, "reset-sentinel"), "utf8"), { code: "ENOENT" });
    assert.equal((await stat(paths.pgliteDataPath)).isDirectory(), true);
    assert.equal(await readFile(path.join(home, "runtime.db"), "utf8"), "legacy-runtime\n");
    assert.equal(await readFile(path.join(paths.settingsPath, "preserve-sentinel"), "utf8"), "settings\n");
    assert.equal(await readFile(path.join(paths.workspaceRegistryPath, "preserve-sentinel"), "utf8"), "workspaces\n");
    assert.equal(await readFile(paths.apiTokenPath, "utf8"), tokenBefore);
    assert.equal(JSON.parse(await readFile(paths.lockPath, "utf8")).authorityId, authorityBefore);
    assert.deepEqual((await client.runs() as { runs?: unknown[] }).runs, []);
    assert.equal(
      JSON.stringify(await client.supportBundle()).includes(recovered.reset.archivedStorePath),
      false,
    );

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      assert.deepEqual(await sdk.ping({ nonce: "after-reset" }, {
        actor: { actorId: "runtime-store-reset-test", actorType: "operator" },
      }), { nonce: "after-reset" });
    } finally {
      await sdk.close();
    }

    await server.close();
    assert.equal(existsSync(paths.lockPath), false);
    assert.equal(existsSync(paths.apiSocketPath), false);
  } finally {
    await server?.close();
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core repairs malformed runtime configuration while execution is blocked", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcbadcfg-"));
  const paths = resolveLocalCorePaths(home);
  const configurationPath = path.join(
    paths.settingsPath,
    LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
  );
  let server: Awaited<ReturnType<typeof startLocalCoreApiServer>> | undefined;
  try {
    await mkdir(paths.settingsPath, { recursive: true });
    await writeFile(configurationPath, "{not-json}\n", "utf8");
    server = await startLocalCoreApiServer({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.0",
      idleTimeoutMs: 0,
    });
    const client = new LocalCoreClient({
      socketPath: server.socketPath,
      token: server.token,
    });

    assert.equal((await client.status()).state, "blocked");
    await assert.rejects(
      () => client.runtimeConfiguration(),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 500
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID",
    );
    await assert.rejects(
      () => client.putJson("/v1/profiles", { profiles: [] }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 500
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID",
    );
    assert.equal(existsSync(path.join(paths.stateRootPath, "profiles.json")), false);
    await assert.rejects(
      () => client.postJson("/v1/runtime/configuration/repair", {
        runtimeConfiguration: { version: 1 },
      }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 400
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_REPAIR_INVALID",
    );
    assert.equal(await readFile(configurationPath, "utf8"), "{not-json}\n");

    const replacement = {
      ...createDefaultLocalCoreRuntimeConfiguration(),
      generation: 7,
      environmentOptionsMode: "replace" as const,
    };
    const initialRepair = {
      ...replacement,
      generation: 0,
    };
    assert.deepEqual(
      await client.repairRuntimeConfiguration(replacement),
      initialRepair,
    );
    assert.equal((await client.status()).state, "healthy");
    assert.deepEqual(await client.runtimeConfiguration(), initialRepair);

    await writeFile(configurationPath, "{not-json-again}\n", "utf8");
    const subsequentRepair = {
      ...replacement,
      generation: 1,
    };
    assert.deepEqual(
      await client.repairRuntimeConfiguration(replacement),
      subsequentRepair,
    );
    assert.deepEqual(await client.runtimeConfiguration(), subsequentRepair);
    await assert.rejects(
      () => client.repairRuntimeConfiguration(replacement),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 409
        && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_REPAIR_NOT_REQUIRED",
    );

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      assert.deepEqual(await sdk.ping({ nonce: "repaired-configuration" }, {
        actor: {
          actorId: "local-core-runtime-configuration-repair-test",
          actorType: "end_user",
        },
      }), { nonce: "repaired-configuration" });
    } finally {
      await sdk.close();
    }
  } finally {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core runtime-store reset requires explicit confirmation and exposes typed errors", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-contract-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  try {
    for (const body of [{}, { confirm: true, path: "/tmp/not-authoritative" }]) {
      await assert.rejects(
        () => client.postJson("/v1/runtime/store/reset", body),
        (error) => error instanceof LocalCoreApiError
          && error.statusCode === 400
          && error.code === "LOCAL_CORE_RUNTIME_STORE_RESET_INVALID"
          && error.serviceMessage === "Local Core runtime-store reset requires exactly { confirm: true }."
          && error.message === error.serviceMessage,
      );
    }

    const unauthorized = new LocalCoreClient({
      socketPath: server.socketPath,
      token: "wrong-token",
    });
    await assert.rejects(
      () => unauthorized.postJson("/v1/runtime/store/reset", { confirm: true }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 401
        && error.code === "LOCAL_CORE_API_UNAUTHORIZED",
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core runtime-store reset refuses external database authority without mutation", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-external-"));
  const paths = resolveLocalCorePaths(home);
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    databaseMode: "external",
    idleTimeoutMs: 0,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  try {
    await mkdir(paths.pgliteDataPath, { recursive: true });
    await writeFile(path.join(paths.pgliteDataPath, "dormant-sentinel"), "untouched\n", "utf8");

    await assert.rejects(
      () => client.resetRuntimeStore(),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 409
        && error.code === "LOCAL_CORE_RUNTIME_STORE_RESET_UNSUPPORTED",
    );
    assert.equal((await client.status()).dbMode, "external");
    assert.equal(
      await readFile(path.join(paths.pgliteDataPath, "dormant-sentinel"), "utf8"),
      "untouched\n",
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core runtime-store reset rejects an active execution before archiving", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-active-"));
  const paths = resolveLocalCorePaths(home);
  let releaseRun: (() => void) | undefined;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    executionRuntimeFactory: () => ({
      async runTurn(turn) {
        await runCanFinish;
        return {
          assistantText: "The active run completed before reset.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED" as const,
            sessionId: turn.sessionId,
            runId: turn.runId ?? "run-reset-active",
            errors: [],
            quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
            telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
          },
        };
      },
      async close() {},
    }),
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  const sdk = new KestrelSdkClient({
    target: { kind: "local", socketPath: server.socketPath, authToken: server.token },
  });
  try {
    await writeFile(path.join(paths.pgliteDataPath, "active-run-sentinel"), "present\n", "utf8");
    const stream = sdk.streamRun({
      profileId: "reference",
      turn: {
        sessionId: "session-reset-active",
        runId: "run-reset-active",
        message: "remain active until released",
        eventType: "user.message",
      },
    }, {
      actor: { actorId: "reset-active-test", actorType: "operator" },
      durability: "continue_on_disconnect",
    });
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await withTimeout(iterator.next());
      assert.equal(next.done, false);
      if (next.value?.type === "run.started") {
        break;
      }
    }

    await assert.rejects(
      withTimeout(client.resetRuntimeStore()),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 409
        && error.code === "LOCAL_CORE_EXECUTION_ACTIVE",
    );
    assert.equal((await client.status()).state, "healthy");
    assert.equal(
      await readFile(path.join(paths.pgliteDataPath, "active-run-sentinel"), "utf8"),
      "present\n",
    );

    releaseRun?.();
    while ((await withTimeout(iterator.next())).done === false) {
      // Drain the original execution before retrying maintenance.
    }
    assert.equal((await stream.result).type, "run.completed");

    const reset = await client.resetRuntimeStore();
    assert.equal(reset.status.state, "healthy");
    assert.ok(reset.reset.archivedStorePath);
  } finally {
    releaseRun?.();
    await sdk.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core restart and reset reject an in-flight runtime-store read", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-read-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  const handle = await ensureLocalCoreStore({ homePath: home });
  type ListRunSummaries = typeof handle.store.listRunSummaries;
  const mutableStore = handle.store as { listRunSummaries: ListRunSummaries };
  const originalListRunSummaries = handle.store.listRunSummaries.bind(handle.store) as ListRunSummaries;
  let releaseRead: (() => void) | undefined;
  let markReadEntered: (() => void) | undefined;
  const readEntered = new Promise<void>((resolve) => {
    markReadEntered = resolve;
  });
  const readCanFinish = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  mutableStore.listRunSummaries = (async (...args: Parameters<ListRunSummaries>) => {
    markReadEntered?.();
    await readCanFinish;
    return await originalListRunSummaries(...args);
  }) as ListRunSummaries;

  try {
    const pendingRead = client.runs();
    await withTimeout(readEntered, 5_000, "Timed out waiting for the runtime-store read.");
    const maintenanceOperations: Array<() => Promise<unknown>> = [
      () => client.restart(),
      () => client.resetRuntimeStore(),
    ];
    for (const maintenance of maintenanceOperations) {
      await assert.rejects(
        withTimeout(maintenance()),
        (error) => error instanceof LocalCoreApiError
          && error.statusCode === 409
          && error.code === "LOCAL_CORE_RUNTIME_STORE_BUSY",
      );
    }
    assert.equal((await client.status()).state, "healthy");

    releaseRead?.();
    await pendingRead;
    mutableStore.listRunSummaries = originalListRunSummaries;
    assert.equal((await client.resetRuntimeStore()).status.state, "healthy");
  } finally {
    releaseRead?.();
    mutableStore.listRunSummaries = originalListRunSummaries;
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core maintenance rejects runtime admission and configuration mutation races", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-admission-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  let runtimeRequest: ClientRequest | undefined;
  let settingsRequest: ClientRequest | undefined;
  try {
    runtimeRequest = await openSlowAuthorizedJsonRequest({
      socketPath: server.socketPath,
      token: server.token,
      method: "POST",
      requestPath: "/runtime/v2/commands",
      body: "{}",
    });
    for (const maintenance of [
      () => client.restart(),
      () => client.resetRuntimeStore(),
      () => client.patchSettings({
        modelPolicy: {
          version: 1,
          provider: "ollama",
          model: "llama3.2:latest",
          modelByStage: {},
          modelCapabilities: { visionInputEnabled: false },
        },
      }),
    ]) {
      await assert.rejects(
        maintenance(),
        (error) => error instanceof LocalCoreApiError
          && error.statusCode === 409
          && error.code === "LOCAL_CORE_RUNTIME_REQUEST_BUSY",
      );
    }
    await destroySlowRequest(runtimeRequest);
    runtimeRequest = undefined;

    settingsRequest = await openSlowAuthorizedJsonRequest({
      socketPath: server.socketPath,
      token: server.token,
      method: "PATCH",
      requestPath: "/v1/settings",
      body: JSON.stringify({ databaseMode: "external" }),
    });
    const settingsPath = path.join(
      resolveLocalCorePaths(home).settingsPath,
      "local-core-settings.json",
    );
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "{", "utf8");
    for (const maintenance of [() => client.restart(), () => client.resetRuntimeStore()]) {
      await assert.rejects(
        maintenance(),
        (error) => error instanceof LocalCoreApiError
          && error.statusCode === 409
          && error.code === "LOCAL_CORE_RUNTIME_CONFIG_BUSY",
      );
    }
    await writeFile(settingsPath, "{}\n", "utf8");
    await destroySlowRequest(settingsRequest);
    settingsRequest = undefined;

    await waitFor(async () => {
      try {
        return (await client.resetRuntimeStore()).status.state === "healthy";
      } catch (error) {
        if (
          error instanceof LocalCoreApiError
          && error.code === "LOCAL_CORE_RUNTIME_CONFIG_BUSY"
        ) {
          return false;
        }
        throw error;
      }
    });
  } finally {
    if (runtimeRequest !== undefined) {
      await destroySlowRequest(runtimeRequest);
    }
    if (settingsRequest !== undefined) {
      await destroySlowRequest(settingsRequest);
    }
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core serializes reset against every other maintenance request", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcreset-maintenance-"));
  let releaseRuntimeClose: (() => void) | undefined;
  let markRuntimeCloseEntered: (() => void) | undefined;
  const runtimeCloseEntered = new Promise<void>((resolve) => {
    markRuntimeCloseEntered = resolve;
  });
  const runtimeCloseCanFinish = new Promise<void>((resolve) => {
    releaseRuntimeClose = resolve;
  });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    executionRuntimeFactory: () => ({
      async runTurn(turn) {
        return {
          assistantText: "Runtime created for maintenance serialization.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED" as const,
            sessionId: turn.sessionId,
            runId: turn.runId ?? "run-reset-maintenance",
            errors: [],
            quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 },
            telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 },
          },
        };
      },
      async close() {
        markRuntimeCloseEntered?.();
        await runtimeCloseCanFinish;
      },
    }),
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  const sdk = new KestrelSdkClient({
    target: { kind: "local", socketPath: server.socketPath, authToken: server.token },
  });
  try {
    const stream = sdk.streamRun({
      profileId: "reference",
      turn: {
        sessionId: "session-reset-maintenance",
        runId: "run-reset-maintenance",
        message: "create one runtime",
        eventType: "user.message",
      },
    }, {
      actor: { actorId: "reset-maintenance-test", actorType: "operator" },
    });
    for await (const _event of stream) {
      // Consume the completed run so only runtime close remains in maintenance.
    }
    assert.equal((await stream.result).type, "run.completed");

    const resetPromise = client.resetRuntimeStore();
    await withTimeout(runtimeCloseEntered, 5_000, "Timed out waiting for reset maintenance to close the runtime.");
    const conflictingOperations: Array<() => Promise<unknown>> = [
      () => client.restart(),
      () => client.resetRuntimeStore(),
    ];
    for (const operation of conflictingOperations) {
      await assert.rejects(
        operation(),
        (error) => error instanceof LocalCoreApiError
          && error.statusCode === 409
          && error.code === "LOCAL_CORE_MAINTENANCE_ACTIVE",
      );
    }
    await assert.rejects(
      () => client.patchSettings({
        databaseMode: "external",
        databaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
      }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 409
        && error.code === "LOCAL_CORE_MAINTENANCE_ACTIVE",
    );

    releaseRuntimeClose?.();
    assert.equal((await resetPromise).status.state, "healthy");
  } finally {
    releaseRuntimeClose?.();
    await sdk.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core captures injected credentials once per execution bundle", async () => {
  const home = await mkdtemp(path.join("/tmp", "kccreds-"));
  const memory = new MemoryLocalCoreCredentialStore();
  const reads: LocalCoreCredentialId[] = [];
  await memory.set("provider.openrouter.default", "core-key-generation-one");
  const credentialStore: LocalCoreCredentialStore = {
    backend: memory.backend,
    available: memory.available,
    async get(id) {
      reads.push(id);
      return await memory.get(id);
    },
    set: memory.set.bind(memory),
    delete: memory.delete.bind(memory),
    has: memory.has.bind(memory),
  };

  const server = await startLocalCoreApiServer({
    env: {
      KESTREL_CORE_HOME: home,
      OPENROUTER_API_KEY: "ambient-key-must-not-be-authoritative",
    },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    credentialStore,
  });
  const client = new LocalCoreClient({
    socketPath: server.socketPath,
    token: server.token,
  });

  try {
    assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS);
    await memory.set("provider.openrouter.default", "core-key-generation-two");
    assert.deepEqual(reads, LOCAL_CORE_CREDENTIAL_IDS);

    const restarted = await client.restart();
    assert.equal(restarted.state, "healthy");
    assert.deepEqual(reads, [
      ...LOCAL_CORE_CREDENTIAL_IDS,
      ...LOCAL_CORE_CREDENTIAL_IDS,
    ]);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core provider readiness follows the authoritative credential store", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcready-"));
  const credentialStore = new MemoryLocalCoreCredentialStore();
  await credentialStore.set("provider.openrouter.default", "stored-openrouter-key");
  const server = await startLocalCoreApiServer({
    env: {
      KESTREL_CORE_HOME: home,
      OPENAI_API_KEY: "ambient-openai-key-must-not-count",
      ANTHROPIC_API_KEY: "ambient-anthropic-key-must-not-count",
    },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    credentialStore,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });

  try {
    const credentialStatus = await client.credentialStatus();
    assert.equal(credentialStatus.backend, "memory");
    assert.equal(credentialStatus.available, true);
    assert.equal(
      credentialStatus.credentials.find((entry) =>
        entry.id === "provider.openrouter.default"
      )?.configured,
      true,
    );
    assert.equal(
      JSON.stringify(credentialStatus).includes("stored-openrouter-key"),
      false,
    );
    const serializedRuntimeConfiguration = JSON.stringify(
      await client.runtimeConfiguration(),
    );
    assert.equal(serializedRuntimeConfiguration.includes("stored-openrouter-key"), false);
    assert.equal(serializedRuntimeConfiguration.includes("ambient-openai-key-must-not-count"), false);
    assert.equal(serializedRuntimeConfiguration.includes("ambient-anthropic-key-must-not-count"), false);
    const response = await client.providerReadiness() as {
      providerReadiness?: Record<string, { ready?: boolean; credential?: string }>;
    };
    assert.deepEqual(response.providerReadiness?.openrouter, {
      ready: true,
      credential: "configured",
    });
    assert.deepEqual(response.providerReadiness?.openai, {
      ready: false,
      credential: "missing",
    });
    assert.deepEqual(response.providerReadiness?.anthropic, {
      ready: false,
      credential: "missing",
    });
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core credential mutations are write-only and return sanitized status", async () => {
  const home = await mkdtemp(path.join("/tmp", "kccrud-"));
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    credentialStore,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });

  try {
    const saved = await client.setCredential(
      "tool.visual-crossing.default",
      "visual-crossing-secret",
    );
    assert.equal(
      saved.credentials.find((entry) => entry.id === "tool.visual-crossing.default")
        ?.configured,
      true,
    );
    assert.equal(JSON.stringify(saved).includes("visual-crossing-secret"), false);
    assert.equal(
      await credentialStore.get("tool.visual-crossing.default"),
      "visual-crossing-secret",
    );

    const deleted = await client.deleteCredential("tool.visual-crossing.default");
    assert.equal(deleted.deleted, true);
    assert.equal(
      deleted.credentials.credentials.find(
        (entry) => entry.id === "tool.visual-crossing.default",
      )?.configured,
      false,
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core rejects an ambiguous credential store and custom runtime factory", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcambiguous-"));
  try {
    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: home },
        platform: "darwin",
        coreVersion: "0.6.0",
        idleTimeoutMs: 0,
        credentialStore: new MemoryLocalCoreCredentialStore(),
        executionRuntimeFactory: () => {
          throw new Error("custom runtime must not be reached");
        },
      }),
      /cannot be combined with executionRuntimeFactory/u,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API reports execution unavailable after a failed store restart", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcrestart-fail-"));
  const paths = resolveLocalCorePaths(home);
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  try {
    const store = await ensureLocalCoreStore({ homePath: home });
    await store.executor.query("DROP TABLE runner_protocol_events");

    await assert.rejects(
      () => client.restart(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 500,
    );
    const failedStatus = await client.status();
    assert.equal(failedStatus.state, "blocked");
    assert.equal(failedStatus.lastError?.code, "LOCAL_CORE_EXECUTION_INIT_FAILED");
    assert.match(failedStatus.lastError?.message ?? "", /runner_protocol_events/u);
    assert.deepEqual(await client.health(), { ok: true });
    await assert.rejects(
      () => client.runs(),
      (error) => error instanceof LocalCoreApiError && error.statusCode === 503,
    );

    await rm(paths.pgliteDataPath, { recursive: true, force: true });
    const recovered = await client.restart();
    assert.equal(recovered.state, "healthy");
    assert.deepEqual((await client.runs() as { runs?: unknown[] }).runs, []);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core maintenance ends subscriptions owned by each retired execution handler", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcrst-stream-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  let subscription: IncomingMessage | undefined;
  let resetSubscription: IncomingMessage | undefined;
  try {
    subscription = await openRuntimeEventSubscription({
      socketPath: server.socketPath,
      token: server.token,
      runId: "run-restart-subscription",
    });
    assert.equal(subscription.statusCode, 200);
    const streamEnded = new Promise<void>((resolve, reject) => {
      subscription?.once("end", resolve);
      subscription?.once("error", reject);
      subscription?.resume();
    });

    const client = new LocalCoreClient({
      socketPath: server.socketPath,
      token: server.token,
    });
    const restarted = await client.restart();
    assert.equal(restarted.state, "healthy");
    await withTimeout(
      streamEnded,
      5_000,
      "Timed out waiting for Local Core restart to end the retired event stream.",
    );
    assert.equal(subscription.complete, true);

    resetSubscription = await openRuntimeEventSubscription({
      socketPath: server.socketPath,
      token: server.token,
      runId: "run-reset-subscription",
    });
    assert.equal(resetSubscription.statusCode, 200);
    const resetStreamEnded = new Promise<void>((resolve, reject) => {
      resetSubscription?.once("end", resolve);
      resetSubscription?.once("error", reject);
      resetSubscription?.resume();
    });
    const reset = await client.resetRuntimeStore();
    assert.equal(reset.status.state, "healthy");
    await withTimeout(
      resetStreamEnded,
      5_000,
      "Timed out waiting for Local Core reset to end the retired event stream.",
    );
    assert.equal(resetSubscription.complete, true);

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      assert.equal((await sdk.getHealth()).service.version, "0.6.0");
    } finally {
      await sdk.close();
    }
  } finally {
    subscription?.destroy();
    resetSubscription?.destroy();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core replays durable execution events to the SDK after restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-execution-"));
  const start = async () => await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    executionRuntimeFactory: () => ({
      async runTurn(turn) {
        return {
          assistantText: "Execution survived the client boundary.",
          finalizedPayload: null,
          output: {
            status: "COMPLETED" as const,
            sessionId: turn.sessionId,
            runId: turn.runId ?? "run-local-core-durable",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      async close() {},
    }),
  });
  const context = {
    actor: {
      actorId: "local-core-durable-test",
      actorType: "end_user" as const,
    },
    durability: "continue_on_disconnect" as const,
  };

  try {
    const firstServer = await start();
    let startedEventId: string | undefined;
    try {
      const sdk = new KestrelSdkClient({
        target: {
          kind: "local",
          socketPath: firstServer.socketPath,
          authToken: firstServer.token,
        },
      });
      try {
        const stream = sdk.streamRun({
          profileId: "reference",
          turn: {
            sessionId: "session-local-core-durable",
            runId: "run-local-core-durable",
            message: "run durably",
            eventType: "user.message",
          },
        }, context);
        for await (const event of stream) {
          if (event.type === "run.started") {
            startedEventId = event.id;
          }
        }
        const terminal = await stream.result;
        assert.equal(terminal.type, "run.completed");
        assert.equal(terminal.payload.result.assistantText, "Execution survived the client boundary.");
        assert.equal(terminal.payload.result.finalizedPayload, null);
      } finally {
        await sdk.close();
      }
    } finally {
      await firstServer.close();
    }
    assert.ok(startedEventId);

    const secondServer = await start();
    try {
      const sdk = new KestrelSdkClient({
        target: {
          kind: "local",
          socketPath: secondServer.socketPath,
          authToken: secondServer.token,
        },
      });
      try {
        const replay = sdk.subscribe({
          runId: "run-local-core-durable",
          sinceEventId: startedEventId,
        }, context);
        const replayed = await withTimeout(replay[Symbol.asyncIterator]().next());
        assert.equal(replayed.done, false);
        assert.equal(replayed.value?.type, "run.completed");
        assert.equal(replayed.value?.runId, "run-local-core-durable");
        await replay.cancel();
        await replay.result;
      } finally {
        await sdk.close();
      }
    } finally {
      await secondServer.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI disconnect leaves a durable Core run available to another client", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-cli-disconnect-"));
  let releaseRun: (() => void) | undefined;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    executionRuntimeFactory: () => ({
      async runTurn(turn) {
        await runCanFinish;
        return {
          assistantText: "The CLI disconnected, but Core completed the run.",
          finalizedPayload: { durable: true },
          output: {
            status: "COMPLETED" as const,
            sessionId: turn.sessionId,
            runId: turn.runId ?? "run-cli-disconnect",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 0,
              modelCalls: 0,
              durationMs: 1,
            },
          },
        };
      },
      async close() {},
    }),
  });

  try {
    const cli = createConfiguredCliProtocolClient({
      KESTREL_LOCAL_CORE_API_SOCKET: server.socketPath,
      KESTREL_LOCAL_CORE_API_TOKEN: server.token,
    });
    let startedEventId: string | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const unsubscribe = cli.onEvent((event) => {
      if (event.type === "run.started") {
        startedEventId = event.id;
        resolveStarted?.();
      }
    });
    const pending = cli.sendCommand("run.start", {
      profile: {
        id: "reference",
        label: "Reference",
        agent: "reference-react",
        sessionPrefix: "reference",
      },
      turn: {
        sessionId: "session-cli-disconnect",
        runId: "run-cli-disconnect",
        message: "finish after I leave",
        eventType: "user.message",
      },
    }).catch((error: unknown) => error);

    await withTimeout(started, 5_000, "Timed out waiting for the CLI run to start.");
    assert.ok(startedEventId);
    unsubscribe();
    await cli.close();
    releaseRun?.();
    await pending;

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      const replay = sdk.subscribe({
        runId: "run-cli-disconnect",
        sinceEventId: startedEventId,
      }, {
        actor: {
          actorId: "cli-disconnect-observer",
          actorType: "operator",
        },
      });
      const iterator = replay[Symbol.asyncIterator]();
      let completed = false;
      for (let index = 0; index < 8 && completed === false; index += 1) {
        const next = await withTimeout(
          iterator.next(),
          5_000,
          "Timed out waiting for the durable CLI run terminal event.",
        );
        if (next.done) {
          break;
        }
        completed = next.value?.type === "run.completed";
      }
      assert.equal(completed, true);
      await replay.cancel();
      await replay.result;
    } finally {
      await sdk.close();
    }
  } finally {
    releaseRun?.();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API exposes shared workspace and legacy-state endpoints", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-workspaces-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-workspace-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    await client.addWorkspace({
      workspaceId: "ws-api",
      rootPath: workspaceRoot,
      label: "API Workspace",
    });
    const workspaces = await client.workspaces() as {
      workspaces?: Array<{ workspaceId: string; rootPath: string; label?: string | undefined }>;
    };
    assert.equal(workspaces.workspaces?.[0]?.workspaceId, "ws-api");
    assert.equal(workspaces.workspaces?.[0]?.rootPath, workspaceRoot);
    assert.equal(workspaces.workspaces?.[0]?.label, "API Workspace");

    const legacy = await client.legacyState() as {
      legacyState?: { coreHome?: string | undefined; entries?: Array<{ name: string; status: string }> | undefined };
    };
    assert.equal(legacy.legacyState?.coreHome, resolveLocalCorePaths(home).stateRootPath);
    assert.equal(legacy.legacyState?.entries?.some((entry) => entry.name === "local_core" && entry.status === "present"), true);
  } finally {
    await server.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns default shell stores through client-backed adapters", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-stores-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  const previousCoreHome = process.env.KESTREL_CORE_HOME;
  const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
  try {
    process.env.KESTREL_CORE_HOME = home;
    process.env.KESTREL_LOCAL_CORE_API_SOCKET = server.socketPath;
    process.env.KESTREL_LOCAL_CORE_API_TOKEN = server.token;

    const workspaceStore = new WorkspaceStore(home);
    await workspaceStore.save({
      version: 3,
      workspaces: [{
        workspaceId: "ws-core",
        rootPath: home,
        automationEnabled: true,
        discoveredAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      }],
    });
    assert.equal((await new WorkspaceStore(home).load()).workspaces[0]?.workspaceId, "ws-core");

    const sessionStore = new SessionStore(home);
    await sessionStore.save({
      version: 5,
      activeSessionName: "shell",
      sessions: [{
        name: "shell",
        sessionId: "session-shell",
        profileId: "reference",
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
        started: true,
      }],
    });
    assert.equal((await new SessionStore(home).load()).activeSessionName, "shell");

    const profiles = await new ProfileStore(home).load();
    assert.equal(profiles.some((profile) => profile.id === "reference"), true);

    await new HistoryStore(home).append({
      source: "runner",
      eventId: "event-1",
      sessionId: "session-shell",
      sessionName: "shell",
      profileId: "reference",
      timestamp: "2026-06-17T00:00:00.000Z",
      role: "assistant",
      text: "hello from Core",
    });
    assert.equal((await new HistoryStore(home).readTranscript("session-shell"))[0]?.text, "hello from Core");

    await new UiStateStore(home).save({
      version: 5,
      activeView: "chat",
      activeRegion: "composer",
      layoutMode: "minimal",
      paneSizes: { sessions: 0.28, chat: 0.44, logs: 0.28 },
      themeMode: "system",
      splashVisible: false,
      densityMode: "dense",
      layoutProfile: "wide",
      overlayLayout: "adaptive",
      logFilters: {
        level: "ALL",
        eventQuery: "",
        runIdQuery: "",
        paused: false,
        grouped: true,
      },
      scroll: {
        chat: { offset: 0, cursor: 0, tailLocked: false },
        logs: { offset: 0, cursor: 0, tailLocked: false },
        sessions: { offset: 0, cursor: 0, tailLocked: false },
      },
      detailDrawer: {
        open: false,
        source: "chat",
        expanded: false,
      },
      paletteRecentCommands: [],
    });
    assert.equal((await new UiStateStore(home).load())?.activeView, "chat");

    await writeRuntimeSettings(home, {
      version: 1,
      defaults: { minimalMode: true },
    });
    assert.equal((await readRuntimeSettings(home)).defaults.minimalMode, true);

    await new KcronStateStore(home).save({
      version: 1,
      daemon: {
        pid: process.pid,
        startedAt: "2026-06-17T00:00:00.000Z",
        heartbeatAt: "2026-06-17T00:00:01.000Z",
      },
      workspaces: {},
    });
    assert.equal((await new KcronStateStore(home).load()).daemon?.pid, process.pid);
  } finally {
    restoreEnv("KESTREL_CORE_HOME", previousCoreHome);
    restoreEnv("KESTREL_LOCAL_CORE_API_SOCKET", previousSocket);
    restoreEnv("KESTREL_LOCAL_CORE_API_TOKEN", previousToken);
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns kcron duplicate lease decisions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-kcron-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const acquired = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid }) as { acquired?: boolean };
    assert.equal(acquired.acquired, true);

    const duplicate = await client.postJson("/v1/kcron/lease/acquire", { ownerPid: process.pid + 1 }) as {
      acquired?: boolean;
      reason?: string | undefined;
    };
    assert.equal(duplicate.acquired, false);
    assert.match(duplicate.reason ?? "", /already running/u);

    await client.postJson("/v1/kcron/lease/release", { ownerPid: process.pid });
    const state = await new KcronStateStore(home).load();
    assert.equal(state.daemon, undefined);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns Desktop settings and model policy", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcad-settings-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const saved = await client.patchDesktopSettings({
      selectedProvider: "ollama",
      databaseMode: "default",
      projects: [],
      modelPolicy: {
        version: 1,
        provider: "ollama",
        model: "llama3.2",
        modelByStage: {},
        modelCapabilities: {
          visionInputEnabled: false,
        },
      },
    });

    assert.equal(saved.settings.selectedProvider, "ollama");
    assert.equal(saved.modelPolicy.provider, "ollama");
    assert.equal(saved.modelPolicy.model, "llama3.2");

    const restored = await client.desktopSettings();
    assert.equal(restored.settings.selectedProvider, "ollama");
    assert.equal(restored.modelPolicy.provider, "ollama");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core registers a Core-owned Desktop execution profile resolved from model policy", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcdp-"));
  const runtimeProfiles: Array<{
    id: string;
    modelProvider: string | undefined;
    model: string | undefined;
  }> = [];
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
    executionRuntimeFactory: (profile) => {
      runtimeProfiles.push({
        id: profile.id,
        modelProvider: profile.modelProvider,
        model: profile.model,
      });
      return {
        async runTurn(turn) {
          return {
            assistantText: "Local Core accepted the registered Desktop profile.",
            finalizedPayload: null,
            output: {
              status: "COMPLETED" as const,
              sessionId: turn.sessionId,
              runId: turn.runId ?? "run-local-core-desktop-profile",
              errors: [],
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 1,
                toolCalls: 0,
                modelCalls: 0,
                durationMs: 1,
              },
            },
          };
        },
        async close() {},
      };
    },
  });
  const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
  const sdk = new KestrelSdkClient({
    target: {
      kind: "local",
      socketPath: server.socketPath,
      authToken: server.token,
    },
  });
  const context = {
    actor: {
      actorId: "local-core-desktop-profile-test",
      actorType: "end_user" as const,
    },
  };

  try {
    const initialRuntimeConfiguration = await client.runtimeConfiguration();
    assert.equal(initialRuntimeConfiguration.generation, 0);
    assert.equal(initialRuntimeConfiguration.modelPolicy.provider, "openrouter");
    const initial = await client.desktopExecutionConfig();
    assert.equal(initial.version, 1);
    assert.equal(initial.profileId, LOCAL_CORE_DESKTOP_PROFILE_ID);
    assert.equal(initial.resolvedProfile.id, initial.profileId);
    assert.equal(initial.resolvedProfile.shellKind, "desktop");
    assert.equal(initial.resolvedProfile.presetId, "desktop_dev_local");
    assert.equal(initial.resolvedProfile.modelProvider, "openrouter");

    assert.throws(
      () => parseLocalCoreDesktopExecutionConfig({
        ...initial,
        resolvedProfile: {
          ...initial.resolvedProfile,
          id: "desktop-inline-override",
        },
      }),
      /profile id does not match profileId/u,
    );
    assert.throws(
      () => parseLocalCoreDesktopExecutionConfig({
        ...initial,
        resolvedProfile: {
          ...initial.resolvedProfile,
          model: " ",
        },
      }),
      /resolvedProfile\.model must be a non-empty string/u,
    );
    assert.throws(
      () => parseLocalCoreDesktopExecutionConfig({
        ...initial,
        resolvedProfile: {
          ...initial.resolvedProfile,
          toolQueue: { perRunConcurrency: "many" },
        },
      }),
      /unsupported field 'toolQueue'/u,
    );

    const storedProfiles = await client.getJson("/v1/profiles") as {
      profiles: Array<Record<string, unknown>>;
    };
    await assert.rejects(
      () => client.putJson("/v1/profiles", {
        profiles: storedProfiles.profiles.map((profile, index) => index === 0
          ? { ...profile, id: LOCAL_CORE_DESKTOP_PROFILE_ID }
          : profile),
      }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 409
        && (error.body as { error?: { code?: string } }).error?.code === "LOCAL_CORE_PROFILE_ID_RESERVED",
    );

    await assert.rejects(
      () => client.patchSettings({
        modelPolicy: {
          ...initialRuntimeConfiguration.modelPolicy,
          apiKey: "must-not-enter-runtime-configuration",
        },
      }),
      (error) => error instanceof LocalCoreApiError
        && error.statusCode === 400
        && error.code === "LOCAL_CORE_MODEL_POLICY_INVALID",
    );
    assert.equal((await client.runtimeConfiguration()).generation, 0);

    await client.patchSettings({
      modelPolicy: {
        version: 1,
        provider: "ollama",
        model: "llama3.2:latest",
        modelByStage: {
          "agent.loop": "llama3.2:latest",
        },
        modelCapabilities: {
          visionInputEnabled: true,
        },
      },
    });

    const updatedRuntimeConfiguration = await client.runtimeConfiguration();
    assert.equal(updatedRuntimeConfiguration.generation, 1);
    assert.equal(updatedRuntimeConfiguration.environmentOptionsMode, "inherit");
    assert.equal(updatedRuntimeConfiguration.modelPolicy.provider, "ollama");
    assert.equal(updatedRuntimeConfiguration.modelPolicy.model, "llama3.2:latest");

    const canonicalProfiles = await client.getJson("/v1/profiles") as {
      profiles: Array<{ modelProvider?: string; model?: string }>;
    };
    assert.equal(canonicalProfiles.profiles[0]?.modelProvider, "ollama");
    assert.equal(canonicalProfiles.profiles[0]?.model, "llama3.2:latest");
    const savedProfiles = await client.putJson("/v1/profiles", {
      profiles: storedProfiles.profiles,
    }) as {
      profiles: Array<{ modelProvider?: string; model?: string }>;
    };
    assert.equal(savedProfiles.profiles[0]?.modelProvider, "ollama");
    assert.equal(savedProfiles.profiles[0]?.model, "llama3.2:latest");

    const resolved = await client.desktopExecutionConfig();
    assert.equal(resolved.profileId, initial.profileId);
    assert.equal(resolved.resolvedProfile.modelProvider, "ollama");
    assert.equal(resolved.resolvedProfile.model, "llama3.2:latest");

    const listed = await sdk.listProfiles(context);
    const listedDesktop = listed.find((profile) => profile.id === resolved.profileId);
    assert.equal(listedDesktop?.modelProvider, "ollama");
    assert.equal(listedDesktop?.model, "llama3.2:latest");
    assert.equal(listed.filter((profile) => profile.id === resolved.profileId).length, 1);

    const loaded = await sdk.getProfile(resolved.profileId, context);
    assert.equal(loaded.id, resolved.profileId);
    assert.equal(loaded.modelProvider, "ollama");
    assert.equal(loaded.model, "llama3.2:latest");

    const terminal = await sdk.run({
      profileId: resolved.profileId,
      turn: {
        sessionId: "session-local-core-desktop-profile",
        runId: "run-local-core-desktop-profile",
        message: "use the Core-owned Desktop profile",
        eventType: "user.message",
      },
    }, context);
    assert.equal(terminal.type, "run.completed");
    assert.equal(terminal.payload.result.assistantText, "Local Core accepted the registered Desktop profile.");
    assert.deepEqual(runtimeProfiles, [{
      id: resolved.profileId,
      modelProvider: "ollama",
      model: "llama3.2:latest",
    }]);
  } finally {
    await sdk.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API mirrors Desktop UI state without overwriting TUI state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-desktop-ui-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.5.1",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    assert.equal(await client.getDesktopUiState(), null);

    const first = await client.syncDesktopUiState({
      version: "desktop-ui-state-v1",
      source: "legacy-local-storage",
      sourceAppVersion: "0.5.1",
      capturedAt: "2026-07-09T12:00:00.000Z",
      entries: {
        "kchat:web:theme-mode": "dark",
        "kchat:web:threads:v2": "{\"summaries\":[],\"states\":{}}",
      },
    });
    assert.equal(first.updated, true);

    const repeated = await client.syncDesktopUiState({
      ...first.state,
      capturedAt: "2026-07-09T12:01:00.000Z",
    });
    assert.equal(repeated.updated, false);
    assert.equal(repeated.state.capturedAt, "2026-07-09T12:00:00.000Z");

    const changed = await client.syncDesktopUiState({
      ...first.state,
      capturedAt: "2026-07-09T12:02:00.000Z",
      entries: {
        ...first.state.entries,
        "kchat:web:theme-mode": "light",
      },
    });
    assert.equal(changed.updated, true);
    assert.equal((await client.getDesktopUiState())?.entries["kchat:web:theme-mode"], "light");

    const tuiState = await client.getJson("/v1/ui-state") as { state?: unknown };
    assert.equal(tuiState.state, null);
    const persisted = JSON.parse(
      await readFile(path.join(resolveLocalCorePaths(home).settingsPath, "desktop-ui-state.json"), "utf8"),
    ) as { version?: string };
    assert.equal(persisted.version, "desktop-ui-state-v1");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API restart swaps execution ownership across blocked and healthy stores", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcad-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    await client.patchDesktopSettings({
      databaseMode: "external",
      databaseUrl: "",
    });

    const missingUrlStatus = await client.restart();

    assert.equal(missingUrlStatus.state, "blocked");
    assert.equal(missingUrlStatus.dbMode, "external");
    assert.equal(missingUrlStatus.lastError?.code, "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED");

    await client.patchDesktopSettings({
      databaseMode: "default",
      databaseUrl: "",
    });

    const recoveredStatus = await client.restart();

    assert.equal(recoveredStatus.state, "healthy");
    assert.equal(recoveredStatus.dbMode, "pglite");
    assert.equal(recoveredStatus.databaseUrl, undefined);
    assert.deepEqual((await client.runs() as { runs?: unknown[] }).runs, []);

    const sdk = new KestrelSdkClient({
      target: {
        kind: "local",
        socketPath: server.socketPath,
        authToken: server.token,
      },
    });
    try {
      assert.equal((await sdk.getHealth()).service.version, "0.6.0");
    } finally {
      await sdk.close();
    }
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core API owns Desktop project runs and streams changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-desktop-runs-"));
  const project = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-api-project-"));
  await writeFile(path.join(project, "package.json"), JSON.stringify({
    scripts: {
      dev: "node -e \"console.log('http://127.0.0.1:4123'); setTimeout(() => {}, 60000)\"",
    },
    packageManager: "npm",
  }, null, 2), "utf8");

  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  const events: Array<{ runs: Array<{ runId: string; status: string; primaryPreviewUrl?: string | undefined }> }> = [];
  try {
    const client = new LocalCoreClient({ socketPath: server.socketPath, token: server.token });
    const unsubscribe = client.subscribeDesktopProjectRuns({
      onRuns(runs) {
        events.push({ runs });
      },
    });
    try {
      const launcher = await client.readDesktopProjectLauncher({ projectPath: project });
      assert.equal(launcher?.packageManager, "npm");
      assert.equal(launcher?.scripts.some((script) => script.name === "dev"), true);

      const run = await client.startDesktopProjectRun({ projectPath: project, scriptName: "dev" });
      assert.equal(run.status, "running");

      await waitFor(() => events.some((event) => event.runs.some((entry) => entry.runId === run.runId)));
      await waitFor(async () => {
        const runs = await client.listDesktopProjectRuns();
        return runs.some((entry) => entry.runId === run.runId && entry.primaryPreviewUrl === "http://127.0.0.1:4123/");
      });

      const reset = await client.resetRuntimeStore();
      assert.equal(reset.status.state, "healthy");
      const preserved = (await client.listDesktopProjectRuns()).find((entry) => entry.runId === run.runId);
      assert.equal(preserved?.status, "running");
      assert.equal(preserved?.primaryPreviewUrl, "http://127.0.0.1:4123/");

      const stopped = await client.stopDesktopProjectRun(run.runId);
      assert.equal(stopped?.runId, run.runId);
      await waitFor(() => events.some((event) => event.runs.some((entry) => entry.runId === run.runId && entry.status === "stopped")));
    } finally {
      unsubscribe();
    }
  } finally {
    await server.close();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for expected Local Core API state.");
}

async function openSlowAuthorizedJsonRequest(input: {
  socketPath: string;
  token: string;
  method: "PATCH" | "POST";
  requestPath: string;
  body: string;
}): Promise<ClientRequest> {
  return await new Promise<ClientRequest>((resolve, reject) => {
    const req = request({
      socketPath: input.socketPath,
      path: input.requestPath,
      method: input.method,
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(input.body),
        expect: "100-continue",
      },
    }, (response) => {
      response.resume();
    });
    req.once("continue", () => resolve(req));
    req.once("error", reject);
    req.flushHeaders();
  });
}

async function destroySlowRequest(requestToDestroy: ClientRequest): Promise<void> {
  if (requestToDestroy.destroyed) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    requestToDestroy.once("close", resolve);
  });
  requestToDestroy.destroy();
  await closed;
}

async function openRuntimeEventSubscription(input: {
  socketPath: string;
  token: string;
  runId: string;
}): Promise<IncomingMessage> {
  const body = JSON.stringify({
    filter: { runId: input.runId },
    metadata: {
      actor: {
        actorId: "local-core-restart-stream-test",
        actorType: "service",
      },
    },
  });
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request({
      socketPath: input.socketPath,
      path: "/runtime/v2/events/stream",
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 5_000,
  timeoutMessage = "Timed out waiting for Local Core event replay.",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
