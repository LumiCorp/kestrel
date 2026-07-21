import assert from "node:assert/strict";
import {
  authorizeWorkspaceIdleNotification,
  WORKSPACE_IDLE_NOTIFICATION_VERSION,
  WorkspaceIdleNotificationError,
  workspaceIdleNotificationSchema,
} from "./idle-contract";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Workspace idle notifications require the dedicated runtime bearer", () => {
  assert.doesNotThrow(() =>
    authorizeWorkspaceIdleNotification({
      authorization: "Bearer runtime-secret",
      expectedToken: "runtime-secret",
    })
  );
  for (const authorization of [null, "Bearer wrong-secret"]) {
    assert.throws(
      () =>
        authorizeWorkspaceIdleNotification({
          authorization,
          expectedToken: "runtime-secret",
        }),
      (error: unknown) =>
        error instanceof WorkspaceIdleNotificationError &&
        error.code === "WORKSPACE_IDLE_UNAUTHORIZED" &&
        error.status === 401
    );
  }
});

contractTest("web.hermetic", "Workspace idle notifications bind the exact organization and Machine", () => {
  const parsed = workspaceIdleNotificationSchema.parse({
    version: WORKSPACE_IDLE_NOTIFICATION_VERSION,
    organizationId: "organization-id",
    environmentId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    machineId: "d8d96934c79198",
    lastActivityAt: "2026-07-13T12:00:00.000Z",
  });
  assert.equal(parsed.machineId, "d8d96934c79198");
  assert.throws(() =>
    workspaceIdleNotificationSchema.parse({
      ...parsed,
      workspaceId: "not-a-workspace-id",
    })
  );
});
