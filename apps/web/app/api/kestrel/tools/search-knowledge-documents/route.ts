import { NextResponse } from "next/server";
import { z } from "zod";
import { parseRunnerKnowledgeCapabilityRequest } from "@/lib/agent/kestrel-capabilities";
import { executeSearchKnowledgeDocumentsCapability } from "@/lib/agent/kestrel-knowledge-capability";
import {
  buildKnowledgeToolAuditEvent,
  classifyKnowledgeToolFailure,
  getKnowledgeToolQueryLength,
  logKnowledgeToolAuditEvent,
  readKnowledgeToolRequestMetadata,
} from "@/lib/agent/kestrel-knowledge-tool-observability";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestMetadata = readKnowledgeToolRequestMetadata(request);
  let organizationId: string | null = null;
  let queryLength: number | null = null;

  try {
    const resolved = await resolveCapabilityOrganization(request);
    const resolvedOrganizationId = resolved.organizationId;
    organizationId = resolvedOrganizationId;
    const payload = await request.json();
    queryLength = getKnowledgeToolQueryLength(payload);
    const result = await executeSearchKnowledgeDocumentsCapability({
      organizationId: resolvedOrganizationId,
      payload,
    });
    logKnowledgeToolAuditEvent(
      buildKnowledgeToolAuditEvent({
        status: "success",
        organizationId,
        ...requestMetadata,
        queryLength,
        resultCount: result.count,
        latencyMs: Date.now() - startedAt,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    logKnowledgeToolAuditEvent(
      buildKnowledgeToolAuditEvent({
        status: "failure",
        organizationId,
        ...requestMetadata,
        queryLength,
        resultCount: null,
        latencyMs: Date.now() - startedAt,
        failureClass: classifyKnowledgeToolFailure(error),
      }),
    );

    if (error instanceof z.ZodError) {
      return NextResponse.json({ errors: error.flatten() }, { status: 400 });
    }

    return errorResponse(error, 400);
  }
}

async function resolveCapabilityOrganization(request: Request) {
  if (request.headers.has("authorization")) {
    return parseRunnerKnowledgeCapabilityRequest({
      request,
      expectedToken: process.env.KESTREL_ONE_TOOL_TOKEN,
    });
  }

  return requireActiveOrganization();
}
