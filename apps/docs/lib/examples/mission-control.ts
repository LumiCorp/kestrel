import type { RunnerCommandEnvelope } from "@kestrel-agents/protocol";

export const MISSION_CONTROL_ITEM_CREATE_COMMAND = {
  id: "cmd-create-release-work-item",
  type: "mission_control.action.execute",
  payload: {
    action: {
      type: "item.create",
      projectId: "11111111-1111-4111-8111-111111111111",
      actionId: "22222222-2222-4222-8222-222222222222",
      actionTs: "2026-08-04T16:00:00.000Z",
      expectedRevision: 3,
      itemId: "33333333-3333-4333-8333-333333333333",
      title: "Verify the 0.8 package release",
      instructions: "Run every packed-package gate and record immutable evidence.",
      createdBy: "operator",
      order: 4,
    },
  },
} as const satisfies RunnerCommandEnvelope<"mission_control.action.execute">;
