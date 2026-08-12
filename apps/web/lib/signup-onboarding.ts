import "server-only";

import { listAIGatewaysWithModels } from "@/lib/ai/gateways";
import type { OrganizationChatReadiness } from "@/lib/organizations/chat-readiness";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";
import { ensurePersonalOrganizationByUserId } from "@/lib/personal-workspace";
import { getSignupAccessCodeIdentityForUser } from "@/lib/signup-access-codes";
import {
  deriveConfiguredSignupOnboardingState,
  deriveSignupOnboardingIdentityState,
} from "@/lib/signup-onboarding-policy";
import { isSignupOnboardingProvider } from "@/lib/signup-onboarding-provider-policy";

export type SignupOnboardingStateName =
  | "not_applicable"
  | "invite_code_required"
  | "email_verification_required"
  | "provider_required"
  | "model_required"
  | "fly_required"
  | "provisioning"
  | "failed"
  | "complete";

export type SignupOnboardingState = {
  state: SignupOnboardingStateName;
  organizationId: string | null;
  onboardingCompletedAt: string | null;
  readiness: OrganizationChatReadiness | null;
};

export type SignupOnboardingModel = {
  id: string;
  gatewayId: string;
  rawModelId: string;
  alias: string | null;
  modality: string;
  approved: boolean;
  isDefault: boolean;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

export type SignupOnboardingGateway = {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  environmentId: string | null;
  credentialStatus: string;
  credentialValidatedAt: string | null;
  models: SignupOnboardingModel[];
};

export type SignupOnboardingSnapshot = {
  onboarding: SignupOnboardingState;
  gateways: SignupOnboardingGateway[];
  canComplete: boolean;
};

export class SignupOnboardingGuardError extends Error {
  readonly code = "ORGANIZATION_SETUP_REQUIRED";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "SignupOnboardingGuardError";
  }
}

function emptyState(
  state: "not_applicable" | "invite_code_required" | "email_verification_required",
): SignupOnboardingState {
  return {
    state,
    organizationId: null,
    onboardingCompletedAt: null,
    readiness: null,
  };
}

function hasValidatedOnboardingProvider(
  gateways: Awaited<ReturnType<typeof listAIGatewaysWithModels>>,
) {
  return gateways.some(
    ({ gateway }) =>
      gateway.environmentId === null &&
      gateway.enabled &&
      isSignupOnboardingProvider(gateway.provider) &&
      gateway.hasApiKey &&
      gateway.credentialStatus === "ready" &&
      Boolean(gateway.credentialValidatedAt),
  );
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeOnboardingGateways(
  gateways: Awaited<ReturnType<typeof listAIGatewaysWithModels>>,
): SignupOnboardingGateway[] {
  return gateways.flatMap(({ gateway, models }) => {
    if (
      gateway.environmentId !== null ||
      !isSignupOnboardingProvider(gateway.provider)
    ) {
      return [];
    }
    return [
      {
        id: gateway.id,
        provider: gateway.provider,
        displayName: gateway.displayName,
        enabled: gateway.enabled,
        hasApiKey: gateway.hasApiKey,
        environmentId: gateway.environmentId,
        credentialStatus: gateway.credentialStatus,
        credentialValidatedAt:
          gateway.credentialValidatedAt?.toISOString() ?? null,
        models: models.map((model) => ({
          id: model.id,
          gatewayId: model.gatewayId,
          rawModelId: model.rawModelId,
          alias: model.alias,
          modality: model.modality,
          approved: model.approved,
          isDefault: model.isDefault,
          description: model.description,
          metadata: normalizeMetadata(model.metadata),
        })),
      },
    ];
  });
}

export async function getSignupOnboardingState(input: {
  userId: string;
  email?: string;
  emailVerified?: boolean;
  now?: Date;
}): Promise<SignupOnboardingState> {
  const identity = await getSignupAccessCodeIdentityForUser(input.userId);
  if (!identity) {
    return emptyState("not_applicable");
  }

  const { redemption } = identity;
  const identityState = deriveSignupOnboardingIdentityState({
    hasRedemptionPointer: true,
    onboardingCompleted: Boolean(redemption.onboardingCompletedAt),
    redeemed: Boolean(redemption.redeemedAt),
    reservationExpiresAt: redemption.reservationExpiresAt,
    emailVerified: identity.emailVerified,
    now: input.now,
  });
  if (identityState === "complete" && redemption.onboardingCompletedAt) {
    const organization = await ensurePersonalOrganizationByUserId(input.userId);
    return {
      state: "complete",
      organizationId: organization.id,
      onboardingCompletedAt: redemption.onboardingCompletedAt.toISOString(),
      readiness: await getOrganizationChatReadiness(organization.id),
    };
  }
  if (
    identityState === "invite_code_required" ||
    identityState === "email_verification_required"
  ) {
    return emptyState(identityState);
  }

  // A verified, active reservation is redeemed by the database verification
  // trigger. Do not repair that invariant by matching on email here.
  if (!redemption.redeemedAt) {
    console.error("Signup code verification completed without redemption.", {
      userId: input.userId,
      redemptionId: redemption.id,
    });
    return emptyState("email_verification_required");
  }

  const organization = await ensurePersonalOrganizationByUserId(input.userId);
  const [readiness, gateways] = await Promise.all([
    getOrganizationChatReadiness(organization.id),
    listAIGatewaysWithModels(organization.id),
  ]);

  return {
    state: deriveConfiguredSignupOnboardingState({
      onboardingCompleted: false,
      hasConfiguredProvider: hasValidatedOnboardingProvider(gateways),
      readiness,
    }),
    organizationId: organization.id,
    onboardingCompletedAt: null,
    readiness,
  };
}

export async function getSignupOnboardingSnapshot(input: {
  userId: string;
  now?: Date;
}): Promise<SignupOnboardingSnapshot> {
  const onboarding = await getSignupOnboardingState(input);
  if (!onboarding.organizationId) {
    return { onboarding, gateways: [], canComplete: false };
  }

  const gateways = sanitizeOnboardingGateways(
    await listAIGatewaysWithModels(onboarding.organizationId),
  );
  return {
    onboarding,
    gateways,
    canComplete:
      onboarding.state !== "complete" &&
      Boolean(onboarding.readiness?.ready),
  };
}

export async function requireSignupOnboardingIdentity(userId: string) {
  const identity = await getSignupAccessCodeIdentityForUser(userId);
  if (!identity) {
    throw new SignupOnboardingGuardError(
      "This account does not have signup-code onboarding.",
    );
  }
  return identity;
}

export async function requireSignupOnboardingWorkspace(userId: string) {
  const identity = await requireSignupOnboardingIdentity(userId);
  if (
    identity.redemption.onboardingCompletedAt ||
    !identity.emailVerified ||
    !identity.redemption.redeemedAt
  ) {
    throw new SignupOnboardingGuardError(
      "Complete the current signup onboarding step before continuing.",
    );
  }

  const organization = await ensurePersonalOrganizationByUserId(userId);
  return { identity, organization };
}

export async function userHasIncompleteSignupOnboarding(input: {
  userId: string;
  email?: string;
  emailVerified?: boolean;
}) {
  const state = await getSignupOnboardingState(input);
  return state.state !== "not_applicable" && state.state !== "complete";
}
