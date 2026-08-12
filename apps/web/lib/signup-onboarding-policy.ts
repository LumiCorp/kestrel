import type { OrganizationChatReadiness } from "./organizations/chat-readiness";
import type { SignupOnboardingStateName } from "./signup-onboarding";

export function deriveSignupOnboardingIdentityState(input: {
  hasRedemptionPointer: boolean;
  onboardingCompleted: boolean;
  redeemed: boolean;
  reservationExpiresAt: Date | string | null;
  emailVerified: boolean;
  now?: Date;
}):
  | "not_applicable"
  | "complete"
  | "invite_code_required"
  | "email_verification_required"
  | null {
  if (!input.hasRedemptionPointer) return "not_applicable";
  if (input.onboardingCompleted) return "complete";
  const expiresAt = input.reservationExpiresAt
    ? new Date(input.reservationExpiresAt)
    : null;
  if (
    !input.redeemed &&
    (!expiresAt || expiresAt.getTime() <= (input.now ?? new Date()).getTime())
  ) {
    return "invite_code_required";
  }
  if (!input.emailVerified || !input.redeemed) {
    return "email_verification_required";
  }
  return null;
}

export function deriveConfiguredSignupOnboardingState(input: {
  onboardingCompleted: boolean;
  hasConfiguredProvider: boolean;
  readiness: OrganizationChatReadiness;
}): SignupOnboardingStateName {
  if (input.onboardingCompleted) return "complete";
  if (!input.readiness.modelAccess.ready) {
    return input.hasConfiguredProvider ? "model_required" : "provider_required";
  }
  if (!input.readiness.workspaceCompute.ready) return "fly_required";
  const status = input.readiness.environmentExecution.status;
  return status === "failed" ||
    status === "degraded" ||
    status === "deployment_disabled" ||
    status === "rollout_disabled"
    ? "failed"
    : "provisioning";
}
