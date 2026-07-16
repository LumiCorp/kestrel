import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { mobileErrorResponse } from "@/lib/mobile/http";

export async function GET() {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const organizations = await knowledgeDb
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        logo: schema.organizations.logo,
      })
      .from(schema.members)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.members.organizationId)
      )
      .where(eq(schema.members.userId, session.user.id));
    return NextResponse.json({
      apiVersion: "2",
      minimumSupportedAppVersion: "1.0.0",
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      },
      activeOrganizationId: organizationId,
      organizations,
      capabilities: {
        projects: "read_only",
        threadCreation: true,
        durableTurns: true,
        turnQueue: true,
        queueReordering: true,
        threadBranching: true,
        paginatedMessages: true,
        serverReadState: true,
        interactiveCheckpoints: true,
        pushNotifications: true,
        uploads: false,
        administration: false,
        billing: false,
      },
    });
  } catch (error) {
    return mobileErrorResponse(error);
  }
}
