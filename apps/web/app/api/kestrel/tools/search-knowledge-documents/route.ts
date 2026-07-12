import { eq } from "drizzle-orm";
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
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { resolveProjectContextGrant } from "@/lib/projects/context-grants";

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
      documentIds: resolved.documentIds,
    });
    logKnowledgeToolAuditEvent(
      buildKnowledgeToolAuditEvent({
        status: "success",
        organizationId,
        ...requestMetadata,
        queryLength,
        resultCount: result.count,
        latencyMs: Date.now() - startedAt,
      })
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
      })
    );

    if (error instanceof z.ZodError) {
      return NextResponse.json({ errors: error.flatten() }, { status: 400 });
    }

    return errorResponse(error, 400);
  }
}

async function resolveCapabilityOrganization(request: Request) {
  if (request.headers.has("authorization")) {
    const parsed = parseRunnerKnowledgeCapabilityRequest({
      request,
      expectedToken: process.env.KESTREL_ONE_TOOL_TOKEN,
    });
    if (!parsed.contextGrantId) {
      return { organizationId: parsed.organizationId };
    }
    const resolved = await resolveProjectContextGrant(parsed.contextGrantId);
    if (!resolved || resolved.grant.organizationId !== parsed.organizationId) {
      throw Object.assign(new Error("Project context grant is invalid."), {
        code: "UNAUTHORIZED",
      });
    }
    const documents = await knowledgeDb
      .select({ id: schema.projectContextDocuments.documentId })
      .from(schema.projectContextDocuments)
      .where(
        eq(
          schema.projectContextDocuments.contextRevisionId,
          resolved.grant.contextRevisionId
        )
      );
    return {
      organizationId: parsed.organizationId,
      documentIds: documents.map((document) => document.id),
    };
  }

  const active = await requireActiveOrganization();
  return { organizationId: active.organizationId };
}
