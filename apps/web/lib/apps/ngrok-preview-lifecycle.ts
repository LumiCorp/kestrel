import { randomBytes } from "node:crypto";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { authorizeAppRuntime } from "./runtime";
import { AppRuntimeError } from "./runtime";

const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 240;
const MAX_ACTIVE_PREVIEWS = 5;
const RESERVED_PORTS = new Set([43_104, 43_105]);

type AuthorizedPolicy = Awaited<ReturnType<typeof authorizeAppRuntime>>;

export async function handleNgrokPreviewLifecycle(input: {
  request: Request;
  path: string[];
  capability: string;
  authorization: string;
  ticket: EnvironmentExecutionTicket;
  policy: AuthorizedPolicy;
}) {
  if (!(input.policy.connectionId && input.policy.connection)) {
    throw new AppRuntimeError("NGROK_PREVIEW_CONNECTION_REQUIRED", 409);
  }
  if (input.policy.credential?.kind !== "ngrok_agent") {
    throw new AppRuntimeError("NGROK_PREVIEW_CREDENTIAL_INVALID", 503);
  }
  switch (input.capability) {
    case "publish":
      return NextResponse.json(
        {
          preview: await publishPreview({
            ...input,
            connectionId: input.policy.connectionId,
            wildcardDomain: input.policy.credential.wildcardDomain,
            body: await input.request.json().catch(() => null),
          }),
        },
        { status: 201 }
      );
    case "list":
      return NextResponse.json({ previews: await listPreviews(input.ticket) });
    case "renew":
      return NextResponse.json({
        preview: await renewPreview({
          previewId: input.path[1] ?? "",
          ticket: input.ticket,
          authorization: input.authorization,
          body: await input.request.json().catch(() => null),
        }),
      });
    case "close":
      await closePreview({
        previewId: input.path[1] ?? "",
        ticket: input.ticket,
        authorization: input.authorization,
      });
      return NextResponse.json({ ok: true });
    default:
      throw new AppRuntimeError("NGROK_PREVIEW_CAPABILITY_DENIED", 404);
  }
}

async function publishPreview(input: {
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  connectionId: string;
  wildcardDomain: string;
  body: unknown;
}) {
  const body = parsePublishBody(input.body);
  await assertPortListening({
    ticket: input.ticket,
    authorization: input.authorization,
    port: body.port,
  });
  const now = new Date();
  const maximumExpiresAt = new Date(now.getTime() + MAX_TTL_MINUTES * 60_000);
  const expiresAt = new Date(
    Math.min(
      now.getTime() + body.ttlMinutes * 60_000,
      maximumExpiresAt.getTime()
    )
  );
  const hostname = `p-${randomBytes(16).toString("hex")}.${input.wildcardDomain.slice(2)}`;
  const projectId = await requireProjectId(input.ticket.threadId);
  let lease: typeof schema.workspacePreviewLeases.$inferSelect | undefined;
  try {
    lease = await knowledgeDb.transaction(async (transaction) => {
      const lockKey = `kestrel:workspace:previews:${input.ticket.workspaceId}`;
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      );
      await transaction
        .update(schema.workspacePreviewLeases)
        .set({ status: "expired", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workspacePreviewLeases.workspaceId, input.ticket.workspaceId),
            inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"]),
            lt(schema.workspacePreviewLeases.expiresAt, now)
          )
        );
      const existing = await transaction.query.workspacePreviewLeases.findFirst({
        where: and(
          eq(schema.workspacePreviewLeases.workspaceId, input.ticket.workspaceId),
          eq(schema.workspacePreviewLeases.port, body.port),
          inArray(schema.workspacePreviewLeases.status, ["provisioning", "active", "closing"])
        ),
      });
      if (existing) return existing;
      const [{ value: activeCount }] = await transaction
        .select({ value: count() })
        .from(schema.workspacePreviewLeases)
        .where(
          and(
            eq(schema.workspacePreviewLeases.workspaceId, input.ticket.workspaceId),
            inArray(schema.workspacePreviewLeases.status, ["provisioning", "active", "closing"])
          )
        );
      if (Number(activeCount) >= MAX_ACTIVE_PREVIEWS) {
        throw new AppRuntimeError("WORKSPACE_PREVIEW_LIMIT_REACHED", 409);
      }
      const [created] = await transaction
        .insert(schema.workspacePreviewLeases)
        .values({
          organizationId: input.ticket.organizationId,
          environmentId: input.ticket.environmentId,
          workspaceId: input.ticket.workspaceId,
          projectId,
          threadId: input.ticket.threadId,
          runId: input.ticket.runId,
          actorId: input.ticket.actorId,
          connectionId: input.connectionId,
          port: body.port,
          name: body.name,
          hostname,
          status: "provisioning",
          expiresAt,
          maximumExpiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error("Workspace preview lease was not created.");
      return created;
    });
  } catch (error) {
    if (error instanceof AppRuntimeError) throw error;
    const concurrent = await knowledgeDb.query.workspacePreviewLeases.findFirst({
      where: and(
        eq(schema.workspacePreviewLeases.workspaceId, input.ticket.workspaceId),
        eq(schema.workspacePreviewLeases.port, body.port),
        inArray(schema.workspacePreviewLeases.status, ["provisioning", "active", "closing"])
      ),
    });
    if (concurrent) {
      return concurrent.status === "provisioning"
        ? activateLease(concurrent, input.ticket, input.authorization)
        : describe(concurrent);
    }
    throw error;
  }
  if (!lease) throw new Error("Workspace preview lease was not created.");
  return lease.status === "provisioning"
    ? activateLease(lease, input.ticket, input.authorization)
    : describe(lease);
}

