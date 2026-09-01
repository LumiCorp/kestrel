import { RuntimeFailure, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import { throwIfExecutionAuthorizationRejected } from "./authorizationError.js";
import { resolveKestrelOneAppRequest } from "./appTransport.js";

const TOOL_NAME = "kestrel_one.email_get_attachment";

export const kestrelOneEmailGetAttachmentTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description: "Read one attachment from the email that created this Thread. The attachment ID must come from that email's attachment list.",
    inputSchema: {
      type: "object",
      properties: {
        attachmentId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["attachmentId"],
      additionalProperties: false,
    },
    resultNormalizerId: "kestrel.email-attachment:v1",
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["kestrel_one.email_attachment"],
      suitability: {
        supportsAttribution: false,
        supportsAggregation: false,
        typicalFailureModes: ["attachment_unavailable", "authorization_denied"],
      },
    },
    presentation: {
      displayName: "Email Attachment",
      aliases: ["email attachment", "received attachment"],
      keywords: ["email", "attachment", "invoice", "receipt"],
      provider: "kestrel-one",
      toolFamily: "email",
    },
  },
  createHandler(context) {
    const fetchImpl = context.fetchImpl ?? fetch;
    return async (input: unknown) => {
      const payload = parseEmailGetAttachmentInput(input);
      const tenantId = context.kestrelOne?.tenantId?.trim();
      if (!tenantId) {
        throw createRuntimeFailure(
          "KESTREL_ONE_TOOL_TENANT_MISSING",
          "Email attachment access requires tenant context.",
          { subsystem: "tooling", toolName: TOOL_NAME, classification: "configuration", recoverable: true },
        );
      }
      const transport = resolveKestrelOneAppRequest(
        context,
        "/api/kestrel/tools/email/get-attachment",
      );
      const response = await fetchImpl(transport.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${transport.authorization}`,
          "content-type": "application/json",
          "x-kestrel-tenant-id": tenantId,
          "x-organization-id": tenantId,
        },
        body: JSON.stringify(payload),
      });
      await throwIfExecutionAuthorizationRejected({ response, toolName: TOOL_NAME });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as
          | { error?: { code?: unknown; retryable?: unknown } }
          | null;
        const code = typeof body?.error?.code === "string"
          ? body.error.code
          : "EMAIL_ATTACHMENT_UNAVAILABLE";
        throw new RuntimeFailure(
          "KESTREL_ONE_EMAIL_ATTACHMENT_FAILED",
          `Email attachment access failed: ${code}.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            status: response.status,
            classification: "runtime",
            recoverable: body?.error?.retryable === true || response.status >= 500,
          },
        );
      }
      return { output: await response.json(), presentation: { citations: [] } };
    };
  },
  normalizeResult(value) {
    if (!(value && typeof value === "object" && "output" in value)) {
      throw createRuntimeFailure(
        "TOOL_RESULT_NORMALIZATION_FAILED",
        "Email attachment access returned an invalid result.",
        { recoverable: false, toolName: TOOL_NAME },
      );
    }
    return { output: (value as { output: unknown }).output };
  },
};

export function parseEmailGetAttachmentInput(input: unknown): { attachmentId: string } {
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const attachmentId = typeof record?.attachmentId === "string"
    ? record.attachmentId.trim()
    : "";
  if (!attachmentId || attachmentId.length > 200 || Object.keys(record ?? {}).length !== 1) {
    throw new RuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      `Tool '${TOOL_NAME}' input failed schema validation.`,
      { subsystem: "tooling", toolName: TOOL_NAME, field: "attachmentId" },
    );
  }
  return { attachmentId };
}
