import {
  createRuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import type {
  Microsoft365Operation,
} from "../../src/apps/microsoft365.js";
import type {
  SharedToolContext,
  SharedToolDefinition,
  SharedToolModule,
} from "../contracts.js";
import { parseObjectInput } from "../helpers.js";

function createMicrosoft365DesktopTool(options: {
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
      ...(options.readOnly ? {} : { allowedInteractionModes: ["chat", "build"] }),
      capabilityClasses: [`microsoft.${options.family}`, "network.call"],
      approvalCapabilities: [
        "network.call",
        ...(options.readOnly ? [] : (["external.confirm"] as const)),
      ],
    },
    presentation: {
      displayName: options.displayName,
      aliases: [options.displayName.toLowerCase()],
      keywords: ["microsoft 365", options.family, options.operation],
      provider: "microsoft-graph",
      toolFamily: options.family,
    },
  };
  return {
    definition,
    createHandler(context) {
      return async (input: unknown) => {
        if (context.microsoft365Service === undefined) {
          throw createRuntimeFailure(
            "MICROSOFT_365_NOT_CONNECTED",
            "Microsoft 365 is not connected in Kestrel Desktop.",
            {
              subsystem: "tooling",
              classification: "configuration",
              recoverable: true,
            },
          );
        }
        return await context.microsoft365Service.invoke(
          options.operation,
          parseObjectInput(options.name, input),
        );
      };
    },
  };
}

export const microsoft365ListMailTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.list_mail",
  displayName: "Microsoft 365 List Mail",
  description: "List recent messages from the connected user's Outlook mailbox.",
  operation: "mail.list",
  family: "outlook",
  readOnly: true,
  inputSchema: { type: "object", properties: { maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
});

export const microsoft365SendMailTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.send_mail",
  displayName: "Microsoft 365 Send Mail",
  description: "Send plain-text mail from the connected user's Outlook mailbox after approval.",
  operation: "mail.send",
  family: "outlook",
  readOnly: false,
  inputSchema: { type: "object", properties: { to: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", format: "email" } }, cc: { type: "array", maxItems: 50, items: { type: "string", format: "email" }, default: [] }, subject: { type: "string", minLength: 1, maxLength: 998 }, body: { type: "string", minLength: 1, maxLength: 100000 } }, required: ["to", "subject", "body"], additionalProperties: false },
});

export const microsoft365ListEventsTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.list_events",
  displayName: "Microsoft 365 List Events",
  description: "List Outlook calendar events within a bounded time window.",
  operation: "calendar.list",
  family: "outlook",
  readOnly: true,
  inputSchema: { type: "object", properties: { timeMin: { type: "string", format: "date-time" }, timeMax: { type: "string", format: "date-time" }, maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, required: ["timeMin", "timeMax"], additionalProperties: false },
});

export const microsoft365ListChatsTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.list_chats",
  displayName: "Microsoft 365 List Teams Chats",
  description: "List Teams chats or messages from one supplied chat ID.",
  operation: "chats.list",
  family: "teams",
  readOnly: true,
  inputSchema: { type: "object", properties: { chatId: { type: "string", minLength: 1, maxLength: 512 }, maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
});

export const microsoft365SendChatMessageTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.send_chat_message",
  displayName: "Microsoft 365 Send Teams Message",
  description: "Send a plain-text message to an existing Teams chat after approval.",
  operation: "chat.send",
  family: "teams",
  readOnly: false,
  inputSchema: { type: "object", properties: { chatId: { type: "string", minLength: 1, maxLength: 512 }, content: { type: "string", minLength: 1, maxLength: 28000 } }, required: ["chatId", "content"], additionalProperties: false },
});

export const microsoft365SearchSitesTool = createMicrosoft365DesktopTool({
  name: "microsoft_365.search_sites",
  displayName: "Microsoft 365 Find SharePoint Sites",
  description: "Find SharePoint sites available to the connected user.",
  operation: "sites.search",
  family: "sharepoint",
  readOnly: true,
  inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 256 }, maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, required: ["query"], additionalProperties: false },
});
