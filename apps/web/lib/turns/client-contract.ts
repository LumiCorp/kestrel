import { z } from "zod";

export const threadInteractionViewSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  source: z.enum(["runtime", "mcp"]),
  sourceCheckpointId: z.string().nullable(),
  kind: z.enum(["user_input", "approval", "mcp_sampling", "mcp_elicitation"]),
  eventType: z.string(),
  prompt: z.string(),
  status: z.enum(["pending", "processing", "resolved", "cancelled", "failed"]),
  requestEnvelope: z.record(z.string(), z.unknown()),
  responseEnvelope: z.record(z.string(), z.unknown()).nullable(),
  responseMessageId: z.string().nullable(),
  turnId: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
  createdAt: z.coerce.string(),
  resolvedAt: z.coerce.string().nullable(),
});

export const threadTurnViewSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  inputMessageId: z.string().nullable(),
  status: z.enum([
    "queued",
    "running",
    "waiting_for_input",
    "completed",
    "failed",
    "cancelled",
  ]),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  cancelRequestedAt: z.coerce.string().nullable(),
  startedAt: z.coerce.string().nullable(),
  finishedAt: z.coerce.string().nullable(),
  createdAt: z.coerce.string(),
  updatedAt: z.coerce.string(),
});

export const threadConversationStateSchema = z.object({
  interactions: z.array(threadInteractionViewSchema),
  turns: z.array(threadTurnViewSchema),
  queue: z.object({
    state: z.enum(["running", "paused"]),
    pauseReason: z
      .enum(["turn_failed", "turn_cancelled", "interaction_required"])
      .nullable(),
    activeTurnId: z.string().nullable(),
    version: z.number(),
  }),
});

export type ThreadInteractionView = z.infer<typeof threadInteractionViewSchema>;
export type ThreadTurnView = z.infer<typeof threadTurnViewSchema>;
export type ThreadConversationState = z.infer<
  typeof threadConversationStateSchema
>;

export const emptyThreadConversationState: ThreadConversationState = {
  interactions: [],
  turns: [],
  queue: {
    state: "running",
    pauseReason: null,
    activeTurnId: null,
    version: 0,
  },
};
