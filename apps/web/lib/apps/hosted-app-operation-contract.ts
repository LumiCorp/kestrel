import { z } from "zod";
import {
  capabilityForGoogleCalendarOperation,
  googleCalendarRuntimeInputSchema,
} from "@/lib/integrations/google-calendar-contract";
import {
  capabilityForMicrosoft365Operation,
  microsoft365RuntimeInputSchema,
} from "@/lib/integrations/microsoft-365-contract";

const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
export const githubRuntimeActionInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("repository.read_file"), repository: repositorySchema, path: z.string().trim().min(1).max(4096), ref: z.string().trim().min(1).max(255).optional() }),
  z.object({ operation: z.literal("issue.create"), repository: repositorySchema, title: z.string().trim().min(1).max(256), body: z.string().max(65_536).optional() }),
  z.object({ operation: z.literal("pull_request.create"), repository: repositorySchema, title: z.string().trim().min(1).max(256), head: z.string().trim().min(1).max(255), base: z.string().trim().min(1).max(255), body: z.string().max(65_536).optional() }),
  z.object({ operation: z.literal("pull_request.merge"), repository: repositorySchema, pullNumber: z.number().int().positive(), method: z.enum(["merge", "squash", "rebase"]).optional() }),
  z.object({ operation: z.literal("release.create"), repository: repositorySchema, tagName: z.string().trim().min(1).max(255), name: z.string().trim().max(256).optional(), body: z.string().max(125_000).optional(), targetCommitish: z.string().trim().min(1).max(255).optional(), draft: z.boolean().optional(), prerelease: z.boolean().optional() }),
  z.object({ operation: z.literal("workflow.dispatch"), repository: repositorySchema, workflowId: z.union([z.string().trim().min(1).max(255), z.number().int()]), ref: z.string().trim().min(1).max(255), inputs: z.record(z.string(), z.string()).optional() }),
]);

export const emailRuntimeInputSchema = z.object({
  to: z.array(z.string().trim().email().max(320)).min(1).max(20),
  cc: z.array(z.string().trim().email().max(320)).max(20).optional(),
  bcc: z.array(z.string().trim().email().max(320)).max(20).optional(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().min(1).max(100_000),
  html: z.string().min(1).max(200_000).optional(),
}).superRefine((value, context) => {
  if (value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) > 20) {
    context.addIssue({ code: "custom", message: "Email supports at most 20 total recipients." });
  }
});

type HostedMutation = {
  appKey: "email" | "github" | "google_workspace" | "microsoft_365";
  capabilityKey: string;
  operationKey: string;
  resourceType: "sender" | "repository" | "calendar" | "account";
  resourceExternalId?: string;
  resourceLabel?: string;
  providerInput: Record<string, unknown>;
};

const githubTools = {
  "kestrel_one.github_issue_create": ["issue.create", "issue.write"],
  "kestrel_one.github_pull_request_create": ["pull_request.create", "pull_request.write"],
  "kestrel_one.github_pull_request_merge": ["pull_request.merge", "merge.write"],
  "kestrel_one.github_release_create": ["release.create", "release.write"],
  "kestrel_one.github_workflow_dispatch": ["workflow.dispatch", "workflow.dispatch"],
} as const;

const googleTools = {
  "kestrel_one.google_calendar_create_event": "events.create",
  "kestrel_one.google_calendar_update_event": "events.update",
  "kestrel_one.google_calendar_delete_event": "events.delete",
} as const;

const microsoftTools = {
  "kestrel_one.microsoft_365_send_mail": "mail.send",
  "kestrel_one.microsoft_365_send_chat_message": "chat.send",
} as const;

export function parseHostedMutation(toolName: string, toolInput: Record<string, unknown>): HostedMutation | null {
  if (toolName === "kestrel_one.email_send") {
    return { appKey: "email", capabilityKey: "send", operationKey: "email.send", resourceType: "sender", providerInput: emailRuntimeInputSchema.parse(toolInput) };
  }
  const github = githubTools[toolName as keyof typeof githubTools];
  if (github) {
    const providerInput = githubRuntimeActionInputSchema.parse({ operation: github[0], ...toolInput });
    return { appKey: "github", capabilityKey: github[1], operationKey: github[0], resourceType: "repository", resourceLabel: providerInput.repository, providerInput };
  }
  const googleOperation = googleTools[toolName as keyof typeof googleTools];
  if (googleOperation) {
    const providerInput = googleCalendarRuntimeInputSchema.parse({ operation: googleOperation, ...toolInput });
    return { appKey: "google_workspace", capabilityKey: capabilityForGoogleCalendarOperation(providerInput.operation), operationKey: googleOperation, resourceType: "calendar", resourceExternalId: "primary", providerInput };
  }
  const microsoftOperation = microsoftTools[toolName as keyof typeof microsoftTools];
  if (microsoftOperation) {
    const providerInput = microsoft365RuntimeInputSchema.parse({ operation: microsoftOperation, ...toolInput });
    return { appKey: "microsoft_365", capabilityKey: capabilityForMicrosoft365Operation(providerInput.operation), operationKey: microsoftOperation, resourceType: "account", resourceExternalId: "primary", providerInput };
  }
  return null;
}

export function isHostedMutationToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && (
    toolName === "kestrel_one.email_send" ||
    toolName in githubTools ||
    toolName in googleTools ||
    toolName in microsoftTools
  );
}
