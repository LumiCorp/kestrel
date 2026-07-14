import { and, eq, inArray } from "drizzle-orm";
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
        .select({
          resource: schema.appConnectionResources,
          permissions: schema.appConnectionResources.permissions,
        })
        .from(schema.projectAppConnections)
        .innerJoin(
          schema.appConnections,
          eq(
            schema.appConnections.id,
            schema.projectAppConnections.connectionId
          )
        )
        .innerJoin(
          schema.appConnectionResources,
          eq(
            schema.appConnectionResources.connectionId,
            schema.appConnections.id
          )
        )
        .where(
          and(
            eq(schema.projectAppConnections.projectId, id),
            eq(schema.projectAppConnections.appKey, "github"),
            eq(schema.projectAppConnections.scope, "personal"),
            eq(schema.projectAppConnections.userId, session.user.id),
            eq(schema.appConnections.organizationId, organizationId),
            eq(schema.appConnections.appKey, "github"),
            eq(schema.appConnections.ownerType, "personal"),
            eq(schema.appConnections.userId, session.user.id),
            eq(schema.appConnections.status, "connected"),
            eq(schema.appConnectionResources.resourceType, "repository"),
            eq(schema.appConnectionResources.enabled, true)
          )
        )
        .orderBy(schema.appConnectionResources.label)
        .then((rows) =>
          rows.flatMap((row) => (row.permissions?.pull ? [row.resource] : []))
        ),
      environments.length > 0
        ? knowledgeDb.query.environmentAppCapabilityGrants.findMany({
            where: (table, { and, eq, notInArray }) =>
              and(
                inArray(
                  table.environmentId,
                  environments.map((environment) => environment.id)
                ),
                eq(table.appKey, "github"),
                eq(table.capabilityKey, "repository.read"),
                eq(table.enabled, true),
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
