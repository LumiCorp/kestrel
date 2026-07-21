import assert from "node:assert/strict";
import {
  notifyWorkspaceIdle,
  WORKSPACE_IDLE_NOTIFICATION_VERSION,
} from "../src/idle.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const identity = {
  controlPlaneUrl: "https://kestrel-one.example",
  authorizationToken: "runtime-secret",
  organizationId: "organization-id",
  environmentId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  machineId: "d8d96934c79198",
  lastActivityAt: new Date("2026-07-13T12:00:00.000Z"),
};

contractTest("services.hermetic", "Workspace idle notification binds the runtime identity and activity time", async () => {
  let request: Request | null = null;
  const accepted = await notifyWorkspaceIdle({
    ...identity,
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  assert.equal(accepted, true);
  assert.equal(
    request?.url,
    "https://kestrel-one.example/api/runtime/environments/idle"
  );
  assert.equal(request?.headers.get("authorization"), "Bearer runtime-secret");
  assert.deepEqual(await request?.json(), {
    version: WORKSPACE_IDLE_NOTIFICATION_VERSION,
    organizationId: identity.organizationId,
    environmentId: identity.environmentId,
    workspaceId: identity.workspaceId,
    machineId: identity.machineId,
    lastActivityAt: identity.lastActivityAt.toISOString(),
  });
});

contractTest("services.hermetic", "Workspace keeps serving when the control plane does not accept idle", async () => {
  assert.equal(
    await notifyWorkspaceIdle({
      ...identity,
      fetchImpl: async () =>
        Response.json(
          { error: { code: "WORKSPACE_IDLE_NOTIFICATION_REJECTED" } },
          { status: 403 }
        ),
    }),
    false
  );
  assert.equal(
    await notifyWorkspaceIdle({
      ...identity,
      fetchImpl: async () => {
        throw new Error("control plane unavailable");
      },
    }),
    false
  );
});
