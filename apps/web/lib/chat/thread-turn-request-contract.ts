import type { UIMessage } from "ai";
import { z } from "zod";
import {
  routeIdSchema,
  uiMessageSchema,
} from "@/lib/knowledge/validation";
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
    projectId: routeIdSchema.nullable().optional(),
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
        approved: z.boolean().optional(),
        reason: z.string().trim().max(2000).optional(),
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
    }
  );
