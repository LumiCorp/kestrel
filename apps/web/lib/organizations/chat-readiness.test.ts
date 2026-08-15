import test from "node:test";
import "../../scripts/register-server-only.mjs";

import assert from "node:assert/strict";
import {
  deriveOrganizationChatReadiness,
  type OrganizationChatReadinessInput,
} from "./chat-readiness";

function readyInput(
  overrides: Partial<OrganizationChatReadinessInput> = {},
): OrganizationChatReadinessInput {
  return {
    personal: false,
    model: {
      gatewayId: "gateway-1",
      gatewayName: "Lumi",
      modelId: "model-1",
      modelName: "Kestrel",
      gatewayProvider: "lumi",
      credentialStatus: "ready",
      credentialValidatedAt: "2026-07-22T12:00:00.000Z",
      hasRequiredCredential: true,
    },
    fly: {
      enabled: true,
      hasApiToken: true,
      organizationSlug: "acme",
      status: "ready",
      lastTestedAt: "2026-07-22T12:00:00.000Z",
    },
    rollout: {
      deploymentEnabled: true,
      organizationConfigured: true,
      organizationEnabled: true,
      effectiveEnabled: true,
    },
    environment: {
      id: "environment-1",
      name: "Default",
      status: "ready",
      failureMessage: null,
    },
    operation: {
      id: "operation-1",
      status: "completed",
      stage: "environment.activation.ready",
      providerRequestId: null,
      errorMessage: null,
    },
    ...overrides,
  };
}

test("organization readiness uses the fixed next-step order", () => {
  const missingEverything = deriveOrganizationChatReadiness(
    readyInput({ model: null, fly: null, environment: null }),
  );
  assert.equal(missingEverything.nextStep, "model_access");
  assert.equal(
    deriveOrganizationChatReadiness(readyInput({ fly: null })).nextStep,
    "workspace_compute",
  );
  assert.equal(
    deriveOrganizationChatReadiness(
      readyInput({
        environment: { ...readyInput().environment!, status: "provisioning" },
      }),
    ).nextStep,
    "environment_execution",
  );
});

test("model readiness requires a default model credential", () => {
  const noCredential = deriveOrganizationChatReadiness(
    readyInput({
      model: { ...readyInput().model!, hasRequiredCredential: false },
    }),
  );
  assert.equal(noCredential.modelAccess.status, "missing_credential");
  assert.equal(noCredential.ready, false);
});

test("model readiness rejects invalid and unverified credentials", () => {
  const invalid = deriveOrganizationChatReadiness(
    readyInput({
      model: {
        ...readyInput().model!,
        credentialStatus: "invalid",
        credentialValidatedAt: null,
      },
    }),
  );
  assert.equal(invalid.modelAccess.status, "invalid_credential");
  assert.equal(invalid.nextStep, "model_access");

  const unverified = deriveOrganizationChatReadiness(
    readyInput({
      model: {
        ...readyInput().model!,
        credentialStatus: "unverified",
        credentialValidatedAt: null,
      },
    }),
  );
  assert.equal(unverified.modelAccess.status, "unverified_credential");
  assert.equal(unverified.ready, false);
});

test("incomplete signup onboarding only accepts its three keyed providers", () => {
  const unsupported = deriveOrganizationChatReadiness(
    readyInput({
      personal: true,
      personalRequiresSetup: true,
      enforceSignupProviderPolicy: true,
    }),
  );
  assert.equal(unsupported.modelAccess.status, "unsupported_provider");
  assert.equal(unsupported.ready, false);

  const openAi = deriveOrganizationChatReadiness(
    readyInput({
      personal: true,
      personalRequiresSetup: true,
      enforceSignupProviderPolicy: true,
      model: {
        ...readyInput().model!,
        gatewayProvider: "openai",
      },
    }),
  );
  assert.equal(openAi.modelAccess.status, "ready");
});

