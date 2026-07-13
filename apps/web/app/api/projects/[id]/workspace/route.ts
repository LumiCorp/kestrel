import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import * as schema from "@/drizzle/schema";
import { workspaceSourceSchema } from "@/lib/environments/contracts";
import {
  createOrConfigureProjectWorkspace,
  getProjectEnvironmentBinding,
  listOrganizationEnvironments,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { requireProjectRole } from "@/lib/projects/access";

const inputSchema = z.object({
  environmentId: z.string().uuid(),
  source: workspaceSourceSchema,
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    const binding = await getProjectEnvironmentBinding({
      organizationId,
      projectId: id,
    });
    const environments = await listOrganizationEnvironments(organizationId);
    const [workspace, repositories, grants] = await Promise.all([
      binding
        ? knowledgeDb.query.environmentWorkspaces.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.environmentId, binding.environmentId),
                eq(table.projectId, id),
                isNull(table.deletedAt)
              ),
          })
        : Promise.resolve(null),
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
            eq(schema.userToolConnections.organizationId, organizationId),
            eq(schema.userToolConnections.providerKey, "github"),
            eq(schema.userToolConnections.userId, session.user.id),
            eq(schema.userToolConnections.status, "connected"),
            eq(schema.userToolConnectionResources.canPull, true),
            eq(schema.toolConnectionResources.organizationId, organizationId),
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
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const body = inputSchema.parse(await request.json());
    const result = await createOrConfigureProjectWorkspace({
      organizationId,
      projectId: id,
      environmentId: body.environmentId,
      userId: session.user.id,
      source: body.source,
    });
    if (result.operation?.status === "queued") {
      await enqueueEnvironmentOperation(result.operation.id);
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
