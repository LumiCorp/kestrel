import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import * as schema from "@/drizzle/schema";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const rows = await knowledgeDb
      .select({
        resource: schema.appConnectionResources,
        permissions: schema.appConnectionResources.permissions,
      })
      .from(schema.appConnections)
      .innerJoin(
        schema.appConnectionResources,
        eq(schema.appConnectionResources.connectionId, schema.appConnections.id)
      )
      .where(
        and(
          eq(schema.appConnections.organizationId, organizationId),
          eq(schema.appConnections.appKey, "github"),
          eq(schema.appConnections.ownerType, "personal"),
          eq(schema.appConnections.userId, session.user.id),
          eq(schema.appConnections.status, "connected"),
          eq(schema.appConnectionResources.resourceType, "repository"),
          eq(schema.appConnectionResources.enabled, true)
        )
      );
    const repositories = rows.map(({ resource, permissions }) => ({
      resource,
      canPull: permissions?.pull ?? false,
      canPush: permissions?.push ?? false,
      canAdmin: permissions?.admin ?? false,
    }));
    return NextResponse.json({ repositories });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
