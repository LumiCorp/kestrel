import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { AppCredentialPayload } from "./credential-crypto";
import { resolveEffectiveProjectAppAccess } from "./project-service";
import { resolveEnvironmentAppCredential } from "./service";

export class AppRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "AppRuntimeError";
    this.code = code;
    this.status = status;
  }
}

export async function authorizeAppRuntime(input: {
  ticket: EnvironmentExecutionTicket;
  appKey: string;
  capabilityKey: string;
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
    throw new AppRuntimeError("APP_RUNTIME_CONTEXT_DENIED");
  }
  const access = await resolveEffectiveProjectAppAccess({
    organizationId: ticket.organizationId,
    projectId: thread.projectId,
    appKey: input.appKey,
    userId: ticket.actorId,
  });
  if (!access || access.environmentId !== ticket.environmentId) {
    throw new AppRuntimeError("APP_RUNTIME_PROJECT_ACCESS_DENIED");
  }
  const capability = access.capabilities.find(
    (candidate) => candidate.key === input.capabilityKey
  );
  if (!capability) {
    throw new AppRuntimeError("APP_RUNTIME_CAPABILITY_DENIED");
  }
  if (capability.approvalMode === "ask" && input.approval !== "confirmed") {
    throw new AppRuntimeError("APP_RUNTIME_APPROVAL_REQUIRED", 409);
  }

  let credential: AppCredentialPayload | null = null;
  let connection: typeof schema.appConnections.$inferSelect | null = null;
  if (access.connectionId) {
    connection =
      (await knowledgeDb.query.appConnections.findFirst({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.id, access.connectionId ?? ""),
            equals(table.organizationId, ticket.organizationId),
            equals(table.appKey, input.appKey),
            inArray(table.status, ["connected", "degraded"])
          ),
      })) ?? null;
    if (!connection) {
      throw new AppRuntimeError("APP_RUNTIME_CONNECTION_DENIED");
    }
    if (
      (connection.ownerType === "environment" ||
        connection.ownerType === "deployment_managed") &&
      connection.credentialId
    ) {
      credential = await resolveEnvironmentAppCredential({
        organizationId: ticket.organizationId,
        environmentId: ticket.environmentId,
        appKey: input.appKey,
        connectionId: connection.id,
      });
    }
  }

  return {
    projectId: thread.projectId,
    connectionId: connection?.id ?? null,
    connection,
    capability,
    credential,
  };
}

export async function markAppConnectionDegraded(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  connectionId: string;
  failureCode: string;
  failureMessage?: string | null | undefined;
}) {
  const now = new Date();
  await knowledgeDb
    .update(schema.appConnections)
    .set({
      status: "degraded",
      failureCode: input.failureCode,
      failureMessage: input.failureMessage ?? null,
      lastHealthAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.appConnections.id, input.connectionId),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.environmentId, input.environmentId),
        eq(schema.appConnections.appKey, input.appKey),
        inArray(schema.appConnections.status, ["connected", "degraded"])
      )
    );
}

export async function markAppConnectionHealthy(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  connectionId: string;
}) {
  const now = new Date();
  await knowledgeDb
    .update(schema.appConnections)
    .set({
      status: "connected",
      failureCode: null,
      failureMessage: null,
      lastHealthAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.appConnections.id, input.connectionId),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.environmentId, input.environmentId),
        eq(schema.appConnections.appKey, input.appKey),
        inArray(schema.appConnections.status, ["connected", "degraded"])
      )
    );
}
