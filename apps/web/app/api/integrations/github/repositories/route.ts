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
        resource: schema.toolConnectionResources,
        canPull: schema.userToolConnectionResources.canPull,
        canPush: schema.userToolConnectionResources.canPush,
        canAdmin: schema.userToolConnectionResources.canAdmin,
      })
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
          eq(schema.toolConnectionResources.organizationId, organizationId),
          eq(schema.toolConnectionResources.providerKey, "github"),
          eq(schema.toolConnectionResources.resourceType, "repository"),
          eq(schema.toolConnectionResources.enabled, true)
        )
      );
    const repositories = rows;
    return NextResponse.json({ repositories });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
