import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { resolveEffectiveProjectAppAccess } from "./project-service";
import { resolveEnvironmentAppCredential } from "./service";

export const TAVILY_RUNTIME_CAPABILITIES = [
  "search",
  "search_advanced",
  "news",
  "images",
  "extract",
  "crawl",
  "map",
  "research",
  "research_status",
  "usage",
] as const;

export type TavilyRuntimeCapability =
  (typeof TAVILY_RUNTIME_CAPABILITIES)[number];

export class TavilyRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "TavilyRuntimeError";
    this.code = code;
    this.status = status;
  }
}

export function assertTavilyProxyTarget(input: {
  capability: TavilyRuntimeCapability;
  method: string;
  path: string[];
}) {
  const method = input.method.toUpperCase();
  const singlePath: Partial<
    Record<TavilyRuntimeCapability, { method: "GET" | "POST"; path: string }>
  > = {
    search: { method: "POST", path: "search" },
    search_advanced: { method: "POST", path: "search" },
    news: { method: "POST", path: "search" },
    images: { method: "POST", path: "search" },
    extract: { method: "POST", path: "extract" },
    crawl: { method: "POST", path: "crawl" },
    map: { method: "POST", path: "map" },
    research: { method: "POST", path: "research" },
    usage: { method: "GET", path: "usage" },
  };
  const expected = singlePath[input.capability];
  if (
    expected &&
    method === expected.method &&
    input.path.length === 1 &&
    input.path[0] === expected.path
  ) {
    return;
  }
  if (
    input.capability === "research_status" &&
    method === "GET" &&
    input.path.length === 2 &&
    input.path[0] === "research" &&
    /^[A-Za-z0-9_-]{1,256}$/u.test(input.path[1] ?? "")
  ) {
    return;
  }
  throw new TavilyRuntimeError("TAVILY_PROXY_TARGET_DENIED", 404);
}

export async function authorizeTavilyRuntime(input: {
  ticket: EnvironmentExecutionTicket;
  capability: TavilyRuntimeCapability;
  approval: "auto" | "confirmed";
}) {
  const { ticket } = input;
  const [thread, execution] = await Promise.all([
    knowledgeDb.query.threads.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, ticket.threadId),
          equals(table.organizationId, ticket.organizationId)
        ),
      columns: { projectId: true },
    }),
    knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, ticket.runId),
          equals(table.organizationId, ticket.organizationId),
          equals(table.environmentId, ticket.environmentId),
          equals(table.workspaceId, ticket.workspaceId),
          equals(table.threadId, ticket.threadId),
          equals(table.actorId, ticket.actorId)
        ),
      columns: { id: true },
    }),
  ]);
  if (!(thread?.projectId && execution)) {
    throw new TavilyRuntimeError("TAVILY_RUNTIME_CONTEXT_DENIED");
  }
  const access = await resolveEffectiveProjectAppAccess({
    organizationId: ticket.organizationId,
    projectId: thread.projectId,
    appKey: "tavily",
    userId: ticket.actorId,
  });
  if (!access || access.environmentId !== ticket.environmentId) {
    throw new TavilyRuntimeError("TAVILY_PROJECT_ACCESS_DENIED");
  }
  const capability = access.capabilities.find(
    (candidate) => candidate.key === input.capability
  );
  if (!capability) {
    throw new TavilyRuntimeError("TAVILY_CAPABILITY_DENIED");
  }
  if (!access.connectionId) {
    throw new TavilyRuntimeError("TAVILY_CONNECTION_DENIED");
  }
  if (capability.approvalMode === "ask" && input.approval !== "confirmed") {
    throw new TavilyRuntimeError("TAVILY_APPROVAL_REQUIRED", 409);
  }
  const credential = await resolveEnvironmentAppCredential({
    organizationId: ticket.organizationId,
    environmentId: ticket.environmentId,
    appKey: "tavily",
    connectionId: access.connectionId,
  });
  if (credential.kind !== "api_key") {
    throw new TavilyRuntimeError("TAVILY_CREDENTIAL_INVALID");
  }
  return {
    projectId: thread.projectId,
    connectionId: access.connectionId,
    capability,
    credential,
  };
}

export async function markTavilyConnectionDegraded(input: {
  organizationId: string;
  environmentId: string;
  connectionId: string;
  failureCode: string;
}) {
  const now = new Date();
  await knowledgeDb
    .update(schema.appConnections)
    .set({
      status: "degraded",
      failureCode: input.failureCode,
      failureMessage: null,
      lastHealthAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.appConnections.id, input.connectionId),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.environmentId, input.environmentId),
        eq(schema.appConnections.appKey, "tavily")
      )
    );
}
