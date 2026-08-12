import { randomBytes } from "node:crypto";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { refreshEnvironmentGateway } from "@/lib/environments/gateway-refresh";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { authorizeAppRuntime } from "./runtime";
import { AppRuntimeError } from "./runtime";

const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 240;
const MAX_ACTIVE_PREVIEWS = 5;
const RESERVED_PORTS = new Set([43_104, 43_105]);

type AuthorizedPolicy = Awaited<ReturnType<typeof authorizeAppRuntime>>;

export async function handlePreviewLifecycle(input: {
  request: Request;
  path: string[];
  capability: string;
  authorization: string;
  ticket: EnvironmentExecutionTicket;
  policy: AuthorizedPolicy;
}) {
  switch (input.capability) {
    case "publish":
      return NextResponse.json(
        {
          preview: await publishPreview({
            ...input,
            hostSuffix: edgePreviewHostSuffix(),
            body: await input.request.json().catch(() => null),
          }),
        },
        { status: 201 },
      );
    case "list":
      return NextResponse.json({
        previews: await listPreviews(input.ticket, input.authorization),
      });
    case "inspect":
      return NextResponse.json(
        await inspectPreviewPort({
          ticket: input.ticket,
          authorization: input.authorization,
          port: parsePreviewPort(input.path[1]),
        }),
      );
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
      });
      return NextResponse.json({ ok: true });
    default:
      throw new AppRuntimeError("WORKSPACE_PREVIEW_CAPABILITY_DENIED", 404);
  }
}

async function publishPreview(input: {
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  hostSuffix: string;
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
      maximumExpiresAt.getTime(),
    ),
  );
  const hostname = `p-${randomBytes(16).toString("hex")}.${input.hostSuffix}`;
  const projectId = await requireProjectId(input.ticket.threadId);
  let lease: typeof schema.workspacePreviewLeases.$inferSelect | undefined;
  try {
    lease = await knowledgeDb.transaction(async (transaction) => {
      const lockKey = `kestrel:workspace:previews:${input.ticket.workspaceId}`;
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      await transaction
        .update(schema.workspacePreviewLeases)
        .set({ status: "expired", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(
              schema.workspacePreviewLeases.workspaceId,
              input.ticket.workspaceId,
            ),
            inArray(schema.workspacePreviewLeases.status, [
              "provisioning",
              "active",
            ]),
            lt(schema.workspacePreviewLeases.expiresAt, now),
          ),
        );
      const existing = await transaction.query.workspacePreviewLeases.findFirst(
        {
        where: and(
            eq(
              schema.workspacePreviewLeases.workspaceId,
              input.ticket.workspaceId,
            ),
          eq(schema.workspacePreviewLeases.port, body.port),
            inArray(schema.workspacePreviewLeases.status, [
              "provisioning",
              "active",
              "closing",
            ]),
        ),
        },
      );
      if (existing) return existing;
      const [{ value: activeCount }] = await transaction
        .select({ value: count() })
        .from(schema.workspacePreviewLeases)
        .where(
          and(
            eq(
              schema.workspacePreviewLeases.workspaceId,
              input.ticket.workspaceId,
            ),
            inArray(schema.workspacePreviewLeases.status, [
              "provisioning",
              "active",
              "closing",
            ]),
          ),
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
    const concurrent = await knowledgeDb.query.workspacePreviewLeases.findFirst(
      {
      where: and(
          eq(
            schema.workspacePreviewLeases.workspaceId,
            input.ticket.workspaceId,
          ),
        eq(schema.workspacePreviewLeases.port, body.port),
          inArray(schema.workspacePreviewLeases.status, [
            "provisioning",
            "active",
            "closing",
          ]),
      ),
      },
    );
    if (concurrent) {
      return concurrent.status === "provisioning"
        ? activateLease(concurrent, input.ticket)
        : describe(concurrent, "listening");
    }
    throw error;
  }
  if (!lease) throw new Error("Workspace preview lease was not created.");
  return lease.status === "provisioning"
    ? activateLease(lease, input.ticket)
    : describe(lease, "listening");
}

async function activateLease(
  lease: typeof schema.workspacePreviewLeases.$inferSelect,
  ticket: EnvironmentExecutionTicket,
) {
  try {
    await refreshGateway(ticket);
  } catch (error) {
    const now = new Date();
    await knowledgeDb
      .update(schema.workspacePreviewLeases)
      .set({
        status: "failed",
        failureCode: "WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE",
        closedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspacePreviewLeases.id, lease.id),
          eq(schema.workspacePreviewLeases.status, "provisioning"),
        ),
      );
    throw error;
  }
  const [active] = await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "active", failureCode: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.workspacePreviewLeases.id, lease.id),
        eq(schema.workspacePreviewLeases.status, "provisioning"),
      ),
    )
    .returning();
  if (!active) {
    const concurrent = await knowledgeDb.query.workspacePreviewLeases.findFirst(
      {
      where: eq(schema.workspacePreviewLeases.id, lease.id),
      },
    );
    if (concurrent?.status === "active") {
      return describe(concurrent, "listening");
    }
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
  return describe(active, "listening");
}

