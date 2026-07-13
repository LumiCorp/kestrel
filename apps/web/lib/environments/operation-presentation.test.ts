import assert from "node:assert/strict";
import test from "node:test";
import { describeEnvironmentOperation } from "./operation-presentation";

test("Environment operations expose human-readable provisioning and wake progress", () => {
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

test("Environment operations surface retained sleep and stored failures", () => {
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

test("queued Environment operations identify Kestrel One as the control plane", () => {
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
