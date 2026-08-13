import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationChatReadiness } from "./organizations/chat-readiness";
import {
  deriveConfiguredSignupOnboardingState,
  deriveSignupOnboardingIdentityState,
} from "./signup-onboarding-policy";

test("signup identity state follows pointer, completion, expiry, and verification order", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  const derive = (
    input: Partial<Parameters<typeof deriveSignupOnboardingIdentityState>[0]>,
  ) =>
    deriveSignupOnboardingIdentityState({
      hasRedemptionPointer: true,
      onboardingCompleted: false,
      redeemed: false,
      reservationExpiresAt: new Date(now.getTime() + 60_000),
      emailVerified: false,
      now,
      ...input,
    });

  assert.equal(derive({ hasRedemptionPointer: false }), "not_applicable");
  assert.equal(
    derive({
      onboardingCompleted: true,
      reservationExpiresAt: new Date(now.getTime() - 1),
    }),
    "complete",
  );
  assert.equal(
    derive({ reservationExpiresAt: new Date(now.getTime() - 1) }),
    "invite_code_required",
  );
  assert.equal(derive({}), "email_verification_required");
  assert.equal(
    derive({ emailVerified: true }),
    "email_verification_required",
  );
  assert.equal(derive({ emailVerified: true, redeemed: true }), null);
});

function readiness(input: {
  model?: boolean;
  fly?: boolean;
  environment?: boolean;
  executionStatus?: string;
}): OrganizationChatReadiness {
  const model = input.model ?? false;
  const fly = input.fly ?? false;
  const environment = input.environment ?? false;
  return {
    applicable: true,
    ready: model && fly && environment,
    nextStep: model
      ? fly
        ? environment
          ? null
          : "environment_execution"
        : "workspace_compute"
      : "model_access",
    modelAccess: {
      ready: model,
      status: model ? "ready" : "missing_default_model",
      detail: "",
      gatewayId: null,
      gatewayName: null,
      modelId: null,
      modelName: null,
    },
    workspaceCompute: {
      ready: fly,
      status: fly ? "ready" : "missing_connection",
      detail: "",
      enabled: fly,
      hasApiToken: fly,
      organizationSlug: fly ? "org" : "",
      lastTestedAt: null,
    },
    environmentExecution: {
      ready: environment,
      status:
        input.executionStatus ??
        (environment ? "ready" : "missing_environment"),
      detail: "",
      deploymentEnabled: true,
      organizationEnabled: true,
      environmentId: null,
      environmentName: null,
      environmentStatus: null,
      operationId: null,
      operationStatus: null,
      operationStage: null,
      providerRequestId: null,
      failureMessage: null,
    },
  };
}

function state(input: {
  hasConfiguredProvider: boolean;
  readiness: OrganizationChatReadiness;
  onboardingCompleted?: boolean;
}) {
  return deriveConfiguredSignupOnboardingState({
    onboardingCompleted: input.onboardingCompleted ?? false,
    hasConfiguredProvider: input.hasConfiguredProvider,
    readiness: input.readiness,
  });
}

test("signup onboarding follows provider, model, Fly, and Environment order", () => {
  assert.equal(
    state({ hasConfiguredProvider: false, readiness: readiness({}) }),
    "provider_required",
  );
  assert.equal(
    state({ hasConfiguredProvider: true, readiness: readiness({}) }),
    "model_required",
  );
  assert.equal(
    state({
      hasConfiguredProvider: true,
      readiness: readiness({ model: true }),
    }),
    "fly_required",
  );
  assert.equal(
    state({
      hasConfiguredProvider: true,
      readiness: readiness({ model: true, fly: true }),
    }),
    "provisioning",
  );
  assert.equal(
    state({
      hasConfiguredProvider: true,
      readiness: readiness({
        model: true,
        fly: true,
        executionStatus: "failed",
      }),
    }),
    "failed",
  );
  assert.equal(
    state({
      hasConfiguredProvider: true,
      readiness: readiness({ model: true, fly: true, environment: true }),
    }),
    "provisioning",
  );
  assert.equal(
    state({
      onboardingCompleted: true,
      hasConfiguredProvider: false,
      readiness: readiness({}),
    }),
    "complete",
  );
});