async function activateLease(
  lease: typeof schema.workspacePreviewLeases.$inferSelect,
  ticket: EnvironmentExecutionTicket,
  authorization: string
) {
  await refreshGateway(ticket, authorization);
  const [active] = await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "active", failureCode: null, updatedAt: new Date() })
    .where(eq(schema.workspacePreviewLeases.id, lease.id))
    .returning();
  return describe(active ?? lease);
}

async function listPreviews(ticket: EnvironmentExecutionTicket) {
  const now = new Date();
  await expireWorkspacePreviews(ticket.workspaceId, now);
  return (
    await knowledgeDb.query.workspacePreviewLeases.findMany({
      where: and(
        eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
        inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"])
      ),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    })
  ).map(describe);
}

async function expireWorkspacePreviews(workspaceId: string, now: Date) {
  await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "expired", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.workspacePreviewLeases.workspaceId, workspaceId),
        inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"]),
        lt(schema.workspacePreviewLeases.expiresAt, now)
      )
    );
}

async function renewPreview(input: {
  previewId: string;
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  body: unknown;
}) {
  const ttlMinutes = parseTtl(input.body, true);
  const now = new Date();
  await expireWorkspacePreviews(input.ticket.workspaceId, now);
  const lease = await requireActiveLease(input.previewId, input.ticket);
  const expiresAt = new Date(
    Math.min(
      now.getTime() + ttlMinutes * 60_000,
      lease.maximumExpiresAt.getTime()
    )
  );
  if (expiresAt <= now) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_MAXIMUM_LIFETIME_REACHED", 409);
  }
  const [updated] = await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ expiresAt, updatedAt: now })
    .where(eq(schema.workspacePreviewLeases.id, lease.id))
    .returning();
  await refreshGateway(input.ticket, input.authorization);
  return describe(updated ?? lease);
}

async function closePreview(input: {
  previewId: string;
  ticket: EnvironmentExecutionTicket;
  authorization: string;
}) {
  const now = new Date();
  await expireWorkspacePreviews(input.ticket.workspaceId, now);
  const lease = await requireClosableLease(input.previewId, input.ticket);
  if (lease.status !== "closing") {
    await knowledgeDb
      .update(schema.workspacePreviewLeases)
      .set({ status: "closing", updatedAt: now })
      .where(eq(schema.workspacePreviewLeases.id, lease.id));
  }
  await refreshGateway(input.ticket, input.authorization);
  await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(eq(schema.workspacePreviewLeases.id, lease.id));
}

