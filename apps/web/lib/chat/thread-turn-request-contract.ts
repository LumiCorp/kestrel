import type { UIMessage } from "ai";
import { z } from "zod";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";
import { KESTREL_ONE_INTERACTION_MODES } from "@/lib/turns/interaction-mode";

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
    runtimeId: z.enum(["kestrel", "codex", "claude"]).optional(),
    projectId: routeIdSchema.nullable().optional(),
    // Older web clients include their rendered message window alongside an
    // interaction response. Canonical history remains server-owned; accept
    // and ignore this compatibility envelope rather than trusting it.
    messages: z.array(uiMessageSchema).max(500).optional(),
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
        message: z.string().trim().min(1).max(20_000),
        answers: z
          .record(
            z.string().trim().min(1).max(200),
            z.array(z.string().trim().min(1).max(20_000)).min(1).max(20),
          )
          .optional(),
        approved: z.boolean().optional(),
        reason: z.string().trim().max(2000).optional(),
        recoveryOptionId: z.string().trim().min(1).max(200).optional(),
        messageId: routeIdSchema.optional(),
      })
      .strict()
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
    },
  );
