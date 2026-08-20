import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describeEnvironmentActivation } from "./execution-route";


test("Environment activation reports the user-visible wake sequence", () => {
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "provisioning",
      workspaceStatus: "requested",
    }),
    {
      stage: "environment.runtime.connecting",
      detail: "Provisioning the Environment runtime…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "stopped",
    }),
    {
      stage: "environment.machine.starting",
      detail: "Waking the Workspace Machine…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "degraded",
    }),
    {
      stage: "environment.health.checking",
      detail: "Reconnecting to the Workspace Runtime…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "stopping",
    }),
    {
      stage: "environment.machine.starting",
      detail: "Finishing the Workspace sleep transition…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "provisioning",
    }),
    {
      stage: "environment.workspace.mounting",
      detail: "Mounting the persistent Workspace…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "ready",
    }),
    {
      stage: "environment.activation.ready",
      detail: "Environment ready.",
      status: "ready",
    }
  );
});

test("Environment activation surfaces the stored failure without leaking a false ready state", () => {
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "failed",
      failureMessage: "Workspace health check failed.",
    }),
    {
      stage: "environment.activation.failed",
      detail: "Workspace health check failed.",
      status: "failed",
    }
  );
});

test("Workspace page activation uses lifecycle retry without submitting or replaying a turn", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/threads/[id]/environment/route.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /requestEnvironmentWorkspaceActivation\(\{/u);
  assert.doesNotMatch(source, /resolveEnvironmentExecutionRoute\(/u);
  assert.doesNotMatch(source, /run\.start|submit.*turn|replay/iu);
});
