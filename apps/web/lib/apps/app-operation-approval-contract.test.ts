import test from "node:test";
import assert from "node:assert/strict";

import {
  assertAppOperationApprovalBinding,
  assertAppExternalApprovalBinding,
  createAppExternalApprovalBinding,
  hashAppApprovalAuthority,
  hashAppOperationPayload,
  type AppOperationApprovalBinding,
} from "./app-operation-approval-contract";


const binding: AppOperationApprovalBinding = {
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  actorUserId: "user-1",
  agentId: "agent-1",
  appKey: "microsoft_teams",
  capabilityKey: "messages.post",
  connectionId: "connection-1",
  resourceId: "channel-resource-1",
  resourceType: "channel",
  operationKey: "channel.message.post",
  runtimeApprovalId: "approval-1",
  payload: { channelId: "channel-1", body: { content: "Ship it" } },
};

test("App operation payload hashes are deterministic across object key order", () => {
  assert.equal(
    hashAppOperationPayload({ b: 2, a: { d: 4, c: 3 } }),
    hashAppOperationPayload({ a: { c: 3, d: 4 }, b: 2 })
  );
});

test("App operation approval binding accepts only the exact resource and payload", () => {
  const expected = {
    ...binding,
    payloadHash: hashAppOperationPayload(binding.payload),
  };
  assert.doesNotThrow(() =>
    assertAppOperationApprovalBinding(expected, binding)
  );
  assert.throws(
    () =>
      assertAppOperationApprovalBinding(expected, {
        ...binding,
        resourceId: "different-channel",
      }),
    /APP_OPERATION_APPROVAL_BINDING_MISMATCH/u
  );
  assert.throws(
    () =>
      assertAppOperationApprovalBinding(expected, {
        ...binding,
        actorUserId: "different-user",
      }),
    /APP_OPERATION_APPROVAL_BINDING_MISMATCH/u,
  );
  assert.throws(
    () =>
      assertAppOperationApprovalBinding(expected, {
        ...binding,
        payload: { channelId: "channel-1", body: { content: "Changed" } },
      }),
    /APP_OPERATION_APPROVAL_PAYLOAD_MISMATCH/u
  );
});

test("App operation external grants bind action, actor-scoped payload, authority, and expiry", () => {
  const authorityRevision = hashAppApprovalAuthority({ policy: "ask", revision: 4 });
  const stored = createAppExternalApprovalBinding({
    binding,
    requestedExecutionId: "execution-requested",
    authorityRevision,
    requestedAt: new Date("2026-08-03T10:00:00.000Z"),
    expiresAt: new Date("2026-08-03T10:05:00.000Z"),
  });
  assert.doesNotThrow(() =>
    assertAppExternalApprovalBinding({
      stored,
      actual: binding,
      requestedExecutionId: "execution-requested",
      authorityRevision,
    }),
  );
  for (const changed of [
    { actual: { ...binding, operationKey: "different.action" }, authorityRevision },
    {
      actual: { ...binding, payload: { changed: true } },
      authorityRevision,
    },
    { actual: binding, authorityRevision: hashAppApprovalAuthority({ policy: "deny" }) },
  ]) {
    assert.throws(
      () =>
        assertAppExternalApprovalBinding({
          stored,
          actual: changed.actual,
          requestedExecutionId: "execution-requested",
          authorityRevision: changed.authorityRevision,
        }),
      /APP_OPERATION_EXTERNAL_APPROVAL_BINDING_MISMATCH/u,
    );
  }
});
