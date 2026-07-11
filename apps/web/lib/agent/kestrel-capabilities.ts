import { z } from "zod";
import { routeIdSchema } from "@/lib/knowledge/validation";

const runnerCapabilityAuthHeaderSchema = z
  .string()
  .regex(/^Bearer\s+\S+$/i);

export const runnerKnowledgeCapabilityRequestSchema = z.object({
  authorization: runnerCapabilityAuthHeaderSchema,
  tenantId: routeIdSchema,
});

export type KestrelOneCapabilityDescriptor = {
  name: "kestrel_one.search_knowledge_documents";
  description: string;
  endpoint: {
    method: "POST";
    url: string;
      auth: {
        type: "bearer";
        tokenEnv: "KESTREL_ONE_TOOL_TOKEN";
      };
  };
  input: {
    type: "object";
    required: ["query"];
    properties: {
      query: { type: "string"; minLength: 3; maxLength: 1000 };
      limit: { type: "integer"; minimum: 1; maximum: 12 };
    };
  };
};

export function buildKestrelOneCapabilityDescriptors(input: {
  request: Request;
}): KestrelOneCapabilityDescriptor[] {
  const origin = new URL(input.request.url).origin;

  return [
    {
      name: "kestrel_one.search_knowledge_documents",
      description:
        "Search Kestrel-One organization knowledge documents with schema-validated input.",
      endpoint: {
        method: "POST",
        url: `${origin}/api/kestrel/tools/search-knowledge-documents`,
          auth: {
            type: "bearer",
            tokenEnv: "KESTREL_ONE_TOOL_TOKEN",
          },
      },
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 3, maxLength: 1000 },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
      },
    },
  ];
}

export function parseRunnerKnowledgeCapabilityRequest(input: {
  request: Request;
  expectedToken: string | undefined;
}) {
  const parsed = runnerKnowledgeCapabilityRequestSchema.parse({
    authorization: input.request.headers.get("authorization") ?? "",
    tenantId:
      input.request.headers.get("x-kestrel-tenant-id") ??
      input.request.headers.get("x-organization-id") ??
      "",
  });
  const actualToken = parsed.authorization.replace(/^Bearer\s+/i, "").trim();
  const expectedToken = input.expectedToken?.trim();

  if (!expectedToken || actualToken !== expectedToken) {
    throw Object.assign(new Error("Unauthorized"), {
      code: "UNAUTHORIZED",
    });
  }

  return {
    organizationId: parsed.tenantId,
  };
}
