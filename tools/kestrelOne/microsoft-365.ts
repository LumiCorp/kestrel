import {
  createRuntimeFailure,
  RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import type {
  SharedToolContext,
  SharedToolDefinition,
  SharedToolModule,
} from "../contracts.js";
import { parseObjectInput } from "../helpers.js";

type Microsoft365Operation =
  | "mail.list"
  | "mail.send"
  | "calendar.list"
  | "chats.list"
  | "chat.send"
  | "sites.search";

function createMicrosoft365Tool(options: {
  name: string;
  displayName: string;
  description: string;
  operation: Microsoft365Operation;
  family: "outlook" | "teams" | "sharepoint";
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}): SharedToolModule {
  const definition: SharedToolDefinition = {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: options.readOnly ? "read_only" : "external_side_effect",
      ...(options.readOnly
        ? {}
        : { allowedInteractionModes: ["chat", "build"] as Array<"chat" | "build"> }),
      capabilityClasses: [`microsoft.${options.family}`, "network.call"],
      approvalCapabilities: [
        "network.call",
        ...(options.readOnly ? [] : (["external.confirm"] as const)),
      ],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: false,
        typicalFailureModes: [
          "microsoft_365_not_connected",
          "approval_required",
          "microsoft_365_unavailable",
        ],
      },
    },
    presentation: {
      displayName: options.displayName,
      aliases: [options.displayName.toLowerCase()],
      keywords: ["microsoft 365", options.family, options.operation],
      provider: "kestrel-one",
      toolFamily: options.family,
    },
  };
  return {
    definition,
    createHandler(context) {
      return async (input: unknown) =>
        invokeMicrosoft365(context, {
          operation: options.operation,
          input: parseObjectInput(options.name, input),
          requiresApproval: !options.readOnly,
          toolName: options.name,
        });
    },
  };
}

export const kestrelOneMicrosoft365ListMailTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_list_mail",
  displayName: "Microsoft 365 List Mail",
  description: "List recent messages from the connected user's Outlook mailbox.",
  operation: "mail.list",
  family: "outlook",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
    additionalProperties: false,
  },
});

export const kestrelOneMicrosoft365SendMailTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_send_mail",
  displayName: "Microsoft 365 Send Mail",
  description: "Send plain-text mail from the connected user's Outlook mailbox after approval.",
  operation: "mail.send",
  family: "outlook",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", format: "email" } },
      cc: { type: "array", maxItems: 50, items: { type: "string", format: "email" }, default: [] },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1, maxLength: 100_000 },
    },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  },
});

export const kestrelOneMicrosoft365ListEventsTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_list_events",
  displayName: "Microsoft 365 List Events",
  description: "List Outlook calendar events within a maximum 31-day window.",
  operation: "calendar.list",
  family: "outlook",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      timeMin: { type: "string", format: "date-time" },
      timeMax: { type: "string", format: "date-time" },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    required: ["timeMin", "timeMax"],
    additionalProperties: false,
  },
});

export const kestrelOneMicrosoft365ListChatsTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_list_chats",
  displayName: "Microsoft 365 List Teams Chats",
  description: "List the user's Teams chats, or list messages from one supplied chat ID.",
  operation: "chats.list",
  family: "teams",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", minLength: 1, maxLength: 512 },
      maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    additionalProperties: false,
  },
});

export const kestrelOneMicrosoft365SendChatMessageTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_send_chat_message",
  displayName: "Microsoft 365 Send Teams Message",
  description: "Send a plain-text message to an existing Teams chat after approval.",
  operation: "chat.send",
  family: "teams",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", minLength: 1, maxLength: 512 },
      content: { type: "string", minLength: 1, maxLength: 28_000 },
    },
    required: ["chatId", "content"],
    additionalProperties: false,
  },
});

export const kestrelOneMicrosoft365SearchSitesTool = createMicrosoft365Tool({
  name: "kestrel_one.microsoft_365_search_sites",
  displayName: "Microsoft 365 Find SharePoint Sites",
  description: "Find SharePoint sites available to the connected user.",
  operation: "sites.search",
  family: "sharepoint",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256 },
      maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
});

async function invokeMicrosoft365(
  context: SharedToolContext,
  input: {
    operation: Microsoft365Operation;
    input: Record<string, unknown>;
    requiresApproval: boolean;
    toolName: string;
  }
) {
  const appUrl = requireContextValue(context.kestrelOne?.appUrl, "KESTREL_ONE_APP_URL");
  const ticket = requireContextValue(
    context.kestrelOne?.executionTicket,
    "Environment execution ticket"
  );
  const approvalConfirmed =
    input.requiresApproval ||
    context.kestrelOne?.appApprovalModes?.[input.toolName] === "ask";
  const response = await (context.fetchImpl ?? fetch)(
    new URL("/api/runtime/microsoft-365/action", appUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
        ...(approvalConfirmed
          ? { "x-kestrel-runtime-approval": "confirmed" }
          : {}),
      },
      body: JSON.stringify({ operation: input.operation, ...input.input }),
    }
  );
  const body = parseObjectInput(
    `${input.toolName} response`,
    await response.json().catch(() => ({}))
  );
  if (!response.ok) {
    throw new RuntimeFailure(
      "KESTREL_ONE_MICROSOFT_365_ACTION_FAILED",
      `Kestrel One rejected ${input.toolName} with HTTP ${response.status}.`,
      {
        subsystem: "tooling",
        toolName: input.toolName,
        status: response.status,
        classification: response.status >= 500 ? "runtime" : "policy",
        recoverable: response.status >= 500 || response.status === 429,
      }
    );
  }
  return body;
}

function requireContextValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw createRuntimeFailure(
      "KESTREL_ONE_MICROSOFT_365_CONTEXT_MISSING",
      `${label} is required for Kestrel One Microsoft 365 tools.`,
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: true,
      }
    );
  }
  return value.trim();
}