async function listPreviews(
  ticket: EnvironmentExecutionTicket,
  authorization: string,
) {
  const now = new Date();
  await expireWorkspacePreviews(ticket.workspaceId, now);
  const leases = await knowledgeDb.query.workspacePreviewLeases.findMany({
      where: and(
        eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
      inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"]),
      ),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  return Promise.all(
    leases.map(async (lease, index) => {
      if (lease.status !== "active" || index >= MAX_ACTIVE_PREVIEWS) {
        return describe(lease, "unknown");
      }
      try {
        const inspection = await inspectPreviewPort({
          ticket,
          authorization,
          port: lease.port,
        });
        return describe(lease, inspection.status);
      } catch {
        return describe(lease, "unknown");
      }
    }),
  );
}

async function expireWorkspacePreviews(workspaceId: string, now: Date) {
  await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "expired", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.workspacePreviewLeases.workspaceId, workspaceId),
        inArray(schema.workspacePreviewLeases.status, [
          "provisioning",
          "active",
        ]),
        lt(schema.workspacePreviewLeases.expiresAt, now),
      ),
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
  await assertPortListening({
    ticket: input.ticket,
    authorization: input.authorization,
    port: lease.port,
  });
  const expiresAt = new Date(
    Math.min(
      now.getTime() + ttlMinutes * 60_000,
      lease.maximumExpiresAt.getTime(),
    ),
  );
  if (expiresAt <= now) {
    throw new AppRuntimeError(
      "WORKSPACE_PREVIEW_MAXIMUM_LIFETIME_REACHED",
      409,
    );
  }
  const [updated] = await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ expiresAt, updatedAt: now })
    .where(eq(schema.workspacePreviewLeases.id, lease.id))
    .returning();
  await refreshGateway(input.ticket);
  return describe(updated ?? lease, "listening");
}

async function closePreview(input: {
  previewId: string;
  ticket: EnvironmentExecutionTicket;
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
  await refreshGateway(input.ticket);
  await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(eq(schema.workspacePreviewLeases.id, lease.id));
}

async function requireClosableLease(
  id: string,
  ticket: EnvironmentExecutionTicket,
) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: and(
      eq(schema.workspacePreviewLeases.id, id),
      eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
      eq(
        schema.workspacePreviewLeases.projectId,
        await requireProjectId(ticket.threadId),
      ),
      inArray(schema.workspacePreviewLeases.status, [
        "provisioning",
        "active",
        "closing",
      ]),
    ),
  });
  if (!lease) throw new AppRuntimeError("WORKSPACE_PREVIEW_NOT_FOUND", 404);
  return lease;
}

async function requireActiveLease(
  id: string,
  ticket: EnvironmentExecutionTicket,
) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: and(
      eq(schema.workspacePreviewLeases.id, id),
      eq(schema.workspacePreviewLeases.workspaceId, ticket.workspaceId),
      eq(
        schema.workspacePreviewLeases.projectId,
        await requireProjectId(ticket.threadId),
      ),
      inArray(schema.workspacePreviewLeases.status, ["provisioning", "active"]),
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
  if (!thread?.projectId)
    throw new AppRuntimeError("WORKSPACE_PREVIEW_PROJECT_REQUIRED");
  return thread.projectId;
}

async function assertPortListening(input: {
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  port: number;
}) {
  const inspection = await inspectPreviewPort(input);
  if (inspection.status === "not_listening") {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_PORT_NOT_LISTENING", 409);
  }
}

async function inspectPreviewPort(input: {
  ticket: EnvironmentExecutionTicket;
  authorization: string;
  port: number;
}): Promise<{ port: number; status: "listening" | "not_listening" }> {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.id, input.ticket.environmentId),
    columns: { routerUrl: true },
  });
  if (!environment?.routerUrl) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
  const response = await fetch(
    new URL(`/v1/preview-ports/${input.port}`, environment.routerUrl),
    { headers: { authorization: input.authorization }, cache: "no-store" },
  );
  if (!response.ok) {
    if (response.status === 409) {
      return { port: input.port, status: "not_listening" };
    }
    throw new AppRuntimeError("WORKSPACE_PREVIEW_PORT_CHECK_FAILED", 502);
  }
  return { port: input.port, status: "listening" };
}

function parsePreviewPort(value: string | undefined) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_PORT_INVALID", 400);
  }
  return port;
}

async function refreshGateway(ticket: EnvironmentExecutionTicket) {
  try {
    await refreshEnvironmentGateway({
      organizationId: ticket.organizationId,
      environmentId: ticket.environmentId,
    });
  } catch {
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
  if (!isRecord(value))
    throw new AppRuntimeError("WORKSPACE_PREVIEW_INPUT_INVALID", 400);
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

function describe(
  lease: typeof schema.workspacePreviewLeases.$inferSelect,
  applicationStatus: "listening" | "not_listening" | "unknown",
) {
  const leaseStatus = lease.status;
  const status = summarizePreviewStatus(lease.status, applicationStatus);
  return {
    id: lease.id,
    name: lease.name,
    port: lease.port,
    protocol: "http" as const,
    url: `https://${lease.hostname}`,
    leaseStatus,
    applicationStatus,
    status,
    createdAt: lease.createdAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
    maximumExpiresAt: lease.maximumExpiresAt.toISOString(),
    publicAccess: "anonymous_bearer_url" as const,
  };
}

export function summarizePreviewStatus(
  leaseStatus: string,
  applicationStatus: "listening" | "not_listening" | "unknown",
) {
  return leaseStatus === "provisioning"
    ? ("provisioning" as const)
    : applicationStatus === "listening"
      ? ("available" as const)
      : applicationStatus === "not_listening"
        ? ("unavailable" as const)
        : ("unknown" as const);
}

function edgePreviewHostSuffix() {
  const suffix =
    process.env.KESTREL_PREVIEW_HOST_SUFFIX?.trim() ||
    "preview.kestrelagents.dev";
  if (
    suffix.startsWith("*.") ||
    suffix.length > 240 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(suffix)
  ) {
    throw new AppRuntimeError("WORKSPACE_PREVIEW_GATEWAY_UNAVAILABLE", 503);
  }
  return suffix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
