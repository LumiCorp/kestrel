"use client";

import type { Subscription } from "@better-auth/stripe";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { ChangePlanDialog } from "@/app/dashboard/change-plan";
import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { SubscriptionTierLabel } from "@/components/tier-labels";
import { billingEnabled, client } from "@/lib/auth-client";
import type { ActiveOrganization } from "@/lib/auth-types";
import { canManageOrganizationBillingRole } from "@/lib/billing/access-shared";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

function formatDateLabel(value?: string | Date | null) {
  if (!value) {
    return null;
  }

  return format(new Date(value), "MMM d, yyyy");
}

export function OrganizationBillingCard(props: {
  activeOrganization: ActiveOrganization | null;
  initialSubscription?: Subscription | null;
  sessionUserId: string;
}) {
  const organization = props.activeOrganization;
  const activeIsPersonal = isPersonalOrganization(organization);
  const currentMember = organization?.members?.find(
    (member) => member.userId === props.sessionUserId
  );
  const canManageBilling = canManageOrganizationBillingRole({
    isPersonalOrganization: activeIsPersonal,
    role: currentMember?.role,
  });
  const billingUnavailable = !billingEnabled;
  const showManagementActions = !activeIsPersonal && canManageBilling;

  const {
    data: subscription,
    error,
    isLoading,
  } = useQuery<Subscription | null>({
    enabled: billingEnabled && !activeIsPersonal && Boolean(organization?.id),
    initialData: props.initialSubscription ?? null,
    queryKey: ["organization-subscription", organization?.id],
    queryFn: async () => {
      if (!organization?.id) {
        return null;
      }

      const subscriptions = await client.subscription.list({
        customerType: "organization",
        fetchOptions: {
          throw: true,
        },
        referenceId: organization.id,
      });

      return subscriptions[0] ?? null;
    },
  });

  const nextEvent = subscription?.periodEnd
    ? `${subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} ${formatDateLabel(subscription.periodEnd)}`
    : subscription?.trialEnd
      ? `Trial ends ${formatDateLabel(subscription.trialEnd)}`
      : "None scheduled";

  return (
    <SettingsSection
      actions={
        showManagementActions && !billingUnavailable && !isLoading && !error ? (
          <ChangePlanDialog
            currentPlan={subscription?.plan?.toLowerCase()}
            customerType="organization"
            isTrial={subscription?.status === "trialing"}
            referenceId={organization?.id}
            returnUrl="/organization/billing"
          />
        ) : null
      }
      description="Current plan, subscription state, and the next billing event."
      title="Subscription"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 border-y py-4 text-muted-foreground text-sm">
          <Loader2 className="animate-spin" size={16} />
          Loading billing status…
        </div>
      ) : error ? (
        <SettingsStatusNotice
          description="The current subscription could not be loaded. No billing changes were made."
          title="Billing status unavailable"
          tone="error"
        />
      ) : (
        <div className="space-y-5">
          <SettingsRows>
            <SettingsRow label="Plan">
              <div className="flex justify-start">
                <SubscriptionTierLabel
                  tier={
                    (subscription?.plan?.toLowerCase() as
                      | "free"
                      | "plus"
                      | "pro") || "free"
                  }
                />
              </div>
            </SettingsRow>
            <SettingsRow label="Status">
              <SettingsStatusSummary
                status={subscription?.status || "Free"}
                tone={subscription?.status === "active" ? "positive" : "neutral"}
              />
            </SettingsRow>
            <SettingsRow label="Next event">
              <span className="text-sm">{nextEvent}</span>
            </SettingsRow>
            <SettingsRow label="Your role">
              <span className="text-sm capitalize">
                {currentMember?.role || "owner"}
              </span>
            </SettingsRow>
          </SettingsRows>

          {activeIsPersonal ? (
            <SettingsStatusNotice
              description="Upgrade and renewal controls appear only for shared organizations."
              title="Personal workspaces stay on the free plan"
            />
          ) : billingUnavailable ? (
            <SettingsStatusNotice
              description="The current plan remains visible, but checkout and subscription changes are unavailable until Stripe is enabled."
              title="Billing changes are unavailable"
            />
          ) : canManageBilling ? null : (
            <SettingsStatusNotice
              description="Only organization owners and admins can change the plan."
              title="View-only billing access"
            />
          )}
        </div>
      )}
    </SettingsSection>
  );
}
