import { googleWorkspaceOperationDescriptor } from "../../src/apps/googleWorkspace.js";
import { createRuntimeFailure, RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext, SharedToolDefinition, SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import { throwIfExecutionAuthorizationRejected } from "./authorizationError.js";
import { resolveKestrelOneAppRequest } from "./appTransport.js";

type GmailReadOperation = "gmail.messages.search" | "gmail.messages.get" | "gmail.threads.get" | "gmail.attachments.import";
type GmailWriteOperation = "gmail.messages.send" | "gmail.messages.reply";
type GmailOperation = GmailReadOperation | GmailWriteOperation;

function createGmailReadTool(input: {
  name: string;
  displayName: string;
  description: string;
  operation: GmailReadOperation;
  inputSchema: Record<string, unknown>;
}): SharedToolModule {
  const operation = googleWorkspaceOperationDescriptor(input.operation);
  if (operation.hostedToolName !== input.name || operation.sideEffect !== "read") {
    throw new Error(`Gmail tool '${input.name}' must match its canonical read operation.`);
  }
  const definition: SharedToolDefinition = {
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    capability: {
      freshnessClass: "live", latencyClass: "medium", costClass: "free", executionClass: "read_only",
      capabilityClasses: ["google.gmail", "network.call"], approvalCapabilities: ["network.call"],
      suitability: { supportsAttribution: true, supportsAggregation: false, typicalFailureModes: ["gmail_not_connected", "gmail_restricted_data_route_unqualified", "gmail_unavailable"] },
    },
    presentation: { displayName: input.displayName, aliases: [input.displayName.toLowerCase()], keywords: ["gmail", "google", input.operation], provider: "kestrel-one", toolFamily: "gmail" },
  };
  return {
    definition,
    createHandler(context) {
      return async (value: unknown) => invokeGmail(context, {
        toolName: input.name,
        operation: input.operation,
        input: parseObjectInput(input.name, value),
        requiresApproval: false,
        minimumApprovalMode: operation.minimumApprovalMode,
      });
    },
  };
}

function createGmailWriteTool(input: {
  name: string;
  displayName: string;
  description: string;
  operation: GmailWriteOperation;
  inputSchema: Record<string, unknown>;
}): SharedToolModule {
  const operation = googleWorkspaceOperationDescriptor(input.operation);
  if (
    operation.hostedToolName !== input.name ||
    operation.sideEffect !== "external_side_effect" ||
    operation.minimumApprovalMode !== "ask"
  ) {
    throw new Error(`Gmail tool '${input.name}' must match its canonical write operation.`);
  }
  const definition: SharedToolDefinition = {
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    capability: {
      freshnessClass: "live", latencyClass: "medium", costClass: "free", executionClass: "external_side_effect",
      allowedInteractionModes: ["chat", "build"],
      capabilityClasses: ["google.gmail", "network.call"],
      approvalCapabilities: ["network.call", "external.confirm"],
      suitability: { supportsAttribution: true, supportsAggregation: false, typicalFailureModes: ["gmail_not_connected", "approval_required", "gmail_unavailable"] },
    },
    presentation: { displayName: input.displayName, aliases: [input.displayName.toLowerCase()], keywords: ["gmail", "google", input.operation], provider: "kestrel-one", toolFamily: "gmail" },
  };
  return {
    definition,
    createHandler(context) {
      return async (value: unknown) => invokeGmail(context, {
        toolName: input.name,
        operation: input.operation,
        input: parseObjectInput(input.name, value),
        requiresApproval: true,
        minimumApprovalMode: operation.minimumApprovalMode,
      });
    },
  };
}

export const kestrelOneGmailSearchMessagesTool = createGmailReadTool({
  name: "kestrel_one.gmail_search_messages",
  displayName: "Gmail Search Messages",
  description: "Search the connected user's Gmail with the exact native Gmail query provided. Attachment bytes are never returned.",
  operation: "gmail.messages.search",
  inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 4096 }, cursor: { type: "string", minLength: 1, maxLength: 4096 }, maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, required: ["query"], additionalProperties: false },
});
export const kestrelOneGmailGetMessageTool = createGmailReadTool({
  name: "kestrel_one.gmail_get_message",
  displayName: "Gmail Get Message",
  description: "Read one selected Gmail message. Attachment metadata is returned, never attachment bytes.",
  operation: "gmail.messages.get",
  inputSchema: { type: "object", properties: { messageId: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["messageId"], additionalProperties: false },
});
export const kestrelOneGmailGetThreadTool = createGmailReadTool({
  name: "kestrel_one.gmail_get_thread",
  displayName: "Gmail Get Thread",
  description: "Read one selected native Gmail thread. Attachment metadata is returned, never attachment bytes.",
  operation: "gmail.threads.get",
  inputSchema: { type: "object", properties: { threadId: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["threadId"], additionalProperties: false },
});
export const kestrelOneGmailImportAttachmentTool = createGmailReadTool({
  name: "kestrel_one.gmail_import_attachment",
  displayName: "Gmail Import Attachment",
  description: "Import one selected Gmail attachment into the current Thread file store. This is the only Gmail operation that retrieves attachment bytes.",
  operation: "gmail.attachments.import",
  inputSchema: { type: "object", properties: { messageId: { type: "string", minLength: 1, maxLength: 1024 }, attachmentId: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["messageId", "attachmentId"], additionalProperties: false },
});

export const kestrelOneGmailSendMessageTool = createGmailWriteTool({
  name: "kestrel_one.gmail_send_message",
  displayName: "Gmail Send Message",
  description: "Send a Gmail message after approval of the exact recipients, content, and Thread attachments.",
  operation: "gmail.messages.send",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", format: "email" } },
      cc: { type: "array", maxItems: 50, items: { type: "string", format: "email" }, default: [] },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      text: { type: "string", minLength: 1, maxLength: 100_000 },
      html: { type: "string", minLength: 1, maxLength: 200_000 },
      attachmentFileIds: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1024 }, default: [] },
    },
    required: ["to", "subject", "text"],
    additionalProperties: false,
  },
});

