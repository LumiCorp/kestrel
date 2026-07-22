import { and, eq } from "drizzle-orm";
import { createClient, type RedisClientType } from "redis";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireProjectRole } from "./access";

const GRANT_PREFIX = "kestrel-one:project-context-grant:";
const DEFAULT_TTL_SECONDS = 3600;

export type ProjectContextGrant = {
  organizationId: string;
  projectId: string;
  threadId: string;
  actorUserId: string;
  contextRevisionId: string;
  contextRevision: number;
  expiresAt: string;
};

let redisClient: RedisClientType | null = null;
let redisConnectPromise: Promise<RedisClientType> | null = null;

async function getContextGrantRedis() {
  if (redisClient?.isReady) {
    return redisClient;
  }
  if (!redisConnectPromise) {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      throw new Error("Project context grants require REDIS_URL.");
    }
    const client = createClient({ url });
    const discardClient = () => {
      if (redisClient === client) redisClient = null;
    };
    client.on("error", discardClient);
    client.on("end", discardClient);
    redisConnectPromise = client.connect().then(() => {
      redisClient = client as RedisClientType;
      return redisClient;
    });
  }
  try {
    return await redisConnectPromise;
  } finally {
    redisConnectPromise = null;
  }
}

export async function issueProjectContextGrant(
  input: Omit<ProjectContextGrant, "expiresAt">
) {
  const ttlSeconds = readGrantTtlSeconds();
  const grantId = crypto.randomUUID();
  const grant: ProjectContextGrant = {
    ...input,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  const redis = await getContextGrantRedis();
  await redis.set(`${GRANT_PREFIX}${grantId}`, JSON.stringify(grant), {
    EX: ttlSeconds,
  });
  return { grantId, grant };
}

export async function resolveProjectContextGrant(grantId: string) {
  const normalizedGrantId = grantId.trim();
  if (!normalizedGrantId) {
    return null;
  }
  const redis = await getContextGrantRedis();
  const raw = await redis.get(`${GRANT_PREFIX}${normalizedGrantId}`);
  if (!raw) {
    return null;
  }
  const grant = parseProjectContextGrant(raw);
  if (!grant || isProjectContextGrantExpired(grant)) {
    await redis.del(`${GRANT_PREFIX}${normalizedGrantId}`);
    return null;
  }

  const access = await requireProjectRole({
    projectId: grant.projectId,
    organizationId: grant.organizationId,
    userId: grant.actorUserId,
  });
  const [thread, contextRevision] = await Promise.all([
    knowledgeDb.query.threads.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, grant.threadId),
          eq(table.organizationId, grant.organizationId),
          eq(table.projectId, grant.projectId)
        ),
    }),
    knowledgeDb.query.projectContextRevisions.findFirst({
      where: and(
        eq(schema.projectContextRevisions.id, grant.contextRevisionId),
        eq(schema.projectContextRevisions.projectId, grant.projectId),
        eq(schema.projectContextRevisions.revision, grant.contextRevision)
      ),
    }),
  ]);
  if (!(thread && contextRevision) || thread.archivedAt) {
    await redis.del(`${GRANT_PREFIX}${normalizedGrantId}`);
    return null;
  }
  return { grant, role: access.role };
}

export async function revokeProjectContextGrant(grantId: string) {
  const redis = await getContextGrantRedis();
  await redis.del(`${GRANT_PREFIX}${grantId.trim()}`);
}

function readGrantTtlSeconds() {
  const parsed = Number.parseInt(
    process.env.KESTREL_ONE_CONTEXT_GRANT_TTL_SECONDS ?? "",
    10
  );
  return Number.isInteger(parsed) && parsed >= 60 && parsed <= 86_400
    ? parsed
    : DEFAULT_TTL_SECONDS;
}

export function isProjectContextGrantExpired(
  grant: ProjectContextGrant,
  now = Date.now()
) {
  return new Date(grant.expiresAt).getTime() <= now;
}

export function parseProjectContextGrant(
  raw: string
): ProjectContextGrant | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.organizationId !== "string" ||
      typeof value.projectId !== "string" ||
      typeof value.threadId !== "string" ||
      typeof value.actorUserId !== "string" ||
      typeof value.contextRevisionId !== "string" ||
      typeof value.contextRevision !== "number" ||
      typeof value.expiresAt !== "string"
    ) {
      return null;
    }
    return value as ProjectContextGrant;
  } catch {
    return null;
  }
}
