import { z } from "zod";

const claimedFromFilterSchema = z
  .string()
  .trim()
  .email("Enter one exact claimed From mailbox.")
  .max(320)
  .nullable();

export const createEmailTriggerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    instruction: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).max(200),
    claimedFromFilter: claimedFromFilterSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updateEmailTriggerInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    instruction: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    claimedFromFilter: claimedFromFilterSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ expectedRevision: _expectedRevision, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: "At least one Email Trigger change is required." },
  );

export const emailTriggerRevisionInputSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
