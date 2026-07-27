import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { authorizeDesktopUser } from "@/lib/desktop-account";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireProjectRole } from "@/lib/projects/access";

const DEFAULT_LEASE_MS = 60 * 60_000;
const MAXIMUM_LEASE_MS = 240 * 60_000;
const MAX_ACTIVE_PREVIEWS = 5;

export const publishDesktopPreviewSchema = z.object({
  projectId: z.string().uuid(),
  connectionId: z.string().uuid(),
  localRunRef: z.string().trim().min(1).max(200),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((port) => ![43104, 43105].includes(port)),
  name: z.string().trim().min(1).max(120).optional(),
});

export async function publishDesktopPreview(request: Request, input: unknown) {
  const { user } = await authorizeDesktopUser(request);
  const body = publishDesktopPreviewSchema.parse(input);
  const project = await knowledgeDb.query.projects.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.id, body.projectId), isNull(table.archivedAt)),
  });
  if (!project) throw new DesktopPreviewError("PROJECT_NOT_FOUND", 404);
  await requireProjectRole({
    projectId: project.id,
    organizationId: project.organizationId,
    userId: user.id,
  });
  const [workspace, connection] = await Promise.all([
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.projectId, project.id),
          eq(table.environmentId, project.environmentId),
          eq(table.sourceType, "desktop"),
          isNull(table.deletedAt),
        ),
    }),
    knowledgeDb.query.desktopEnvironmentConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, body.connectionId),
          eq(table.environmentId, project.environmentId),
          eq(table.organizationId, project.organizationId),
          eq(table.status, "active"),
        ),
    }),
  ]);
  if (!(workspace?.desktopCatalogId && connection)) {
    throw new DesktopPreviewError("DESKTOP_PROJECT_NOT_BOUND", 409);
  }
  const catalog =
    await knowledgeDb.query.desktopEnvironmentWorkspaceCatalog.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, workspace.desktopCatalogId!),
          eq(table.connectionId, connection.id),
          eq(table.availability, "available"),
        ),
    });
  if (!catalog) {
    throw new DesktopPreviewError("DESKTOP_WORKSPACE_UNAVAILABLE", 409);
  }
  const now = new Date();
  const tunnelSecret = randomBytes(32).toString("base64url");
  const { lease, existing } = await knowledgeDb.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:workspace:previews:${workspace.id}`}, 0))`,
      );
      await transaction
        .update(schema.workspacePreviewLeases)
        .set({ status: "expired", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workspacePreviewLeases.workspaceId, workspace.id),
            inArray(schema.workspacePreviewLeases.status, [
              "provisioning",
              "active",
            ]),
            lte(schema.workspacePreviewLeases.expiresAt, now),
          ),
        );
      const existing = await transaction.query.workspacePreviewLeases.findFirst(
        {
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.workspaceId, workspace.id),
              eq(table.port, body.port),
              eq(table.targetProvider, "desktop"),
              inArray(table.status, ["provisioning", "active"]),
            ),
        },
      );
      if (!existing) {
        const [activeCount] = await transaction
          .select({ value: count() })
          .from(schema.workspacePreviewLeases)
          .where(
            and(
              eq(schema.workspacePreviewLeases.workspaceId, workspace.id),
              inArray(schema.workspacePreviewLeases.status, [
                "provisioning",
                "active",
              ]),
            ),
          );
        if (Number(activeCount?.value ?? 0) >= MAX_ACTIVE_PREVIEWS) {
          throw new DesktopPreviewError("PREVIEW_LIMIT_REACHED", 409);
        }
      }
      const expiresAt = new Date(now.getTime() + DEFAULT_LEASE_MS);
      const maximumExpiresAt =
        existing?.maximumExpiresAt ??
        new Date(now.getTime() + MAXIMUM_LEASE_MS);
      const boundedExpiresAt =
        expiresAt > maximumExpiresAt ? maximumExpiresAt : expiresAt;
      const [lease] = existing
        ? await transaction
            .update(schema.workspacePreviewLeases)
            .set({
              desktopTunnelTokenHash: hashSecret(tunnelSecret),
              localRunRef: body.localRunRef,
              name: body.name ?? existing.name,
              status: "active",
              failureCode: null,
              expiresAt: boundedExpiresAt,
              updatedAt: now,
            })
            .where(eq(schema.workspacePreviewLeases.id, existing.id))
            .returning()
        : await transaction
            .insert(schema.workspacePreviewLeases)
            .values({
              id: crypto.randomUUID(),
              organizationId: project.organizationId,
              environmentId: project.environmentId,
              workspaceId: workspace.id,
              projectId: project.id,
              threadId: null,
              runId: null,
              actorId: user.id,
              connectionId: null,
              ingressProvider: "kestrel_edge",
              targetProvider: "desktop",
              desktopConnectionId: connection.id,
              desktopTunnelTokenHash: hashSecret(tunnelSecret),
              localRunRef: body.localRunRef,
              port: body.port,
              name: body.name,
              hostname: `p-${randomBytes(16).toString("hex")}.${previewHostSuffix()}`,
              status: "active",
              expiresAt: boundedExpiresAt,
              maximumExpiresAt,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
      return { lease, existing };
    },
  );
  if (!lease) throw new DesktopPreviewError("PREVIEW_CREATE_FAILED", 500);
  const access = await issueDesktopPreviewAccess({
    lease,
    userId: user.id,
  });
  await knowledgeDb.insert(schema.projectAuditEvents).values({
    id: crypto.randomUUID(),
    projectId: project.id,
    actorUserId: user.id,
    action: existing ? "preview.renewed" : "preview.published",
    targetType: "preview",
    targetId: lease.id,
    createdAt: now,
  });
  return describeDesktopPreview(lease, tunnelSecret, access);
}

