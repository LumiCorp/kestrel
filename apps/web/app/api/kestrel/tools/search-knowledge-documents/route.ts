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
import { createHostedKnowledgeReadAuthority } from "@/lib/knowledge/documents/memory-policy";
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
    const scope = resolved.scope;
    const authority = createHostedKnowledgeReadAuthority({
      tenantId: resolved.organizationId,
      userId: resolved.userId,
      agentId: resolved.agentId,
      taskId: resolved.taskId,
      scope,
      documentAccess:
        resolved.documentIds === undefined
          ? { mode: "scope" }
          : { mode: "exact", documentIds: resolved.documentIds },
      issuer: {
        kind: "trusted_runtime",
        authorityId: "kestrel-one:runtime-capability",
      },
    });
    const result = await executeSearchKnowledgeDocumentsCapability({
      payload,
      ...authority,
      scope,
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
      environmentTicketPublicKey:
        process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    });
    if (!parsed.contextGrantId) {
      return {
        ...parsed,
        scope: { kind: "tenant" as const, tenantId: parsed.organizationId },
      };
    }
    const resolved = await resolveProjectContextGrant(parsed.contextGrantId);
    if (
      !resolved ||
      resolved.grant.organizationId !== parsed.organizationId ||
      resolved.grant.actorUserId !== parsed.userId
    ) {
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
      userId: parsed.userId,
      agentId: parsed.agentId,
      taskId: parsed.taskId,
      scope: {
        kind: "project" as const,
        tenantId: parsed.organizationId,
        projectId: resolved.grant.projectId,
      },
      documentIds: documents.map((document) => document.id),
    };
  }

  const active = await requireActiveOrganization();
  const taskId = crypto.randomUUID();
  return {
    organizationId: active.organizationId,
    userId: active.session.user.id,
    agentId: "kestrel-one:hosted-session",
    taskId,
    scope: { kind: "tenant" as const, tenantId: active.organizationId },
  };
}
