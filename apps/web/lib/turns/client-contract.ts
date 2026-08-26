import { z } from "zod";
import { messageMetadataSchema, type ChatMessage } from "@/lib/types";

export const runtimeApprovalPolicyViewSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  appKey: z.string(),
  capabilityKey: z.string(),
  capabilityDisplayName: z.string(),
  environmentApprovalMode: z.enum(["auto", "ask", "deny"]),
  projectApprovalMode: z.enum(["auto", "ask", "deny"]),
  minimumApprovalMode: z.enum(["auto", "ask"]),
  subjectApprovalMode: z.enum(["ask", "deny"]).nullable().optional(),
  approvalResourceAvailable: z.boolean().optional(),
  rememberApprovalEligible: z.boolean().optional(),
  reasonCode: z.enum([
    "tool_minimum",
    "environment_policy",
    "project_restriction",
    "subject_restriction",
    "runtime_strict",
  ]),
  canEditProject: z.boolean(),
  approvalRequirementExplanation: z.string().optional(),
});

export const threadInteractionViewSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  source: z.enum(["runtime", "mcp"]),
  sourceCheckpointId: z.string().nullable(),
  kind: z.enum(["user_input", "approval", "mcp_sampling", "mcp_elicitation"]),
  eventType: z.string(),
  prompt: z.string(),
  status: z.enum(["pending", "processing", "resolved", "cancelled", "failed"]),
  approvalOutcome: z.object({
    decision: z.enum(["approved", "denied", "expired"]),
    authorizationState: z.enum(["pending", "accepted", "denied", "expired", "failed"]),
    effectState: z.enum(["not_started", "started", "committed", "unknown"]),
    failureCode: z.string().optional(),
    publicMessage: z.string().optional(),
    retryEligible: z.boolean(),
  }).optional(),
  requestEnvelope: z.record(z.string(), z.unknown()),
  approvalPolicy: runtimeApprovalPolicyViewSchema.optional(),
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

const chatMessageSchema = z.custom<ChatMessage>(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const message = value as Record<string, unknown>;
    return (
      typeof message.id === "string" &&
      ["user", "assistant", "system"].includes(String(message.role)) &&
      Array.isArray(message.parts) &&
      (message.metadata === undefined ||
        messageMetadataSchema.safeParse(message.metadata).success)
    );
  },
  { message: "Invalid persisted chat message." },
);

export const threadConversationSnapshotSchema =
  threadConversationStateSchema.extend({
    messages: z.array(chatMessageSchema),
  });

export type ThreadInteractionView = z.infer<typeof threadInteractionViewSchema>;
export type RuntimeApprovalPolicyView = z.infer<
  typeof runtimeApprovalPolicyViewSchema
>;
export type ThreadTurnView = z.infer<typeof threadTurnViewSchema>;
export type ThreadConversationState = z.infer<
  typeof threadConversationStateSchema
>;
export type ThreadConversationSnapshot = z.infer<
  typeof threadConversationSnapshotSchema
>;

export function shouldInstallThreadConversationSnapshot(
  current: ThreadConversationSnapshot,
  next: ThreadConversationSnapshot,
  requestOrder?: {
    requestedThreadId: string;
    activeThreadId: string;
    requestSequence: number;
    lastInstalledSequence: number;
  } | undefined,
): boolean {
  if (
    requestOrder !== undefined
    && (
      requestOrder.requestedThreadId !== requestOrder.activeThreadId
      || requestOrder.requestSequence < requestOrder.lastInstalledSequence
    )
  ) {
    return false;
  }
  return next.queue.version >= current.queue.version;
}

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

export const emptyThreadConversationSnapshot: ThreadConversationSnapshot = {
  ...emptyThreadConversationState,
  messages: [],
};
