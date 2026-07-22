import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { auth } from "@/lib/auth";
import type { ActiveOrganization, Session } from "@/lib/auth-types";
import { dbClient } from "@/lib/db-client";
import { ensurePersonalOrganization } from "@/lib/personal-workspace";
import { OrganizationCard } from "@/app/dashboard/organization-card";

function parseOrganizationMetadata(metadata: string | null) {
  if (!metadata) {
    return null;
  }

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default async function OrganizationsPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect("/sign-in");
  }

  // Get active organization if session has one
  let activeOrganization: ActiveOrganization | null = null;
  let activeOrgId = (
    session.session as { activeOrganizationId?: string | null }
  )?.activeOrganizationId;

  if (!activeOrgId) {
    const personalOrganization = await ensurePersonalOrganization(session.user);
    activeOrgId = personalOrganization.id;
  }
  if (activeOrgId) {
    const orgData = await dbClient
        .selectFrom("organization")
        .selectAll()
        .where("id", "=", activeOrgId)
        .executeTakeFirst();

    if (orgData) {
      // Get members
      const members = await dbClient
        .selectFrom("member")
        .innerJoin("user", "user.id", "member.userId")
        .select([
          "member.id",
          "member.organizationId",
          "member.role",
          "member.userId",
          "member.createdAt",
          "user.id as user_id",
          "user.name as user_name",
          "user.email as user_email",
          "user.image as user_image",
        ])
        .where("member.organizationId", "=", orgData.id)
        .execute();

      // Get invitations
      const invitations = await dbClient
        .selectFrom("invitation")
        .selectAll()
        .where("organizationId", "=", orgData.id)
        .where("status", "=", "pending")
        .execute();

      activeOrganization = {
        id: orgData.id,
        name: orgData.name,
        slug: orgData.slug,
        createdAt: orgData.createdAt.toISOString(),
        logo: orgData.logo ?? null,
        metadata: parseOrganizationMetadata(orgData.metadata ?? null),
        members: members.map((m) => ({
          id: m.id,
          organizationId: m.organizationId,
          role: m.role as "admin" | "member" | "owner",
          userId: m.userId,
          createdAt: m.createdAt.toISOString(),
          user: {
            id: m.user_id,
            name: m.user_name || "",
            email: m.user_email,
            image: m.user_image || undefined,
          },
        })),
        invitations: invitations.map((inv) => ({
          id: inv.id,
          email: inv.email,
          role: (inv.role || "member") as "admin" | "member",
          status: inv.status,
          expiresAt: inv.expiresAt.toISOString(),
          createdAt: inv.createdAt.toISOString(),
          organizationId: inv.organizationId,
          inviterId: inv.inviterId,
        })),
      } as unknown as ActiveOrganization;
    }
  }

  return (
    <AppPage>
      <AdminPageHeader
        description="Manage the active organization, membership, and invitations from the shared workspace shell."
        eyebrow="Workspace"
        title="Organizations"
      />

      <OrganizationCard
        activeOrganization={activeOrganization}
        session={session as Session}
      />
    </AppPage>
  );
}