export async function renewDesktopPreview(request: Request, previewId: string) {
  const { user } = await authorizeDesktopUser(request);
  const lease = await requireDesktopPreviewAccess(previewId, user.id);
  const now = new Date();
  const expiresAt = new Date(
    Math.min(
      now.getTime() + DEFAULT_LEASE_MS,
      lease.maximumExpiresAt.getTime(),
    ),
  );
  if (expiresAt <= now)
    throw new DesktopPreviewError("PREVIEW_MAXIMUM_REACHED", 409);
  const [updated] = await knowledgeDb
    .update(schema.workspacePreviewLeases)
    .set({ expiresAt, status: "active", updatedAt: now })
    .where(eq(schema.workspacePreviewLeases.id, lease.id))
    .returning();
  if (!updated) throw new DesktopPreviewError("PREVIEW_NOT_FOUND", 404);
  const access = await issueDesktopPreviewAccess({
    lease: updated,
    userId: user.id,
  });
  await knowledgeDb.insert(schema.projectAuditEvents).values({
    id: crypto.randomUUID(),
    projectId: lease.projectId,
    actorUserId: user.id,
    action: "preview.renewed",
    targetType: "preview",
    targetId: lease.id,
    createdAt: now,
  });
  return describeDesktopPreview(updated, null, access);
}

export async function unpublishDesktopPreview(
  request: Request,
  previewId: string,
) {
  const { user } = await authorizeDesktopUser(request);
  const lease = await requireDesktopPreviewAccess(previewId, user.id);
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.workspacePreviewLeases)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(eq(schema.workspacePreviewLeases.id, lease.id));
    await transaction
      .update(schema.workspacePreviewAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.workspacePreviewAccessTokens.leaseId, lease.id),
          isNull(schema.workspacePreviewAccessTokens.revokedAt),
        ),
      );
    await transaction.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: lease.projectId,
      actorUserId: user.id,
      action: "preview.unpublished",
      targetType: "preview",
      targetId: lease.id,
      createdAt: now,
    });
  });
}

export async function authorizeDesktopPreviewTunnel(
  request: Request,
  input: unknown,
) {
  authorizePreviewEdgeService(request.headers.get("authorization"));
  const body = z
    .object({
      previewId: z.string().uuid(),
      tunnelToken: z.string().min(32).max(256),
    })
    .parse(input);
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: (table, { and, eq, gt }) =>
      and(
        eq(table.id, body.previewId),
        eq(table.targetProvider, "desktop"),
        eq(table.status, "active"),
        gt(table.expiresAt, new Date()),
      ),
  });
  if (
    !lease?.desktopTunnelTokenHash ||
    !secretMatches(body.tunnelToken, lease.desktopTunnelTokenHash)
  ) {
    throw new DesktopPreviewError("PREVIEW_TUNNEL_UNAUTHORIZED", 401);
  }
  return { previewId: lease.id, expiresAt: lease.expiresAt.toISOString() };
}

function authorizePreviewEdgeService(authorization: string | null) {
  const expectedValue = process.env.KESTREL_PREVIEW_EDGE_SERVICE_TOKEN?.trim();
  const suppliedValue = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!expectedValue || !suppliedValue) {
    throw new DesktopPreviewError("PREVIEW_TUNNEL_UNAUTHORIZED", 401);
  }
  const supplied = Buffer.from(suppliedValue);
  const expected = Buffer.from(expectedValue);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new DesktopPreviewError("PREVIEW_TUNNEL_UNAUTHORIZED", 401);
  }
}

