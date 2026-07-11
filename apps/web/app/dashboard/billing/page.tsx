import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import type { ActiveOrganization } from "@/lib/auth-types";
import {
  getCurrentSubscriptionByReference,
  normalizeSubscriptionForClient,
} from "@/lib/billing/subscriptions";
import { dbClient } from "@/lib/db-client";
import { ensurePersonalOrganization } from "@/lib/personal-workspace";
import { OrganizationBillingCard } from "../organization-billing-card";

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

export default async function BillingPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect("/sign-in");
  }

  let activeOrganization: ActiveOrganization | null = null;
  let initialSubscription = null;
  let activeOrgId = (
    session.session as { activeOrganizationId?: string | null }
  )?.activeOrganizationId;

  if (!activeOrgId) {
    const personalOrganization = await ensurePersonalOrganization(session.user);
    activeOrgId = personalOrganization.id;
  }

  if (activeOrgId) {
    const [orgData, currentSubscription] = await Promise.all([
      dbClient
        .selectFrom("organization")
        .selectAll()
        .where("id", "=", activeOrgId)
        .executeTakeFirst(),
      getCurrentSubscriptionByReference(activeOrgId),
    ]);

    initialSubscription = normalizeSubscriptionForClient(currentSubscription);

    if (orgData) {
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

      activeOrganization = {
        id: orgData.id,
        name: orgData.name,
        slug: orgData.slug,
        createdAt: orgData.createdAt.toISOString(),
        logo: orgData.logo ?? null,
        metadata: parseOrganizationMetadata(orgData.metadata ?? null),
        members: members.map((member) => ({
          id: member.id,
          organizationId: member.organizationId,
          role: member.role as "admin" | "member" | "owner",
          userId: member.userId,
          createdAt: member.createdAt.toISOString(),
          user: {
            id: member.user_id,
            name: member.user_name || "",
            email: member.user_email,
            image: member.user_image || undefined,
          },
        })),
      } as ActiveOrganization;
    }
  }

  return (
    <AppPage>
      <AdminPageHeader
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/organizations">Manage Organization</Link>
          </Button>
        }
        description="Manage the active organization’s subscription, renewal state, and plan changes."
        eyebrow="Account"
        title="Billing"
      />

      <OrganizationBillingCard
        activeOrganization={activeOrganization}
        initialSubscription={initialSubscription}
        sessionUserId={session.user.id}
      />
    </AppPage>
  );
}
