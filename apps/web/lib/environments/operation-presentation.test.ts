import assert from "node:assert/strict";
import { describeEnvironmentOperation } from "./operation-presentation";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Environment operations expose human-readable provisioning and wake progress", () => {
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "environment.provision",
      status: "running",
      stage: "environment.runtime.connecting",
    }),
    {
      label: "Environment provisioning",
      detail: "Creating the private Environment runtime…",
      tone: "neutral",
    }
  );
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "environment.provision",
      status: "running",
      stage: "environment.health.checking",
    }),
    {
      label: "Environment provisioning",
      detail: "Checking runtime health…",
      tone: "neutral",
    }
  );
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "workspace.start",
      status: "running",
      stage: "environment.machine.starting",
    }),
    {
      label: "Workspace wake",
      detail: "Waking the Workspace Machine…",
      tone: "neutral",
    }
  );
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "workspace.provision",
      status: "completed",
      stage: "environment.activation.ready",
    }),
    {
      label: "Workspace provisioning",
      detail: "Workspace ready.",
      tone: "success",
    }
  );
});

contractTest("web.hermetic", "Environment operations surface retained sleep and stored failures", () => {
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "workspace.stop",
      status: "completed",
      stage: "environment.machine.stopped",
    }),
    {
      label: "Workspace sleep",
      detail: "Workspace compute is asleep; its filesystem is retained.",
      tone: "success",
    }
  );
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "workspace.provision",
      status: "failed",
      stage: "environment.activation.failed",
      errorMessage: "Workspace health check failed.",
    }),
    {
      label: "Workspace provisioning",
      detail: "Workspace health check failed.",
      tone: "error",
    }
  );
});

contractTest("web.hermetic", "queued Environment operations identify Kestrel One as the control plane", () => {
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "environment.provision",
      status: "queued",
      stage: "environment.activation.requested",
    }),
    {
      label: "Environment provisioning",
      detail: "Waiting for Kestrel One to start this operation.",
      tone: "neutral",
    }
  );
});

contractTest("web.hermetic", "Environment updates expose the durable rollout stage", () => {
  assert.deepEqual(
    describeEnvironmentOperation({
      type: "environment.update",
      status: "running",
      stage: "environment.update.gateway",
    }),
    {
      label: "Environment update",
      detail: "Updating the Environment gateway…",
      tone: "neutral",
    }
  );
});
