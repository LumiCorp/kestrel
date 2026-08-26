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

export class ProjectContextGrantContinuityError extends Error {
  readonly code = "PROJECT_CONTEXT_GRANT_CONTINUITY_INVALID";

  constructor() {
    super("Project context authorization continuity could not be verified.");
    this.name = "ProjectContextGrantContinuityError";
  }
}

type ProjectContextGrantIdentity = Omit<ProjectContextGrant, "expiresAt">;

type ProjectContextGrantContinuation =
  | { executionId: string; resumeInteractionId?: never }
  | { executionId?: never; resumeInteractionId: string };

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
  await writeProjectContextGrant(grantId, grant, ttlSeconds);
  return { grantId, grant };
}

export async function refreshProjectContextGrant(input: {
  grantId: string;
  grant: Omit<ProjectContextGrant, "expiresAt">;
}) {
  const ttlSeconds = readGrantTtlSeconds();
  const grant: ProjectContextGrant = {
    ...input.grant,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  await writeProjectContextGrant(input.grantId, grant, ttlSeconds);
  return grant;
}

export async function resolveProjectContextGrantContinuationId(
  input: ProjectContextGrantIdentity & ProjectContextGrantContinuation,
) {
  let executionId: string;
  let sourceRuntimeRunId: string | null = null;

  if (input.executionId !== undefined) {
    executionId = input.executionId;
  } else {
    const resumeInteractionId = input.resumeInteractionId;
    const interaction = await knowledgeDb.query.threadInteractions.findFirst({
      where: (table, { and, eq, isNotNull }) => and(
        eq(table.id, resumeInteractionId),
        eq(table.organizationId, input.organizationId),
        eq(table.threadId, input.threadId),
        eq(table.source, "runtime"),
        eq(table.status, "processing"),
        isNotNull(table.resumedAt),
      ),
      columns: { turnId: true, sourceRuntimeRunId: true },
    });
    if (!(interaction?.turnId && interaction.sourceRuntimeRunId)) {
      throw new ProjectContextGrantContinuityError();
    }
    const sourceTurn = await knowledgeDb.query.threadTurns.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.id, interaction.turnId!),
        eq(table.organizationId, input.organizationId),
        eq(table.threadId, input.threadId),
        eq(table.authorUserId, input.actorUserId),
        eq(table.projectContextRevisionId, input.contextRevisionId),
      ),
      columns: { environmentExecutionId: true },
    });
    if (!sourceTurn?.environmentExecutionId) {
      throw new ProjectContextGrantContinuityError();
    }
    executionId = sourceTurn.environmentExecutionId;
    sourceRuntimeRunId = interaction.sourceRuntimeRunId;
  }

  const execution = await knowledgeDb.query.environmentRunExecutions.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.id, executionId),
      eq(table.organizationId, input.organizationId),
      eq(table.threadId, input.threadId),
      eq(table.actorId, input.actorUserId),
      eq(table.projectId, input.projectId),
      eq(table.projectContextRevisionId, input.contextRevisionId),
    ),
    columns: {
      projectContextGrantId: true,
      runtimeRunId: true,
    },
  });
  if (
    !execution?.projectContextGrantId?.trim() ||
    (sourceRuntimeRunId !== null && execution.runtimeRunId !== sourceRuntimeRunId)
  ) {
    throw new ProjectContextGrantContinuityError();
  }
  return execution.projectContextGrantId;
}

async function writeProjectContextGrant(
  grantId: string,
  grant: ProjectContextGrant,
  ttlSeconds: number,
) {
  const redis = await getContextGrantRedis();
  await redis.set(`${GRANT_PREFIX}${grantId}`, JSON.stringify(grant), {
    EX: ttlSeconds,
  });
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

export async function revokeProjectContextGrant(
  grantId: string,
  expectedGrant?: ProjectContextGrant,
) {
  const redis = await getContextGrantRedis();
  const key = `${GRANT_PREFIX}${grantId.trim()}`;
  if (!expectedGrant) {
    await redis.del(key);
    return;
  }
  await redis.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    { keys: [key], arguments: [JSON.stringify(expectedGrant)] },
  );
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
