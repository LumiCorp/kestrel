import { getStripeBillingConfigStatus } from "@/lib/billing/config";
import { getCurrentSubscriptionByReference } from "@/lib/billing/subscriptions";
import { dbClient } from "@/lib/db-client";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

export async function getAdminBillingDiagnostics(organizationId: string) {
  const [organization, subscription] = await Promise.all([
    dbClient
      .selectFrom("organization")
      .select(["id", "name", "slug", "stripeCustomerId"])
      .where("id", "=", organizationId)
      .executeTakeFirst(),
    getCurrentSubscriptionByReference(organizationId),
  ]);

  const config = getStripeBillingConfigStatus();
  const isPersonalWorkspace = isPersonalOrganization(organization);
  const hasCustomerMismatch =
    Boolean(
      organization?.stripeCustomerId &&
        subscription?.stripeCustomerId &&
        organization.stripeCustomerId !== subscription.stripeCustomerId
    ) && !isPersonalWorkspace;

  return {
    config,
    organization: organization
      ? {
          ...organization,
          isPersonalWorkspace,
        }
      : null,
    subscription,
    syncState: hasCustomerMismatch
      ? "mismatch"
      : config.billingEnabled
        ? config.isReady
          ? organization?.stripeCustomerId || subscription
            ? organization?.stripeCustomerId && !subscription
              ? "customer-only"
              : subscription
                ? "healthy"
                : "inactive"
            : "awaiting-checkout"
          : "misconfigured"
        : "disabled",
  };
}
