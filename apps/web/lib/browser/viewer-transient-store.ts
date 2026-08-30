import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

const VIEWER_TICKET_PREFIX = "kestrel-one:browser-viewer-ticket:v1:";
let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

export interface HostedBrowserViewerTicketStorePort {
  issue(input: { nonce: string; token: string; ttlSeconds: number }): Promise<void>;
  consume(input: { nonce: string; token: string }): Promise<boolean>;
  revoke(nonce: string): Promise<void>;
}

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

function digest(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}
