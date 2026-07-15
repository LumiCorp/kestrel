import { RuntimeFailure, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import { buildAgentToolSuccessResult } from "../toolResult.js";

const TOOL_NAME = "kestrel_one.search_knowledge_documents";

export const kestrelOneSearchKnowledgeDocumentsTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description: "Search Kestrel-One organization knowledge documents through the app capability endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 3, maxLength: 1000 },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "static",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["knowledge.search", "kestrel_one.knowledge"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: false,
        typicalFailureModes: ["app_unavailable", "unauthorized", "tenant_missing"],
      },
    },
    presentation: {
      displayName: "Kestrel-One Knowledge Search",
      aliases: ["kestrel one knowledge", "organization knowledge", "knowledge documents"],
      keywords: ["kestrel-one", "knowledge", "documents", "search", "retrieval"],
      provider: "kestrel-one",
      toolFamily: "knowledge",
    },
  },
  createHandler(context) {
    const fetchImpl = context.fetchImpl ?? fetch;

    return async (input: unknown) => {
      const payload = parseKestrelOneSearchKnowledgeDocumentsInput(input);
      const appUrl = readConfiguredString(context.kestrelOne?.appUrl, "KESTREL_ONE_APP_URL");
      const toolToken =
        context.kestrelOne?.executionTicket?.trim() ||
        readConfiguredString(context.kestrelOne?.toolToken, "KESTREL_ONE_TOOL_TOKEN");
      const tenantId = context.kestrelOne?.tenantId?.trim();

      if (!appUrl) {
        throw configurationFailure("KESTREL_ONE_APP_URL");
      }
      if (!toolToken) {
        throw configurationFailure("Environment execution ticket");
      }
      if (!tenantId) {
        throw createRuntimeFailure(
          "KESTREL_ONE_TOOL_TENANT_MISSING",
          "Kestrel-One knowledge search requires tenant context.",
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "configuration",
            recoverable: true,
          },
        );
      }

      const response = await fetchImpl(resolveCapabilityUrl(appUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${toolToken}`,
          "content-type": "application/json",
          "x-kestrel-tenant-id": tenantId,
          "x-organization-id": tenantId,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const message = await readResponseText(response);
        throw new RuntimeFailure(
          "KESTREL_ONE_TOOL_HTTP_FAILED",
          `Kestrel-One knowledge search failed with HTTP ${response.status}.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            status: response.status,
            statusText: response.statusText,
            message,
            classification: "runtime",
            recoverable: response.status >= 500,
          },
        );
      }

      const output = await response.json();
      return buildAgentToolSuccessResult({
        toolName: TOOL_NAME,
        input: payload,
        output,
        presentation: buildKnowledgePresentation(output),
      });
    };
  },
};

function buildKnowledgePresentation(value: unknown) {
  const root = asRecord(value);
  const results = Array.isArray(root?.results) ? root.results : [];
  return {
    citations: results.flatMap((raw) => {
      const result = asRecord(raw);
      const documentId = readString(result?.documentId);
      const title = readString(result?.title) ?? readString(result?.filename);
      const url = readString(result?.url);
      if (!(documentId && title)) return [];
      const excerpts = Array.isArray(result?.excerpts) ? result.excerpts : [];
      const firstExcerpt = asRecord(excerpts[0]);
      return [{
        id: `knowledge:${documentId}`,
        title,
        documentId,
        ...(url ? { url } : {}),
        ...(readString(firstExcerpt?.text)
          ? { excerpt: readString(firstExcerpt?.text) }
          : {}),
      }];
    }),
  };
}

export function parseKestrelOneSearchKnowledgeDocumentsInput(input: unknown): {
  query: string;
  limit?: number | undefined;
} {
  const record = asRecord(input);
  const query = typeof record?.query === "string" ? record.query.trim() : "";
  const limit = record?.limit;

  if (query.length < 3 || query.length > 1000) {
    throw new RuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      `Tool '${TOOL_NAME}' input failed schema validation.`,
      {
        subsystem: "tooling",
        toolName: TOOL_NAME,
        field: "query",
      },
    );
  }

  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 12)
  ) {
    throw new RuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      `Tool '${TOOL_NAME}' input failed schema validation.`,
      {
        subsystem: "tooling",
        toolName: TOOL_NAME,
        field: "limit",
      },
    );
  }

  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
  };
}

function resolveCapabilityUrl(appUrl: string): string {
  const base = appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
  return new URL("api/kestrel/tools/search-knowledge-documents", base).toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readConfiguredString(value: string | undefined, envName: string): string | undefined {
  const explicit = value?.trim();
  if (explicit) {
    return explicit;
  }
  const envValue = process.env[envName]?.trim();
  return envValue && envValue.length > 0 ? envValue : undefined;
}

function configurationFailure(envName: string) {
  return createRuntimeFailure(
    "KESTREL_ONE_TOOL_CONFIG_MISSING",
    `Kestrel-One knowledge search requires ${envName}.`,
    {
      subsystem: "tooling",
      toolName: TOOL_NAME,
      envName,
      classification: "configuration",
      recoverable: false,
    },
  );
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