async function requireClosableLease(id: string, ticket: EnvironmentExecutionTicket) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: and(
      eq(schema.workspacePreviewLeases.id, id),
      eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
      eq(schema.workspacePreviewLeases.projectId, await requireProjectId(ticket.threadId)),
      inArray(schema.workspacePreviewLeases.status, ["provisioning", "active", "closing"])
    ),
  });
  if (!lease) throw new AppRuntimeError("WORKSPACE_PREVIEW_NOT_FOUND", 404);
  return lease;
}

async function requireActiveLease(id: string, ticket: EnvironmentExecutionTicket) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: and(
      eq(schema.workspacePreviewLeases.id, id),
      eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
      eq(schema.workspacePreviewLeases.projectId, await requireProjectId(ticket.threadId)),
      inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"])
    ),
  });
  if (!lease) throw new AppRuntimeError("WORKSPACE_PREVIEW_NOT_FOUND", 404);
  return lease;
}

async function requireProjectId(threadId: string) {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { eq: equals }) => equals(table.id, threadId),
    columns: { projectId: true },
  });
  if (!thread?.projectId) throw new AppRuntimeError("WORKSPACE_PREVIEW_PROJECT_REQUIRED");
  return thread.projectId;
}

async function assertPortListening(input: {
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  port: number;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) => equals(table.id, input.ticket.environmentId),
    columns: { routerUrl: true },
  });
  if (!environment?.routerUrl) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
  const response = await fetch(
    new URL(`/v1/preview-ports/${input.port}`, environment.routerUrl),
    { headers: { authorization: input.authorization }, cache: "no-store" }
  );
  if (!response.ok) {
    throw new AppRuntimeError(
      response.status === 409
        ? "WORKSPACE_PREVIEW_PORT_NOT_LISTENING"
        : "WORKSPACE_PREVIEW_PORT_CHECK_FAILED",
      response.status === 409 ? 409 : 502
    );
  }
}

async function refreshGateway(
  ticket: EnvironmentExecutionTicket,
  authorization: string
) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) => equals(table.id, ticket.environmentId),
    columns: { routerUrl: true },
  });
  if (!environment?.routerUrl) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
  const response = await fetch(new URL("/internal/config/refresh", environment.routerUrl), {
    method: "POST",
    headers: { authorization },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
}

function parsePublishBody(value: unknown) {
  if (!(isRecord(value) && Number.isSafeInteger(value.port))) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_INPUT_INVALID", 400);
  }
  const port = value.port as number;
  if (port < 1024 || port > 65_535 || RESERVED_PORTS.has(port)) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_PORT_INVALID", 400);
  }
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 80)
      : null;
  return { port, name, ttlMinutes: parseTtl(value, false) };
}

function parseTtl(value: unknown, required: boolean) {
  if (!isRecord(value)) throw new AppRuntimeError("WORKSPACE_PREVIEW_INPUT_INVALID", 400);
  if (value.ttlMinutes === undefined && !required) return DEFAULT_TTL_MINUTES;
  if (
    !Number.isSafeInteger(value.ttlMinutes) ||
    (value.ttlMinutes as number) < 1 ||
    (value.ttlMinutes as number) > MAX_TTL_MINUTES
  ) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_TTL_INVALID", 400);
  }
  return value.ttlMinutes as number;
}

function describe(lease: typeof schema.workspacePreviewLeases.$inferSelect) {
  return {
    id: lease.id,
    name: lease.name,
    port: lease.port,
    protocol: "http" as const,
    url: `https://${lease.hostname}`,
    status: lease.status === "active" ? "available" : lease.status,
    createdAt: lease.createdAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
    maximumExpiresAt: lease.maximumExpiresAt.toISOString(),
    publicAccess: "anonymous_bearer_url" as const,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
