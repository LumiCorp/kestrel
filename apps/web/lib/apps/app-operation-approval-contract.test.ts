import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAppOperationApprovalBinding,
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
        payload: { channelId: "channel-1", body: { content: "Changed" } },
      }),
    /APP_OPERATION_APPROVAL_PAYLOAD_MISMATCH/u
  );
});