test("Fly readiness distinguishes untested and degraded credentials", () => {
  const missingCredential = deriveOrganizationChatReadiness(
    readyInput({
      fly: {
        ...readyInput().fly!,
        hasApiToken: false,
      },
    }),
  );
  assert.equal(missingCredential.workspaceCompute.status, "missing_credential");
  const untested = deriveOrganizationChatReadiness(
    readyInput({ fly: { ...readyInput().fly!, status: "not_configured" } }),
  );
  assert.equal(untested.workspaceCompute.status, "untested");
  const degraded = deriveOrganizationChatReadiness(
    readyInput({ fly: { ...readyInput().fly!, status: "degraded" } }),
  );
  assert.equal(degraded.workspaceCompute.status, "degraded");
});

test("execution readiness reports rollout and terminal environment states", () => {
  const deploymentDisabled = deriveOrganizationChatReadiness(
    readyInput({
      rollout: {
        deploymentEnabled: false,
        organizationConfigured: true,
        organizationEnabled: true,
        effectiveEnabled: false,
      },
    }),
  );
  assert.equal(
    deploymentDisabled.environmentExecution.status,
    "deployment_disabled",
  );

  const disabled = deriveOrganizationChatReadiness(
    readyInput({
      rollout: {
        deploymentEnabled: true,
        organizationConfigured: true,
        organizationEnabled: false,
        effectiveEnabled: false,
      },
    }),
  );
  assert.equal(disabled.environmentExecution.status, "rollout_disabled");

  const missingCurrentRuntime = deriveOrganizationChatReadiness(
    readyInput({
      currentEnvironmentRuntimeAvailable: false,
      environment: null,
      operation: null,
    }),
  );
  assert.equal(
    missingCurrentRuntime.environmentExecution.status,
    "current_environment_runtime_unavailable",
  );
  assert.match(
    missingCurrentRuntime.environmentExecution.detail,
    /production Environment Runtime Channel/u,
  );

  const readyWithoutCurrentRuntime = deriveOrganizationChatReadiness(
    readyInput({ currentEnvironmentRuntimeAvailable: false }),
  );
  assert.equal(
    readyWithoutCurrentRuntime.environmentExecution.status,
    "current_environment_runtime_unavailable",
  );
  assert.equal(readyWithoutCurrentRuntime.environmentExecution.ready, false);
  assert.equal(readyWithoutCurrentRuntime.ready, false);

  const failed = deriveOrganizationChatReadiness(
    readyInput({
      environment: {
        ...readyInput().environment!,
        status: "failed",
        failureMessage: "Provisioning stopped safely.",
      },
    }),
  );
  assert.equal(failed.environmentExecution.status, "failed");
  assert.equal(
    failed.environmentExecution.failureMessage,
    "Provisioning stopped safely.",
  );

  const retrying = deriveOrganizationChatReadiness(
    readyInput({
      environment: {
        ...readyInput().environment!,
        status: "failed",
        failureMessage: "Previous failure",
      },
      operation: {
        ...readyInput().operation!,
        status: "queued",
      },
    }),
  );
  assert.equal(retrying.environmentExecution.status, "provisioning");
  assert.equal(retrying.nextStep, "environment_execution");
});

test("fully configured team organizations are ready", () => {
  const readiness = deriveOrganizationChatReadiness(readyInput());
  assert.equal(readiness.applicable, true);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nextStep, null);
});

test("personal organizations remain outside onboarding", () => {
  const readiness = deriveOrganizationChatReadiness(
    readyInput({ personal: true, model: null, fly: null, environment: null }),
  );
  assert.equal(readiness.applicable, false);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nextStep, null);
});

test("code-created personal organizations use the full readiness contract", () => {
  const readiness = deriveOrganizationChatReadiness(
    readyInput({
      personal: true,
      personalRequiresSetup: true,
      model: null,
      fly: null,
      environment: null,
    }),
  );
  assert.equal(readiness.applicable, true);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.nextStep, "model_access");
});
