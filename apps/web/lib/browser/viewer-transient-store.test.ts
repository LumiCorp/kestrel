import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEAR_CLEANUP_PENDING_SCRIPT,
  type HostedBrowserViewerCleanupPendingV1,
  type HostedBrowserViewerRedisPort,
  MARK_CLEANUP_PENDING_SCRIPT,
  RedisHostedBrowserViewerTicketStore,
} from "./viewer-transient-store";

test("cleanup-pending persists without TTL and promotes authority loss atomically", async () => {
  const redis = new MemoryViewerRedis();
  const store = new RedisHostedBrowserViewerTicketStore(redis);
  const disconnected = cleanupPending("disconnect_unknown", "connection-1");

  const first = await store.markCleanupPending(disconnected);
  const promoted = await store.markCleanupPending(
    cleanupPending("authority_loss", "connection-1"),
  );
  const downgrade = await store.markCleanupPending(
    cleanupPending("connect_unknown", "connection-1"),
  );

  assert.equal(first.reason, "disconnect_unknown");
  assert.equal(promoted.reason, "authority_loss");
  assert.equal(downgrade.reason, "authority_loss");
  assert.equal((await store.readCleanupPending("thread-1"))?.reason, "authority_loss");
  assert.doesNotMatch(MARK_CLEANUP_PENDING_SCRIPT, /EXPIRE|PEXPIRE|\bEX\b/iu);
});

test("cleanup-pending compare-and-delete cannot clear a promoted or replacement record", async () => {
  const redis = new MemoryViewerRedis();
  const store = new RedisHostedBrowserViewerTicketStore(redis);
  const stale = await store.markCleanupPending(
    cleanupPending("disconnect_unknown", "connection-1"),
  );
  const promoted = await store.markCleanupPending(
    cleanupPending("authority_loss", "connection-1"),
  );

  assert.equal(await store.clearCleanupPending(stale), false);
  assert.equal((await store.readCleanupPending("thread-1"))?.reason, "authority_loss");
  await assert.rejects(
    store.markCleanupPending(cleanupPending("disconnect_unknown", "connection-2")),
    /cleanup-pending identity conflict/u,
  );
  assert.equal(await store.clearCleanupPending(promoted), true);
  assert.equal(await store.readCleanupPending("thread-1"), null);
  assert.equal(redis.directDeleteCalls, 0);
  assert.match(CLEAR_CLEANUP_PENDING_SCRIPT, /GET/u);
  assert.match(CLEAR_CLEANUP_PENDING_SCRIPT, /DEL/u);
});

class MemoryViewerRedis implements HostedBrowserViewerRedisPort {
  readonly values = new Map<string, string>();
  directDeleteCalls = 0;

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    this.directDeleteCalls += 1;
    return this.values.delete(key) ? 1 : 0;
  }

  async sendCommand() {
    return null;
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ) {
    const key = options.keys[0]!;
    if (script === CLEAR_CLEANUP_PENDING_SCRIPT) {
      if (this.values.get(key) !== options.arguments[0]) return 0;
      this.values.delete(key);
      return 1;
    }
    assert.equal(script, MARK_CLEANUP_PENDING_SCRIPT);
    const candidate = options.arguments[0]!;
    const existing = this.values.get(key);
    if (!existing) {
      this.values.set(key, candidate);
      return candidate;
    }
    const currentRecord = JSON.parse(existing) as HostedBrowserViewerCleanupPendingV1;
    const nextRecord = JSON.parse(candidate) as HostedBrowserViewerCleanupPendingV1;
    if (JSON.stringify(currentRecord.scope) !== JSON.stringify(nextRecord.scope)) {
      throw new Error("cleanup-pending identity conflict");
    }
    if (nextRecord.reason === "authority_loss" && currentRecord.reason !== "authority_loss") {
      this.values.set(key, candidate);
      return candidate;
    }
    return existing;
  }
}

function cleanupPending(
  reason: HostedBrowserViewerCleanupPendingV1["reason"],
  connectionId: string,
): HostedBrowserViewerCleanupPendingV1 {
  return {
    version: "hosted_browser_viewer_cleanup_pending_v1",
    reason,
    requestedAt: reason === "authority_loss"
      ? "2026-08-30T12:00:01.000Z"
      : "2026-08-30T12:00:00.000Z",
    scope: {
      version: "hosted_browser_viewer_cleanup_scope_v1",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      sessionId: "session-1",
      generation: 1,
      connectionId,
      appName: "browser-app",
      machineId: "machine-1",
    },
  };
}
