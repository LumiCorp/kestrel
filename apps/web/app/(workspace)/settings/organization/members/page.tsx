import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-section";
import type { ActiveOrganization, Session } from "@/lib/auth-types";
import { dbClient } from "@/lib/db-client";
import { resolveEmailConfig } from "@/lib/email/config";
import { invitationOrigin } from "@/lib/invitation-origin";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { OrganizationCard } from "@/components/settings/members-client";

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
  const { session, organizationId } = await requireOrganizationAdmin();
  let invitationOriginValue: string | null = null;
  let invitationSetupIssue: string | null = null;
  const addInvitationSetupIssue = (message: string) => {
    invitationSetupIssue = invitationSetupIssue
      ? `${invitationSetupIssue} ${message}`
      : message;
  };
  try {
    invitationOriginValue = invitationOrigin();
  } catch (error) {
    addInvitationSetupIssue(
      error instanceof Error
        ? error.message
        : "Invitation links are not configured.",
    );
  }
  try {
    const emailConfig = await resolveEmailConfig();
    const invitationDeliveryReady =
      emailConfig.enabled &&
      Boolean(emailConfig.apiKey && emailConfig.fromEmail) &&
      (!emailConfig.persisted || emailConfig.status === "ready");
    if (!invitationDeliveryReady) {
      addInvitationSetupIssue(
        `Email delivery is ${emailConfig.status.replaceAll("_", " ")}. Invitations may remain pending until you configure and test delivery.`,
      );
    }
  } catch {
    addInvitationSetupIssue(
      "Email delivery configuration could not be read. Invitations may remain pending until it is repaired.",
    );
  }
  let activeOrganization: ActiveOrganization | null = null;
  if (organizationId) {
    const orgData = await dbClient
      .selectFrom("organization")
      .selectAll()
      .where("id", "=", organizationId)
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

      // Owners and admins can review the complete invitation lifecycle.
      const invitations = await dbClient
        .selectFrom("invitation")
        .selectAll()
        .where("organizationId", "=", orgData.id)
        .orderBy("createdAt", "desc")
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
    <SettingsPage>
      <SettingsPageHeader
        description="Manage the active organization, membership, and invitations from the shared workspace shell."
        eyebrow="Workspace"
        title="Members"
      />

      <OrganizationCard
        activeOrganization={activeOrganization}
        invitationOrigin={invitationOriginValue}
        invitationSetupIssue={invitationSetupIssue}
        session={session as Session}
      />
    </SettingsPage>
  );
}
