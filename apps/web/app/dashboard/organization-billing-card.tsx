"use client";

import type { Subscription } from "@better-auth/stripe";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CreditCard, Loader2 } from "lucide-react";
import { ChangePlanDialog } from "@/app/dashboard/change-plan";
import { SubscriptionTierLabel } from "@/components/tier-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Organization Billing</CardTitle>
            <CardDescription>
              Manage the active organization&apos;s plan and renewal state.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <CreditCard className="text-muted-foreground" size={16} />
            <SubscriptionTierLabel
              tier={
                (subscription?.plan?.toLowerCase() as
                  | "free"
                  | "plus"
                  | "pro") || "free"
              }
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {activeIsPersonal ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">free</Badge>
              {currentMember?.role ? (
                <Badge variant="outline">Your role: {currentMember.role}</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground text-sm">
              Personal workspaces stay on the free plan. Upgrade and renewal
              controls appear only for shared organizations.
            </p>
          </>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="animate-spin" size={16} />
            Loading org billing status…
          </div>
        ) : error ? (
          <p className="text-destructive text-sm">
            Unable to load the current Stripe subscription for this
            organization.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {subscription?.status ? subscription.status : "free"}
              </Badge>
              {subscription?.cancelAtPeriodEnd ? (
                <Badge variant="secondary">Cancels at period end</Badge>
              ) : null}
              {currentMember?.role ? (
                <Badge variant="outline">Your role: {currentMember.role}</Badge>
              ) : null}
            </div>

            <div className="space-y-1 text-sm">
              <p>
                {subscription
                  ? `${organization?.name || "This organization"} is on the ${
                      subscription.plan
                    } plan.`
                  : `${organization?.name || "This organization"} is currently on the free plan.`}
              </p>
              {subscription?.trialEnd ? (
                <p className="text-muted-foreground">
                  Trial ends {formatDateLabel(subscription.trialEnd)}.
                </p>
              ) : null}
              {subscription?.periodEnd ? (
                <p className="text-muted-foreground">
                  {subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"} on{" "}
                  {formatDateLabel(subscription.periodEnd)}.
                </p>
              ) : null}
              {billingUnavailable ? (
                <p className="text-muted-foreground">
                  Billing is not enabled for this deployment yet. You can view
                  the organization&apos;s current plan here, but checkout and
                  subscription changes are unavailable until Stripe is enabled.
                </p>
              ) : null}
              {canManageBilling ? null : (
                <p className="text-muted-foreground">
                  Only organization owners and admins can change the org plan.
                </p>
              )}
            </div>

            {showManagementActions ? (
              billingUnavailable ? (
                <div className="flex flex-wrap gap-2">
                  <Button disabled size="sm">
                    {subscription ? "Change Plan" : "Upgrade Plan"}
                  </Button>
                  <Button disabled size="sm" variant="outline">
                    Billing Portal Unavailable
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <ChangePlanDialog
                    currentPlan={subscription?.plan?.toLowerCase()}
                    customerType="organization"
                    isTrial={subscription?.status === "trialing"}
                    referenceId={organization?.id}
                    returnUrl="/dashboard/billing"
                  />
                </div>
              )
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
