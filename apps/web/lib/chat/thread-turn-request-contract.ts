import type { UIMessage } from "ai";
import { z } from "zod";
import {
  routeIdSchema,
  uiMessageSchema,
} from "@/lib/knowledge/validation";
import { KESTREL_ONE_INTERACTION_MODES } from "@/lib/turns/interaction-mode";
import { NEW_THREAD_WORKSPACE_MODES } from "@/lib/threads/workspace-mode";

const approvalResponseSchema = z
  .object({
    messageId: routeIdSchema,
    approvalId: routeIdSchema,
    approved: z.boolean(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const threadTurnBodySchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    interactionMode: z.enum(KESTREL_ONE_INTERACTION_MODES).default("chat"),
    projectId: routeIdSchema.nullable().optional(),
    workspaceMode: z.enum(NEW_THREAD_WORKSPACE_MODES).optional(),
    message: (uiMessageSchema as z.ZodType<UIMessage>)
      .refine((message) => message.role === "user", {
        message: "A submitted Thread message must have the user role.",
      })
      .optional(),
    approvalResponse: approvalResponseSchema.optional(),
    interactionResponse: z
      .object({
        // Runtime request IDs are opaque protocol identities, not database IDs.
        requestId: z.string().trim().min(1).max(200),
        eventType: z.string().trim().min(1).max(200),
        turnId: routeIdSchema,
        message: z.string().trim().min(1).max(20_000).optional(),
        decision: z.enum([
          "decline",
          "approve_once",
          "remember_approval",
        ]).optional(),
        reason: z.string().trim().max(2000).optional(),
        recoveryOptionId: z.string().trim().min(1).max(200).optional(),
        messageId: routeIdSchema.optional(),
      })
      .strict()
      .refine(
        (response) => response.eventType === "user.approval"
          ? response.decision !== undefined && response.message === undefined
          : response.message !== undefined && response.decision === undefined,
        { message: "Approval responses require only a structured decision; other interactions require a message." }
      )
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      [
        body.message !== undefined,
        body.approvalResponse !== undefined,
        body.interactionResponse !== undefined,
      ].filter(Boolean).length === 1,
    {
      message:
        "Exactly one user message, approval response, or interaction response is required.",
    }
  );
