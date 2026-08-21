import {
  EnvironmentTicketError,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { z } from "zod";
import { routeIdSchema } from "@/lib/knowledge/validation";

const runnerCapabilityAuthHeaderSchema = z.string().regex(/^Bearer\s+\S+$/i);

export const runnerKnowledgeCapabilityRequestSchema = z.object({
  authorization: runnerCapabilityAuthHeaderSchema,
  tenantId: routeIdSchema,
  contextGrantId: z.string().uuid().optional(),
  userId: routeIdSchema.optional(),
  agentId: routeIdSchema.optional(),
  taskId: routeIdSchema.optional(),
});

export type KestrelOneCapabilityDescriptor = {
  name:
    | "kestrel.files.search"
    | "kestrel.files.open"
    | "kestrel_one.search_knowledge_documents";
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
    required: string[];
    properties: Record<string, Record<string, string | number>>;
  };
};

export function buildKestrelOneCapabilityDescriptors(input: {
  request: Request;
  threadId?: string | undefined;
}): KestrelOneCapabilityDescriptor[] {
  const origin = new URL(input.request.url).origin;

  return [
    ...(input.threadId ? [{
      name: "kestrel.files.search" as const,
      description:
        "Search files visible to this Thread through Thread, Project, and organization scope.",
      endpoint: {
        method: "POST" as const,
        url: `${origin}/api/kestrel/tools/files/search?threadId=${encodeURIComponent(input.threadId)}`,
        auth: {
          type: "bearer" as const,
          tokenEnv: "KESTREL_ONE_TOOL_TOKEN" as const,
        },
      },
      input: {
        type: "object" as const,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    }, {
      name: "kestrel.files.open" as const,
      description:
        "Open a visible Kestrel file as bounded extracted text or an authorized immutable source.",
      endpoint: {
        method: "POST" as const,
        url: `${origin}/api/kestrel/tools/files/open?threadId=${encodeURIComponent(input.threadId)}`,
        auth: {
          type: "bearer" as const,
          tokenEnv: "KESTREL_ONE_TOOL_TOKEN" as const,
        },
      },
      input: {
        type: "object" as const,
        required: ["fileId"],
        properties: {
          fileId: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    }] : []),
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
  environmentTicketPublicKey?: string | undefined;
}) {
  const parsed = runnerKnowledgeCapabilityRequestSchema.parse({
    authorization: input.request.headers.get("authorization") ?? "",
    tenantId:
      input.request.headers.get("x-kestrel-tenant-id") ??
      input.request.headers.get("x-organization-id") ??
      "",
    contextGrantId:
      input.request.headers.get("x-kestrel-project-context-grant") ?? undefined,
    userId: input.request.headers.get("x-kestrel-user-id") ?? undefined,
    agentId: input.request.headers.get("x-kestrel-agent-id") ?? undefined,
    taskId:
      input.request.headers.get("x-kestrel-task-id") ??
      input.request.headers.get("x-kestrel-run-id") ??
      undefined,
  });
  const actualToken = parsed.authorization.replace(/^Bearer\s+/i, "").trim();
  const expectedToken = input.expectedToken?.trim();

  if (expectedToken && actualToken === expectedToken) {
    if (!(parsed.userId && parsed.agentId && parsed.taskId)) {
      throw Object.assign(
        new Error("Trusted runtime memory identity is incomplete."),
        { code: "UNAUTHORIZED" }
      );
    }
    return {
      organizationId: parsed.tenantId,
      userId: parsed.userId,
      agentId: parsed.agentId,
      taskId: parsed.taskId,
      ...(parsed.contextGrantId
        ? { contextGrantId: parsed.contextGrantId }
        : {}),
    };
  }
  try {
    const ticket = verifyEnvironmentExecutionTicket({
      token: actualToken,
      publicKey: input.environmentTicketPublicKey ?? "",
    });
    if (
      ticket.organizationId !== parsed.tenantId ||
      !ticket.capabilities.includes("knowledge.search")
    ) {
      throw new Error("Environment knowledge capability denied.");
    }
    return {
      organizationId: ticket.organizationId,
      userId: ticket.actorId,
      agentId: ticket.agentId,
      taskId: ticket.runId,
      threadId: ticket.threadId,
      ...(parsed.contextGrantId
        ? { contextGrantId: parsed.contextGrantId }
        : {}),
    };
  } catch (error) {
    if (error instanceof EnvironmentTicketError) throw error;
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHORIZED" });
  }
}

export function assertRunnerFileThreadBinding(
  identity: object,
  requestedThreadId: string,
): void {
  const threadId = "threadId" in identity && typeof identity.threadId === "string"
    ? identity.threadId
    : undefined;
  if (threadId !== requestedThreadId) {
    throw Object.assign(new Error("Environment file capability is not valid for this Thread."), {
      code: "UNAUTHORIZED",
    });
  }
}