export async function authorizeDesktopPreviewViewer(input: {
  leaseId: string;
  accessToken: string | null;
}) {
  const token = parseOpaqueToken(input.accessToken);
  if (!token) return false;
  const access = await knowledgeDb.query.workspacePreviewAccessTokens.findFirst(
    {
      where: (table, { and, eq, gt, isNull }) =>
        and(
          eq(table.id, token.id),
          eq(table.leaseId, input.leaseId),
          gt(table.expiresAt, new Date()),
          isNull(table.revokedAt),
        ),
    },
  );
  if (!access || !secretMatches(token.secret, access.secretHash)) return false;
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: (table, { eq }) => eq(table.id, input.leaseId),
    columns: { projectId: true, organizationId: true },
  });
  if (!lease) return false;
  try {
    await requireProjectRole({
      projectId: lease.projectId,
      organizationId: lease.organizationId,
      userId: access.userId,
    });
    return true;
  } catch {
    return false;
  }
}

export async function issueDesktopPreviewAccessForProjectMember(input: {
  previewId: string;
  organizationId: string;
  userId: string;
}) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: (table, { and, eq, gt }) =>
      and(
        eq(table.id, input.previewId),
        eq(table.organizationId, input.organizationId),
        eq(table.targetProvider, "desktop"),
        eq(table.status, "active"),
        gt(table.expiresAt, new Date()),
      ),
  });
  if (!lease) throw new DesktopPreviewError("PREVIEW_NOT_FOUND", 404);
  await requireProjectRole({
    projectId: lease.projectId,
    organizationId: lease.organizationId,
    userId: input.userId,
  });
  const accessToken = await issueDesktopPreviewAccess({
    lease,
    userId: input.userId,
  });
  const publicUrl = new URL(`https://${lease.hostname}/`);
  publicUrl.searchParams.set("kestrel_preview_access", accessToken);
  return {
    id: lease.id,
    publicUrl: publicUrl.toString(),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

async function requireDesktopPreviewAccess(previewId: string, userId: string) {
  const lease = await knowledgeDb.query.workspacePreviewLeases.findFirst({
    where: (table, { and, eq, inArray }) =>
      and(
        eq(table.id, previewId),
        eq(table.targetProvider, "desktop"),
        inArray(table.status, ["provisioning", "active"]),
      ),
  });
  if (!lease) throw new DesktopPreviewError("PREVIEW_NOT_FOUND", 404);
  await requireProjectRole({
    projectId: lease.projectId,
    organizationId: lease.organizationId,
    userId,
  });
  return lease;
}

async function issueDesktopPreviewAccess(input: {
  lease: typeof schema.workspacePreviewLeases.$inferSelect;
  userId: string;
}) {
  const secret = randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  await knowledgeDb.insert(schema.workspacePreviewAccessTokens).values({
    id,
    leaseId: input.lease.id,
    userId: input.userId,
    secretHash: hashSecret(secret),
    expiresAt: input.lease.expiresAt,
  });
  return `${id}.${secret}`;
}

function describeDesktopPreview(
  lease: typeof schema.workspacePreviewLeases.$inferSelect,
  tunnelToken: string | null,
  accessToken: string,
) {
  const publicUrl = new URL(`https://${lease.hostname}/`);
  publicUrl.searchParams.set("kestrel_preview_access", accessToken);
  return {
    id: lease.id,
    publicUrl: publicUrl.toString(),
    tunnelUrl: `${previewEdgeTunnelOrigin()}/internal/desktop-tunnels/${lease.id}`,
    ...(tunnelToken ? { tunnelToken } : {}),
    expiresAt: lease.expiresAt.toISOString(),
    maximumExpiresAt: lease.maximumExpiresAt.toISOString(),
    status: lease.status,
  };
}

function previewHostSuffix() {
  const suffix = process.env.KESTREL_PREVIEW_HOST_SUFFIX?.trim().toLowerCase();
  if (
    !suffix ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(suffix)
  ) {
    throw new DesktopPreviewError("PREVIEW_HOST_NOT_CONFIGURED", 503);
  }
  return suffix;
}

function previewEdgeTunnelOrigin() {
  const raw = process.env.KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN?.trim();
  if (!raw) throw new DesktopPreviewError("PREVIEW_EDGE_NOT_CONFIGURED", 503);
  const url = new URL(raw);
  if (
    (url.protocol !== "wss:" &&
      !(
        url.protocol === "ws:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new DesktopPreviewError("PREVIEW_EDGE_NOT_CONFIGURED", 503);
  }
  return url.origin;
}

function parseOpaqueToken(value: string | null) {
  const match = value?.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,256})$/u);
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : null;
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function secretMatches(value: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DesktopPreviewError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "DesktopPreviewError";
  }
}
