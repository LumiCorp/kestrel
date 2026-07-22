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

const definition: SharedToolDefinition = {
  name: "kestrel_one.email_send",
  description:
    "Send an external email from the organization's verified sender. Every message requires explicit human approval. Provide plain text, optionally provide HTML, and do not include attachments.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", format: "email", maxLength: 320 },
      },
      cc: {
        type: "array",
        maxItems: 20,
        items: { type: "string", format: "email", maxLength: 320 },
      },
      bcc: {
        type: "array",
        maxItems: 20,
        items: { type: "string", format: "email", maxLength: 320 },
      },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      text: { type: "string", minLength: 1, maxLength: 100_000 },
      html: { type: "string", minLength: 1, maxLength: 200_000 },
    },
    required: ["to", "subject", "text"],
    additionalProperties: false,
  },
  capability: {
    freshnessClass: "live",
    latencyClass: "medium",
    costClass: "metered",
    executionClass: "external_side_effect",
    allowedInteractionModes: ["chat", "build"],
    capabilityClasses: ["email.send", "network.call"],
    approvalCapabilities: ["network.call", "external.confirm"],
    suitability: {
      supportsAttribution: true,
      supportsAggregation: false,
      typicalFailureModes: [
        "email_not_configured",
        "approval_required",
        "provider_rejected",
      ],
    },
  },
  presentation: {
    displayName: "Send Email",
    aliases: ["email", "send email"],
    keywords: ["email", "message", "resend", "send"],
    provider: "kestrel-one",
    toolFamily: "communication",
  },
};

export const kestrelOneEmailSendTool: SharedToolModule = {
  definition,
  createHandler(context) {
    return async (value: unknown) => {
      const input = parseObjectInput(definition.name, value);
      const appUrl = requireContextValue(
        context.kestrelOne?.appUrl,
        "KESTREL_ONE_APP_URL"
      );
      const ticket = requireContextValue(
        context.kestrelOne?.executionTicket,
        "Environment execution ticket"
      );
      const approvalId = requireContextValue(
        context.runtime?.approvalId,
        "Runtime email approval ID"
      );
      const response = await (context.fetchImpl ?? fetch)(
        new URL("/api/runtime/email/action", appUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ticket}`,
            "content-type": "application/json",
            "x-kestrel-approval-id": approvalId,
          },
          body: JSON.stringify(input),
        }
      );
      const body = parseObjectInput(
        `${definition.name} response`,
        await response.json().catch(() => ({}))
      );
      if (!response.ok) {
        throw new RuntimeFailure(
          "KESTREL_ONE_EMAIL_SEND_FAILED",
          `Kestrel One rejected email.send with HTTP ${response.status}.`,
          {
            subsystem: "tooling",
            toolName: definition.name,
            status: response.status,
            classification: response.status >= 500 ? "runtime" : "policy",
            recoverable: response.status >= 500 || response.status === 429,
          }
        );
      }
      return body;
    };
  },
};

function requireContextValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw createRuntimeFailure(
      "KESTREL_ONE_EMAIL_CONTEXT_MISSING",
      `${label} is required for the Kestrel One Email App.`,
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: true,
      }
    );
  }
  return value.trim();
}
