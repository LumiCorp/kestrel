import "../../scripts/register-server-only.mjs";

import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  deriveOrganizationChatReadiness,
  type OrganizationChatReadinessInput,
} from "./chat-readiness";

function readyInput(
  overrides: Partial<OrganizationChatReadinessInput> = {}
): OrganizationChatReadinessInput {
  return {
    personal: false,
    model: {
      gatewayId: "gateway-1",
      gatewayName: "Lumi",
      modelId: "model-1",
      modelName: "Kestrel",
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
      errorMessage: null,
    },
    ...overrides,
  };
}

contractTest("web.hermetic", "organization readiness uses the fixed next-step order", () => {
  const missingEverything = deriveOrganizationChatReadiness(
    readyInput({ model: null, fly: null, environment: null })
  );
  assert.equal(missingEverything.nextStep, "model_access");
  assert.equal(
    deriveOrganizationChatReadiness(readyInput({ fly: null })).nextStep,
    "workspace_compute"
  );
  assert.equal(
    deriveOrganizationChatReadiness(
      readyInput({
        environment: { ...readyInput().environment!, status: "provisioning" },
      })
    ).nextStep,
    "environment_execution"
  );
});

contractTest("web.hermetic", "model readiness requires a default model credential", () => {
  const noCredential = deriveOrganizationChatReadiness(
    readyInput({
      model: { ...readyInput().model!, hasRequiredCredential: false },
    })
  );
  assert.equal(noCredential.modelAccess.status, "missing_credential");
  assert.equal(noCredential.ready, false);
});

contractTest("web.hermetic", "Fly readiness distinguishes untested and degraded credentials", () => {
  const missingCredential = deriveOrganizationChatReadiness(
    readyInput({
      fly: {
        ...readyInput().fly!,
        hasApiToken: false,
      },
    })
  );
  assert.equal(missingCredential.workspaceCompute.status, "missing_credential");
  const untested = deriveOrganizationChatReadiness(
    readyInput({ fly: { ...readyInput().fly!, status: "not_configured" } })
  );
  assert.equal(untested.workspaceCompute.status, "untested");
  const degraded = deriveOrganizationChatReadiness(
    readyInput({ fly: { ...readyInput().fly!, status: "degraded" } })
  );
  assert.equal(degraded.workspaceCompute.status, "degraded");
});

contractTest("web.hermetic", "execution readiness reports rollout and terminal environment states", () => {
  const deploymentDisabled = deriveOrganizationChatReadiness(
    readyInput({
      rollout: {
        deploymentEnabled: false,
        organizationEnabled: true,
        effectiveEnabled: false,
      },
    })
  );
  assert.equal(
    deploymentDisabled.environmentExecution.status,
    "deployment_disabled"
  );

  const disabled = deriveOrganizationChatReadiness(
    readyInput({
      rollout: {
        deploymentEnabled: true,
        organizationEnabled: false,
        effectiveEnabled: false,
      },
    })
  );
  assert.equal(disabled.environmentExecution.status, "rollout_disabled");

  const failed = deriveOrganizationChatReadiness(
    readyInput({
      environment: {
        ...readyInput().environment!,
        status: "failed",
        failureMessage: "Provisioning stopped safely.",
      },
    })
  );
  assert.equal(failed.environmentExecution.status, "failed");
  assert.equal(failed.environmentExecution.failureMessage, "Provisioning stopped safely.");

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
    })
  );
  assert.equal(retrying.environmentExecution.status, "provisioning");
  assert.equal(retrying.nextStep, "environment_execution");
});

contractTest("web.hermetic", "fully configured team organizations are ready", () => {
  const readiness = deriveOrganizationChatReadiness(readyInput());
  assert.equal(readiness.applicable, true);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nextStep, null);
});

contractTest("web.hermetic", "personal organizations remain outside onboarding", () => {
  const readiness = deriveOrganizationChatReadiness(
    readyInput({ personal: true, model: null, fly: null, environment: null })
  );
  assert.equal(readiness.applicable, false);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nextStep, null);
});
