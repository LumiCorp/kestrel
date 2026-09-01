import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

const VIEWER_TICKET_PREFIX = "kestrel-one:browser-viewer-ticket:v1:";
const VIEWER_CLEANUP_PREFIX = "kestrel-one:browser-viewer-cleanup:v1:";
let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

export interface HostedBrowserViewerRedisPort {
  set(
    key: string,
    value: string,
    options?: { EX?: number | undefined; NX?: boolean | undefined },
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  sendCommand(command: string[]): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface HostedBrowserViewerTicketStorePort {
  issue(input: { nonce: string; token: string; ttlSeconds: number }): Promise<void>;
  consume(input: { nonce: string; token: string }): Promise<boolean>;
  revoke(nonce: string): Promise<void>;
  readCleanupPending(threadId: string): Promise<HostedBrowserViewerCleanupPendingV1 | null>;
  markCleanupPending(
    input: HostedBrowserViewerCleanupPendingV1,
  ): Promise<HostedBrowserViewerCleanupPendingV1>;
  clearCleanupPending(
    expected: HostedBrowserViewerCleanupPendingV1,
  ): Promise<boolean>;
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
  constructor(private readonly redisOverride?: HostedBrowserViewerRedisPort) {}

  async issue(input: { nonce: string; token: string; ttlSeconds: number }) {
    const redis = await this.#redis();
    const result = await redis.set(
      key(input.nonce),
      digest(input.token),
      { EX: input.ttlSeconds, NX: true },
    );
    if (result !== "OK") throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }

  async consume(input: { nonce: string; token: string }) {
    const redis = await this.#redis();
    const value = await redis.sendCommand(["GETDEL", key(input.nonce)]);
    return value !== null && String(value) === digest(input.token);
  }

  async revoke(nonce: string) {
    await (await this.#redis()).del(key(nonce));
  }

  async readCleanupPending(threadId: string) {
    const value = await (await this.#redis()).get(cleanupKey(threadId));
    return value === null ? null : parseCleanupPending(value);
  }

  async markCleanupPending(input: HostedBrowserViewerCleanupPendingV1) {
    const parsed = parseCleanupPending(JSON.stringify(input));
    const redis = await this.#redis();
    const serialized = JSON.stringify(parsed);
    const scope = parsed.scope;
    const result = await redis.eval(MARK_CLEANUP_PENDING_SCRIPT, {
      keys: [cleanupKey(scope.threadId)],
      arguments: [
        serialized,
        parsed.reason,
        scope.organizationId,
        scope.environmentId,
        scope.projectId,
        scope.threadId,
        scope.runId,
        scope.actorId,
        scope.sessionId,
        String(scope.generation),
        scope.connectionId,
        scope.appName,
        scope.machineId,
      ],
    });
    if (typeof result !== "string") {
      throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
    }
    return parseCleanupPending(result);
  }

  async clearCleanupPending(expected: HostedBrowserViewerCleanupPendingV1) {
    const parsed = parseCleanupPending(JSON.stringify(expected));
    const result = await (await this.#redis()).eval(
      CLEAR_CLEANUP_PENDING_SCRIPT,
      {
        keys: [cleanupKey(parsed.scope.threadId)],
        arguments: [JSON.stringify(parsed)],
      },
    );
    return result === 1;
  }

  async #redis(): Promise<HostedBrowserViewerRedisPort> {
    return this.redisOverride ?? await viewerRedis() as unknown as HostedBrowserViewerRedisPort;
  }
}

export const MARK_CLEANUP_PENDING_SCRIPT = `
  local existing = redis.call("GET", KEYS[1])
  if not existing then
    redis.call("SET", KEYS[1], ARGV[1])
    return ARGV[1]
  end
  local ok, record = pcall(cjson.decode, existing)
  if not ok or not record.scope then
    return redis.error_reply("invalid cleanup-pending record")
  end
  local scope = record.scope
  if scope.organizationId ~= ARGV[3]
    or scope.environmentId ~= ARGV[4]
    or scope.projectId ~= ARGV[5]
    or scope.threadId ~= ARGV[6]
    or scope.runId ~= ARGV[7]
    or scope.actorId ~= ARGV[8]
    or scope.sessionId ~= ARGV[9]
    or tostring(scope.generation) ~= ARGV[10]
    or scope.connectionId ~= ARGV[11]
    or scope.appName ~= ARGV[12]
    or scope.machineId ~= ARGV[13] then
    return redis.error_reply("cleanup-pending identity conflict")
  end
  if ARGV[2] == "authority_loss" and record.reason ~= "authority_loss" then
    redis.call("SET", KEYS[1], ARGV[1])
    return ARGV[1]
  end
  return existing
`;

export const CLEAR_CLEANUP_PENDING_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

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

function digest(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
