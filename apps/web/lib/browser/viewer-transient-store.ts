import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

const VIEWER_TICKET_PREFIX = "kestrel-one:browser-viewer-ticket:v1:";
const VIEWER_CLEANUP_PREFIX = "kestrel-one:browser-viewer-cleanup:v1:";
const VIEWER_CLEANUP_TTL_SECONDS = 24 * 60 * 60;
let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

export interface HostedBrowserViewerTicketStorePort {
  issue(input: { nonce: string; token: string; ttlSeconds: number }): Promise<void>;
  consume(input: { nonce: string; token: string }): Promise<boolean>;
  revoke(nonce: string): Promise<void>;
  readCleanupPending(threadId: string): Promise<HostedBrowserViewerCleanupPendingV1 | null>;
  markCleanupPending(input: HostedBrowserViewerCleanupPendingV1): Promise<void>;
  clearCleanupPending(input: {
    threadId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<void>;
}

export type HostedBrowserViewerCleanupScopeV1 = {
  version: "hosted_browser_viewer_cleanup_scope_v1";
  organizationId: string;
  environmentId: string;
  projectId: string;
  threadId: string;
  runId: string;
  actorId: string;
  sessionId: string;
  generation: number;
  connectionId: string;
  appName: string;
  machineId: string;
};

export type HostedBrowserViewerCleanupPendingV1 = {
  version: "hosted_browser_viewer_cleanup_pending_v1";
  scope: HostedBrowserViewerCleanupScopeV1;
  reason: "connect_unknown" | "disconnect_unknown" | "authority_loss";
  requestedAt: string;
};

export class RedisHostedBrowserViewerTicketStore
  implements HostedBrowserViewerTicketStorePort {
  async issue(input: { nonce: string; token: string; ttlSeconds: number }) {
    const redis = await viewerRedis();
    const result = await redis.set(
      key(input.nonce),
      digest(input.token),
      { EX: input.ttlSeconds, NX: true },
    );
    if (result !== "OK") throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }

  async consume(input: { nonce: string; token: string }) {
    const redis = await viewerRedis();
    const value = await redis.sendCommand(["GETDEL", key(input.nonce)]);
    return value !== null && String(value) === digest(input.token);
  }

  async revoke(nonce: string) {
    await (await viewerRedis()).del(key(nonce));
  }

  async readCleanupPending(threadId: string) {
    const value = await (await viewerRedis()).get(cleanupKey(threadId));
    return value === null ? null : parseCleanupPending(value);
  }

  async markCleanupPending(input: HostedBrowserViewerCleanupPendingV1) {
    const parsed = parseCleanupPending(JSON.stringify(input));
    const redis = await viewerRedis();
    const serialized = JSON.stringify(parsed);
    const result = await redis.set(cleanupKey(parsed.scope.threadId), serialized, {
      EX: VIEWER_CLEANUP_TTL_SECONDS,
      NX: true,
    });
    if (result === "OK") return;
    const existing = await redis.get(cleanupKey(parsed.scope.threadId));
    if (existing === null || !sameCleanupIdentity(parseCleanupPending(existing), parsed)) {
      throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
    }
  }

  async clearCleanupPending(input: {
    threadId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }) {
    const redis = await viewerRedis();
    const cleanup = await this.readCleanupPending(input.threadId);
    if (
      cleanup &&
      cleanup.scope.sessionId === input.sessionId &&
      cleanup.scope.generation === input.generation &&
      cleanup.scope.connectionId === input.connectionId
    ) {
      await redis.del(cleanupKey(input.threadId));
    }
  }
}

async function viewerRedis() {
  if (client?.isReady) return client;
  if (!connecting) {
    const url = process.env.REDIS_URL?.trim();
    if (!url) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
    const next = createClient({ url });
    const discard = () => {
      if (client === next) client = null;
    };
    next.on("error", discard);
    next.on("end", discard);
    connecting = next.connect().then(() => {
      client = next as RedisClientType;
      return client;
    });
  }
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function key(nonce: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  return `${VIEWER_TICKET_PREFIX}${nonce}`;
}

function cleanupKey(threadId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  return `${VIEWER_CLEANUP_PREFIX}${threadId}`;
}

function parseCleanupPending(value: string): HostedBrowserViewerCleanupPendingV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  }
  const record = parsed as Record<string, unknown>;
  const scope = record.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  }
  const bound = scope as Record<string, unknown>;
  const textFields = [
    "organizationId",
    "environmentId",
    "projectId",
    "threadId",
    "runId",
    "actorId",
    "sessionId",
    "connectionId",
    "appName",
    "machineId",
  ] as const;
  if (
    !(
      exactKeys(record, ["version", "scope", "reason", "requestedAt"]) &&
      exactKeys(bound, [
        "version",
        "organizationId",
        "environmentId",
        "projectId",
        "threadId",
        "runId",
        "actorId",
        "sessionId",
        "generation",
        "connectionId",
        "appName",
        "machineId",
      ])
    ) ||
    record.version !== "hosted_browser_viewer_cleanup_pending_v1" ||
    (record.reason !== "connect_unknown" &&
      record.reason !== "disconnect_unknown" &&
      record.reason !== "authority_loss") ||
    typeof record.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(record.requestedAt)) ||
    bound.version !== "hosted_browser_viewer_cleanup_scope_v1" ||
    !Number.isSafeInteger(bound.generation) ||
    Number(bound.generation) < 1 ||
    textFields.some((field) =>
      typeof bound[field] !== "string" ||
      String(bound[field]).length === 0 ||
      String(bound[field]).length > 1024)
  ) {
    throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  }
  return parsed as HostedBrowserViewerCleanupPendingV1;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function sameCleanupIdentity(
  left: HostedBrowserViewerCleanupPendingV1,
  right: HostedBrowserViewerCleanupPendingV1,
) {
  return left.scope.organizationId === right.scope.organizationId &&
    left.scope.environmentId === right.scope.environmentId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.threadId === right.scope.threadId &&
    left.scope.runId === right.scope.runId &&
    left.scope.actorId === right.scope.actorId &&
    left.scope.sessionId === right.scope.sessionId &&
    left.scope.generation === right.scope.generation &&
    left.scope.connectionId === right.scope.connectionId &&
    left.scope.appName === right.scope.appName &&
    left.scope.machineId === right.scope.machineId;
}

function digest(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
