import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_CORE_DESKTOP_PROFILE_ID,
  LocalCoreApiError,
  LocalCoreClient,
  acquireCoreLock,
  parseLocalCoreDesktopExecutionConfig,
  resolveLocalCorePaths,
  startLocalCoreApiServer,
} from "../../src/localCore/index.js";
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

test("Local Core API releases startup ownership when journal initialization fails", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcfail-"));
  const paths = resolveLocalCorePaths(home);
  try {
    const store = await ensureLocalCoreStore({ homePath: home });
    await store.executor.query("DROP TABLE runner_protocol_events");
    await closeLocalCoreStore(home);

    await assert.rejects(
      () => startLocalCoreApiServer({
        env: { KESTREL_CORE_HOME: home },
        platform: "darwin",
        coreVersion: "0.6.0",
        idleTimeoutMs: 0,
      }),
      /runner_protocol_events/u,
    );
    assert.equal(existsSync(paths.lockPath), false);
    assert.equal(existsSync(paths.apiSocketPath), false);

    await rm(paths.pgliteDataPath, { recursive: true, force: true });
    const recovered = await startLocalCoreApiServer({
      env: { KESTREL_CORE_HOME: home },
      platform: "darwin",
      coreVersion: "0.6.0",
      idleTimeoutMs: 0,
    });
    await recovered.close();
  } finally {
    await closeLocalCoreStore(home);
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

test("Local Core API restart ends subscriptions owned by the retired execution handler", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcrst-stream-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  let subscription: IncomingMessage | undefined;
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
    coreVersion: "0.5.0-beta.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
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
