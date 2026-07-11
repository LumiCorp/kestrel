import { z } from "zod";

const TOOL_NAME = "kestrel_one.search_knowledge_documents";

export type KestrelKnowledgeToolFailureClass =
  | "invalid_input"
  | "runtime_error"
  | "unauthorized";

export type KestrelKnowledgeToolAuditEvent = {
  tool: typeof TOOL_NAME;
  status: "failure" | "success";
  organizationId: string | null;
  tenantId: string | null;
  correlationId: string | null;
  requestId: string | null;
  queryLength: number | null;
  resultCount: number | null;
  latencyMs: number;
  failureClass: KestrelKnowledgeToolFailureClass | null;
};

type KnowledgeToolLogger = Pick<Console, "error" | "info">;

export function readKnowledgeToolRequestMetadata(request: Request) {
  const headers = request.headers;
  const tenantId =
    headers.get("x-kestrel-tenant-id") ?? headers.get("x-organization-id");

  return {
    tenantId,
    correlationId:
      headers.get("x-kestrel-correlation-id") ??
      headers.get("x-correlation-id"),
    requestId:
      headers.get("x-kestrel-request-id") ?? headers.get("x-request-id"),
  };
}

export function getKnowledgeToolQueryLength(payload: unknown) {
  if (
    payload &&
    typeof payload === "object" &&
    "query" in payload &&
    typeof payload.query === "string"
  ) {
    return payload.query.trim().length;
  }
  return null;
}

export function classifyKnowledgeToolFailure(
  error: unknown,
): KestrelKnowledgeToolFailureClass {
  if (error instanceof z.ZodError) {
    return "invalid_input";
  }

  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "UNAUTHORIZED"
  ) {
    return "unauthorized";
  }

  return "runtime_error";
}

export function buildKnowledgeToolAuditEvent(input: {
  status: "failure" | "success";
  organizationId?: string | null;
  tenantId?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
  queryLength?: number | null;
  resultCount?: number | null;
  latencyMs: number;
  failureClass?: KestrelKnowledgeToolFailureClass | null;
}): KestrelKnowledgeToolAuditEvent {
  return {
    tool: TOOL_NAME,
    status: input.status,
    organizationId: input.organizationId ?? null,
    tenantId: input.tenantId ?? null,
    correlationId: input.correlationId ?? null,
    requestId: input.requestId ?? null,
    queryLength: input.queryLength ?? null,
    resultCount: input.resultCount ?? null,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    failureClass: input.failureClass ?? null,
  };
}

export function logKnowledgeToolAuditEvent(
  event: KestrelKnowledgeToolAuditEvent,
  logger: KnowledgeToolLogger = console,
) {
  const message = "kestrel_one.search_knowledge_documents.audit";
  if (event.status === "failure") {
    logger.error(message, event);
    return;
  }
  logger.info(message, event);
}
