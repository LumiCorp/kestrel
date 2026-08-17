import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalCoreClient,
  LocalCoreConnectionManager,
  startLocalCoreApiServer,
  type LocalCoreApiServer,
  type LocalCoreStatus,
} from "../../src/localCore/index.js";


test("Local Core connection manager restarts Core after it exits between Desktop UI reads", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-reconnect-"));
  let server: LocalCoreApiServer | undefined = await startServer(home);
  let reconnects = 0;
  const firstClient = createClient(server);
  const manager = new LocalCoreConnectionManager({
    initialConnection: {
      status: server.status,
      client: firstClient,
    },
    connect: async () => {
      reconnects += 1;
      server = await startServer(home);
      return {
        status: server.status,
        client: createClient(server),
      };
    },
  });

  try {
    await firstClient.syncDesktopUiState({
      version: "desktop-ui-state-v1",
      source: "legacy-local-storage",
      sourceAppVersion: "0.6.0",
      capturedAt: "2026-07-14T12:00:00.000Z",
      entries: {
        "kchat:web:theme-mode": "dark",
      },
    });
    assert.equal(
      (await manager.executeIdempotent(async (client) => await client.getDesktopUiState()))
        ?.entries["kchat:web:theme-mode"],
      "dark",
    );

    await server.close();
    server = undefined;

    let readAttempts = 0;
    assert.equal(
      (await manager.executeIdempotent(async (client) => {
        readAttempts += 1;
        return await client.getDesktopUiState();
      }))
        ?.entries["kchat:web:theme-mode"],
      "dark",
    );
    assert.equal(readAttempts, 2);
    assert.equal(reconnects, 1);

    await manager.executeIdempotent(async (client) => await client.getDesktopUiState());
    assert.equal(reconnects, 1);
  } finally {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core connection manager does not retry non-connection failures", async () => {
  const client = {} as LocalCoreClient;
  let reconnects = 0;
  const manager = new LocalCoreConnectionManager({
    initialConnection: {
      status: {} as LocalCoreStatus,
      client,
    },
    connect: async () => {
      reconnects += 1;
      throw new Error("unexpected reconnect");
    },
  });
  const failure = new Error("invalid response");

  await assert.rejects(
    () => manager.executeIdempotent(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(reconnects, 0);
});

test("Local Core connection manager reconnects before a non-idempotent operation and invokes it once", async () => {
  const staleClient = {
    async health(): Promise<never> {
      throw Object.assign(new Error("missing socket"), { code: "ENOENT" });
    },
  } as unknown as LocalCoreClient;
  const recoveredClient = {
    async health(): Promise<{ ok: true }> {
      return { ok: true };
    },
  } as unknown as LocalCoreClient;
  let reconnects = 0;
  let operationCalls = 0;
  const states: string[] = [];
  const manager = new LocalCoreConnectionManager({
    initialConnection: {
      status: {} as LocalCoreStatus,
      client: staleClient,
    },
    connect: async () => {
      reconnects += 1;
      return {
        status: {} as LocalCoreStatus,
        client: recoveredClient,
      };
    },
    onStateChanged(state) {
      states.push(state);
    },
  });
  const ambiguousFailure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

  await assert.rejects(
    () => manager.executeOnce(async (client) => {
      operationCalls += 1;
      assert.equal(client, recoveredClient);
      throw ambiguousFailure;
    }),
    (error) => error === ambiguousFailure,
  );
  assert.equal(reconnects, 1);
  assert.equal(operationCalls, 1);
  assert.equal(manager.current(), undefined);
  assert.deepEqual(states, [
    "disconnected",
    "connecting",
    "connected",
    "disconnected",
  ]);
});

test("Local Core connection manager reports exhausted reconnect attempts", async () => {
  const states: string[] = [];
  const failure = Object.assign(new Error("socket unavailable"), {
    code: "ENOENT",
  });
  const manager = new LocalCoreConnectionManager({
    connect: async () => {
      throw failure;
    },
    onStateChanged(state) {
      states.push(state);
    },
  });

  await assert.rejects(() => manager.ensureConnected(), (error) => error === failure);
  assert.deepEqual(states, ["connecting", "disconnected"]);
});

test("Local Core connection manager coalesces concurrent recovery onto one connection", async () => {
  const staleClient = {} as LocalCoreClient;
  const recoveredClient = {} as LocalCoreClient;
  let reconnects = 0;
  const manager = new LocalCoreConnectionManager({
    initialConnection: {
      status: {} as LocalCoreStatus,
      client: staleClient,
    },
    connect: async () => {
      reconnects += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: {} as LocalCoreStatus,
        client: recoveredClient,
      };
    },
  });
  const calls = [0, 0];

  const results = await Promise.all(calls.map(async (_value, index) => await manager.executeIdempotent(async (client) => {
      calls[index] = (calls[index] ?? 0) + 1;
      if (client === staleClient) {
        throw Object.assign(new Error("missing socket"), { code: "ENOENT" });
      }
      return client;
    })));

  assert.deepEqual(results, [recoveredClient, recoveredClient]);
  assert.deepEqual(calls, [2, 2]);
  assert.equal(reconnects, 1);
});

test("Local Core project run subscriptions report daemon shutdown as a stale connection", async () => {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, "kestrel-core-stream-close-"));
  const server = await startServer(home);
  const client = createClient(server);
  let resolveDisconnect: ((error: Error) => void) | undefined;
  const disconnected = new Promise<Error>((resolve) => {
    resolveDisconnect = resolve;
  });
  const unsubscribe = client.subscribeDesktopProjectRuns({
    onRuns() {},
    onError(error) {
      resolveDisconnect?.(error);
    },
  });

  try {
    const closing = server.close();
    const error = await withTimeout(disconnected);
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET");
    await closing;
  } finally {
    unsubscribe();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core project run stream recovery reconnects once and receives a fresh snapshot", async () => {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, "kestrel-core-stream-recover-"));
  let server: LocalCoreApiServer | undefined = await startServer(home);
  const firstClient = createClient(server);
  let reconnects = 0;
  let snapshots = 0;
  let unsubscribe: (() => void) | undefined;
  let resolveRecovered: (() => void) | undefined;
  let allowReconnect: (() => void) | undefined;
  const reconnectAllowed = new Promise<void>((resolve) => {
    allowReconnect = resolve;
  });
  const recovered = new Promise<void>((resolve) => {
    resolveRecovered = resolve;
  });
  const manager = new LocalCoreConnectionManager({
    initialConnection: { status: server.status, client: firstClient },
    connect: async () => {
      await reconnectAllowed;
      reconnects += 1;
      server = await startServer(home);
      return { status: server.status, client: createClient(server) };
    },
    onConnected(connection) {
      unsubscribe?.();
      unsubscribe = connection.client.subscribeDesktopProjectRuns({
        onRuns() {
          snapshots += 1;
          resolveRecovered?.();
        },
      });
    },
  });
  unsubscribe = firstClient.subscribeDesktopProjectRuns({
    onRuns() {},
    onError() {
      manager.invalidate(firstClient);
      void manager.ensureConnected();
    },
  });

  try {
    await server.close();
    server = undefined;
    allowReconnect?.();
    await withTimeout(recovered);
    assert.equal(reconnects, 1);
    assert.equal(snapshots, 1);
  } finally {
    unsubscribe?.();
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("intentional Local Core project run unsubscribe is silent", async () => {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, "kestrel-core-stream-unsubscribe-"));
  const server = await startServer(home);
  const client = createClient(server);
  let reportedError: Error | undefined;
  const unsubscribe = client.subscribeDesktopProjectRuns({
    onRuns() {},
    onError(error) {
      reportedError = error;
    },
  });

  try {
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reportedError, undefined);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

async function startServer(home: string): Promise<LocalCoreApiServer> {
  return await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    databaseMode: "external",
    externalDatabaseUrl: "postgres://kestrel:kestrel@example.invalid/kestrel",
    idleTimeoutMs: 0,
  });
}

function createClient(server: LocalCoreApiServer): LocalCoreClient {
  return new LocalCoreClient({
    socketPath: server.socketPath,
    token: server.token,
  });
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for Local Core event.")), 1000).unref();
    }),
  ]);
}