export const kestrelOneGmailReplyMessageTool = createGmailWriteTool({
  name: "kestrel_one.gmail_reply_message",
  displayName: "Gmail Reply Message",
  description: "Reply to a selected Gmail message after approval. Gmail supplies the reply target, recipients, subject, and thread headers.",
  operation: "gmail.messages.reply",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 1, maxLength: 1024 },
      text: { type: "string", minLength: 1, maxLength: 100_000 },
      html: { type: "string", minLength: 1, maxLength: 200_000 },
      attachmentFileIds: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1024 }, default: [] },
    },
    required: ["messageId", "text"],
    additionalProperties: false,
  },
});

async function invokeGmail(context: SharedToolContext, input: {
  toolName: string;
  operation: GmailOperation;
  input: Record<string, unknown>;
  requiresApproval: boolean;
  minimumApprovalMode: "auto" | "ask";
}) {
  const transport = resolveKestrelOneAppRequest(context, "/api/runtime/gmail/action");
  const explicitApprovalMode = context.kestrelOne?.appApprovalModes?.[input.toolName];
  const approvalRequired =
    input.minimumApprovalMode === "ask" ||
    explicitApprovalMode === "ask" ||
    (explicitApprovalMode === undefined && input.requiresApproval);
  const approvalId = approvalRequired
    ? requireContextValue(context.runtime?.approvalId, "Runtime Gmail approval ID")
    : undefined;
  const response = await (context.fetchImpl ?? fetch)(transport.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${transport.authorization}`,
      "content-type": "application/json",
      ...(approvalId ? { "x-kestrel-approval-id": approvalId } : {}),
    },
    body: JSON.stringify({ operation: input.operation, ...input.input }),
  });
  const body = parseObjectInput(`${input.toolName} response`, await response.json().catch(() => ({})));
  await throwIfExecutionAuthorizationRejected({ response, body, toolName: input.toolName });
  if (!response.ok) throw new RuntimeFailure("KESTREL_ONE_GMAIL_ACTION_FAILED", `Kestrel One rejected ${input.toolName} with HTTP ${response.status}.`, { subsystem: "tooling", toolName: input.toolName, status: response.status, classification: response.status >= 500 ? "runtime" : "policy", recoverable: response.status >= 500 || response.status === 429 });
  return body;
}

function requireContextValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw createRuntimeFailure(
      "KESTREL_ONE_GMAIL_CONTEXT_MISSING",
      `${label} is required for Kestrel One Gmail tools.`,
      { subsystem: "tooling", classification: "configuration", recoverable: true },
    );
  }
  return value.trim();
}
