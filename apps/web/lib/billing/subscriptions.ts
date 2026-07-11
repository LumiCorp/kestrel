import type { Subscription as StripeSubscription } from "@better-auth/stripe";
import type { Subscription } from "@/drizzle/schema";
import { dbClient } from "@/lib/db-client";

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

function getSubscriptionSortTimestamp(subscription: Subscription) {
  return (
    subscription.updatedAt?.getTime() ||
    subscription.createdAt?.getTime() ||
    subscription.periodEnd?.getTime() ||
    0
  );
}

function pickCurrentSubscription(subscriptions: Subscription[]) {
  if (subscriptions.length === 0) {
    return null;
  }

  return subscriptions.slice().sort((left, right) => {
    const activeDiff =
      Number(ACTIVE_STATUSES.has(right.status)) -
      Number(ACTIVE_STATUSES.has(left.status));
    if (activeDiff !== 0) {
      return activeDiff;
    }

    return (
      getSubscriptionSortTimestamp(right) - getSubscriptionSortTimestamp(left)
    );
  })[0];
}

export async function getCurrentSubscriptionByReference(
  referenceId: string
): Promise<Subscription | null> {
  const subscriptions = await dbClient
    .selectFrom("subscription")
    .selectAll()
    .where("referenceId", "=", referenceId)
    .execute();

  return pickCurrentSubscription(subscriptions as Subscription[]);
}

export function normalizeSubscriptionForClient(
  subscription: Subscription | null
): StripeSubscription | null {
  if (!subscription) {
    return null;
  }

  return {
    ...subscription,
    billingInterval: subscription.billingInterval ?? undefined,
    cancelAt: subscription.cancelAt ?? undefined,
    canceledAt: subscription.canceledAt ?? undefined,
    endedAt: subscription.endedAt ?? undefined,
    limits: subscription.limits ?? undefined,
    stripeCustomerId: subscription.stripeCustomerId ?? undefined,
    stripeScheduleId: subscription.stripeScheduleId ?? undefined,
    stripeSubscriptionId: subscription.stripeSubscriptionId ?? undefined,
  } as StripeSubscription;
}
