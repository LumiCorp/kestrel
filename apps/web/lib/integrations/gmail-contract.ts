import { z } from "zod";
import { googleWorkspaceOperationDescriptor } from "../../../../src/apps/googleWorkspace.js";

export const GMAIL_CAPABILITIES = [
  "gmail.messages.search",
  "gmail.messages.read",
  "gmail.threads.read",
  "gmail.attachments.import",
  "gmail.messages.send",
  "gmail.messages.reply",
] as const;
export type GmailCapability = (typeof GMAIL_CAPABILITIES)[number];

const gmailIdSchema = z.string().trim().min(1).max(1024);
const gmailQuerySchema = z.string().trim().min(1).max(4096);
const recipientSchema = z.string().trim().email().max(320);
const gmailBodySchema = z.string().min(1).max(100_000);

export const gmailRuntimeInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("gmail.messages.search"),
    query: gmailQuerySchema,
    cursor: z.string().trim().min(1).max(4096).optional(),
    maxResults: z.number().int().min(1).max(100).default(50),
  }).strict(),
  z.object({
    operation: z.literal("gmail.messages.send"),
    to: z.array(recipientSchema).min(1).max(50),
    cc: z.array(recipientSchema).max(50).default([]),
    subject: z.string().trim().min(1).max(998),
    text: gmailBodySchema,
    html: z.string().min(1).max(200_000).optional(),
    attachmentFileIds: z.array(gmailIdSchema).max(20).default([]),
  }).strict().superRefine((value, context) => {
    if (value.to.length + value.cc.length > 50) context.addIssue({ code: "custom", message: "Gmail supports at most 50 total recipients." });
  }),
  z.object({
    operation: z.literal("gmail.messages.reply"),
    messageId: gmailIdSchema,
    text: gmailBodySchema,
    html: z.string().min(1).max(200_000).optional(),
    attachmentFileIds: z.array(gmailIdSchema).max(20).default([]),
  }).strict(),
  z.object({ operation: z.literal("gmail.messages.get"), messageId: gmailIdSchema }).strict(),
  z.object({ operation: z.literal("gmail.threads.get"), threadId: gmailIdSchema }).strict(),
  z.object({
    operation: z.literal("gmail.attachments.import"),
    messageId: gmailIdSchema,
    attachmentId: gmailIdSchema,
  }).strict(),
]);
export type GmailRuntimeInput = z.infer<typeof gmailRuntimeInputSchema>;

export function capabilityForGmailOperation(operation: GmailRuntimeInput["operation"]): GmailCapability {
  return googleWorkspaceOperationDescriptor(operation).id as GmailCapability;
}

export function hasGmailCapabilityScopes(input: {
  grantedScopes: readonly string[];
  capability: GmailCapability;
}) {
  const operation = input.capability === "gmail.messages.read"
    ? "gmail.messages.get"
    : input.capability === "gmail.threads.read"
      ? "gmail.threads.get"
      : input.capability;
  return googleWorkspaceOperationDescriptor(operation).requiredScopes.every(
    (scope) => input.grantedScopes.includes(scope),
  );
}
