import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import * as schema from "@/drizzle/schema";
import { requireHostedEnvironmentsEnabled } from "@/lib/environments/config";
import { workspaceSourceSchema } from "@/lib/environments/contracts";
import {
  createOrConfigureStandaloneThreadWorkspace,
  listOrganizationEnvironments,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getThreadAccessForUser } from "@/lib/threads/store";

const paramsSchema = z.object({ id: routeIdSchema });
const inputSchema = z.object({
  environmentId: z.string().uuid(),
  source: workspaceSourceSchema,
});

async function requireStandaloneThreadOwner(context: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId, session } = await requireActiveOrganization();
  await requireHostedEnvironmentsEnabled({ organizationId });
  const { id } = paramsSchema.parse(await context.params);
  const access = await getThreadAccessForUser(
    id,
    session.user.id,
    organizationId
  );
  if (
    !access ||
    access.thread.projectId !== null ||
    access.thread.createdByUserId !== session.user.id
  ) {
    return null;
  }
  return { organizationId, session, threadId: id };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireStandaloneThreadOwner(context);
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const environments = await listOrganizationEnvironments(
      access.organizationId
    );
    const [binding, workspace, repositories, grants] = await Promise.all([
      knowledgeDb.query.threadExecutionBindings.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.threadId, access.threadId),
            eq(table.organizationId, access.organizationId)
          ),
      }),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, access.organizationId),
            eq(table.standaloneThreadId, access.threadId),
            isNull(table.deletedAt)
          ),
      }),
      knowledgeDb
        .select({ resource: schema.toolConnectionResources })
        .from(schema.userToolConnections)
        .innerJoin(
          schema.userToolConnectionResources,
          eq(
            schema.userToolConnectionResources.connectionId,
            schema.userToolConnections.id
          )
        )
        .innerJoin(
          schema.toolConnectionResources,
          eq(
            schema.toolConnectionResources.id,
            schema.userToolConnectionResources.resourceId
          )
        )
        .where(
          and(
            eq(
              schema.userToolConnections.organizationId,
              access.organizationId
            ),
            eq(schema.userToolConnections.providerKey, "github"),
            eq(schema.userToolConnections.userId, access.session.user.id),
            eq(schema.userToolConnections.status, "connected"),
            eq(schema.userToolConnectionResources.canPull, true),
            eq(
              schema.toolConnectionResources.organizationId,
              access.organizationId
            ),
            eq(schema.toolConnectionResources.providerKey, "github"),
            eq(schema.toolConnectionResources.resourceType, "repository"),
            eq(schema.toolConnectionResources.enabled, true)
          )
        )
        .orderBy(schema.toolConnectionResources.label)
        .then((rows) => rows.map((row) => row.resource)),
      environments.length > 0
        ? knowledgeDb.query.environmentCapabilityGrants.findMany({
            where: (table, { and, eq, inArray, notInArray }) =>
              and(
                inArray(
                  table.environmentId,
                  environments.map((environment) => environment.id)
                ),
                eq(table.providerKey, "github"),
                eq(table.capabilityKey, "repository.read"),
                notInArray(table.approvalMode, ["deny"])
              ),
          })
        : Promise.resolve([]),
    ]);
    return NextResponse.json({
      binding,
      environments,
      workspace,
      repositories,
      grants,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireStandaloneThreadOwner(context);
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const input = inputSchema.parse(await request.json());
    const result = await createOrConfigureStandaloneThreadWorkspace({
      organizationId: access.organizationId,
      environmentId: input.environmentId,
      threadId: access.threadId,
      userId: access.session.user.id,
      source: input.source,
    });
    if (result.operation.status === "queued") {
      await enqueueEnvironmentOperation(result.operation.id);
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
