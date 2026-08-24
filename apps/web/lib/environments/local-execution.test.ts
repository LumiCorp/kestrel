import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_ENVIRONMENT_RUNTIME_IMAGE,
  LOCAL_ENVIRONMENT_TICKET_APP_NAME,
  isLocalEnvironmentExecutionTarget,
  localEnvironmentExecutionTarget,
} from "./local-execution";

test("local Environment tickets bind to the exact Workspace execution", () => {
  assert.deepEqual(localEnvironmentExecutionTarget("workspace-1"), {
    provider: "fly",
    appName: LOCAL_ENVIRONMENT_TICKET_APP_NAME,
    machineId: "workspace-1",
  });
  assert.equal(
    isLocalEnvironmentExecutionTarget({
      runtimeImage: LOCAL_ENVIRONMENT_RUNTIME_IMAGE,
      workspaceId: "workspace-1",
      appName: LOCAL_ENVIRONMENT_TICKET_APP_NAME,
      machineId: "workspace-1",
    }),
    true,
  );
  assert.equal(
    isLocalEnvironmentExecutionTarget({
      runtimeImage: LOCAL_ENVIRONMENT_RUNTIME_IMAGE,
      workspaceId: "workspace-1",
      appName: LOCAL_ENVIRONMENT_TICKET_APP_NAME,
      machineId: "workspace-2",
    }),
    false,
  );
});
