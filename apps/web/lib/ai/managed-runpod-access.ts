import "server-only";

import { and, eq } from "drizzle-orm";
import { isAdminUser, requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const ORGANIZATION_ADMIN_ROLES = new Set(["owner", "admin"]);

export async function getManagedRunPodActor(
  activeOrganization?: Awaited<ReturnType<typeof requireActiveOrganization>>
) {
  const active = activeOrganization ?? (await requireActiveOrganization());
  const member = await knowledgeDb.query.members.findFirst({
    where: and(
      eq(schema.members.organizationId, active.organizationId),
      eq(schema.members.userId, active.session.user.id)
    ),
    columns: { role: true },
  });
  return {
    organizationId: active.organizationId,
    userId: active.session.user.id,
    isPlatformAdmin: isAdminUser(active.session.user),
    isOrganizationAdmin: ORGANIZATION_ADMIN_ROLES.has(member?.role ?? ""),
  };
}

export async function assertManagedRunPodLaunchAccess(input: {
  organizationId: string;
  userId: string;
  isOrganizationAdmin: boolean;
  isPlatformAdmin: boolean;
}) {
  if (input.isPlatformAdmin || input.isOrganizationAdmin) {
    return;
  }
  const entitlement =
    await knowledgeDb.query.organizationAiDeploymentEntitlements.findFirst({
      where: and(
        eq(
          schema.organizationAiDeploymentEntitlements.organizationId,
          input.organizationId
        ),
        eq(schema.organizationAiDeploymentEntitlements.userId, input.userId)
      ),
      columns: { userId: true },
    });
  if (!entitlement) {
    throw new Error("Managed RunPod deployment entitlement is required.");
  }
}

export function assertManagedRunPodDeleteAccess(input: {
  creatorUserId: string;
  actorUserId: string;
  isOrganizationAdmin: boolean;
  isPlatformAdmin: boolean;
}) {
  if (
    input.creatorUserId !== input.actorUserId &&
    !input.isOrganizationAdmin &&
    !input.isPlatformAdmin
  ) {
    throw new Error(
      "Only the deployment creator or an organization admin may delete it."
    );
  }
}
