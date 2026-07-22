import "server-only";

import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, isNull, or } from "drizzle-orm";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  MICROSOFT_365_PROVIDER_KEY,
  type Microsoft365Capability,
  requiresMicrosoft365Approval,
} from "./microsoft-365-contract";

export class Microsoft365PolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "Microsoft365PolicyError";
    this.code = code;
    this.status = status;
  }
}

export async function authorizeMicrosoft365Capability(input: {
  ticket: EnvironmentExecutionTicket;
  capability: Microsoft365Capability;
}) {
  const { ticket } = input;
  const [environment, workspace, thread, execution] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, ticket.environmentId),
          eq(table.organizationId, ticket.organizationId)
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, ticket.workspaceId),
          eq(table.environmentId, ticket.environmentId),
          eq(table.organizationId, ticket.organizationId)
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.threads.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, ticket.threadId),
          eq(table.organizationId, ticket.organizationId)
        ),
      columns: { id: true, projectId: true },
    }),
    knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, ticket.runId),
          eq(table.organizationId, ticket.organizationId),
          eq(table.environmentId, ticket.environmentId),
          eq(table.workspaceId, ticket.workspaceId),
          eq(table.threadId, ticket.threadId),
          eq(table.actorId, ticket.actorId)
        ),
      columns: { id: true },
    }),
  ]);
  if (!(environment && workspace && thread?.projectId && execution)) {
    throw new Microsoft365PolicyError("MICROSOFT_365_CONTEXT_DENIED");
  }

  const [actorMembership, binding, access] = await Promise.all([
    knowledgeDb
      .select({ id: schema.projectMembers.organizationMemberId })
      .from(schema.projectMembers)
      .innerJoin(
        schema.members,
        and(
          eq(schema.members.id, schema.projectMembers.organizationMemberId),
          eq(schema.members.organizationId, ticket.organizationId),
          eq(schema.members.userId, ticket.actorId)
        )
      )
      .where(eq(schema.projectMembers.projectId, thread.projectId))
      .limit(1),
    knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.threadId, ticket.threadId),
          eq(table.organizationId, ticket.organizationId),
          eq(table.environmentId, ticket.environmentId),
          eq(table.workspaceId, ticket.workspaceId)
        ),
      columns: { threadId: true },
    }),
    resolveEffectiveProjectAppAccess({
      organizationId: ticket.organizationId,
      projectId: thread.projectId,
      appKey: MICROSOFT_365_PROVIDER_KEY,
      userId: ticket.actorId,
    }),
  ]);
  if (
    !(actorMembership[0] && binding && access) ||
    access.environmentId !== ticket.environmentId
  ) {
    throw new Microsoft365PolicyError("MICROSOFT_365_PROJECT_DENIED");
  }
  const capability = access.capabilities.find(
    (candidate) => candidate.key === input.capability
  );
  if (!(capability && access.connectionId)) {
    throw new Microsoft365PolicyError("MICROSOFT_365_CAPABILITY_DENIED");
  }
  const [connection, restrictions] = await Promise.all([
    knowledgeDb.query.appConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, access.connectionId as string),
          eq(table.organizationId, ticket.organizationId),
          eq(table.appKey, MICROSOFT_365_PROVIDER_KEY),
          eq(table.ownerType, "personal"),
          eq(table.userId, ticket.actorId),
          eq(table.status, "connected")
        ),
    }),
    knowledgeDb
      .select()
      .from(schema.environmentCapabilitySubjectRestrictions)
      .where(
        and(
          eq(
            schema.environmentCapabilitySubjectRestrictions.organizationId,
            ticket.organizationId
          ),
          eq(
            schema.environmentCapabilitySubjectRestrictions.environmentId,
            ticket.environmentId
          ),
          eq(
            schema.environmentCapabilitySubjectRestrictions.providerKey,
            MICROSOFT_365_PROVIDER_KEY
          ),
          eq(
            schema.environmentCapabilitySubjectRestrictions.capabilityKey,
            input.capability
          ),
          or(
            and(
              eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "actor"),
              eq(schema.environmentCapabilitySubjectRestrictions.subjectId, ticket.actorId)
            ),
            and(
              eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "agent"),
              eq(schema.environmentCapabilitySubjectRestrictions.subjectId, ticket.agentId)
            )
          ),
          isNull(schema.environmentCapabilitySubjectRestrictions.resourceId)
        )
      ),
  ]);
  if (!connection) {
    throw new Microsoft365PolicyError("MICROSOFT_365_CONNECTION_DENIED");
  }
  if (restrictions.some((restriction) => !restriction.enabled || restriction.approvalMode === "deny")) {
    throw new Microsoft365PolicyError("MICROSOFT_365_RESTRICTION_DENIED");
  }
  const modes = [
    capability.approvalMode,
    ...restrictions.map((restriction) => restriction.approvalMode),
    ...(requiresMicrosoft365Approval(input.capability) ? (["ask"] as const) : []),
  ];
  const approvalMode = modes.includes("deny")
    ? "deny"
    : modes.includes("ask")
      ? "ask"
      : "auto";
  if (approvalMode === "deny") {
    throw new Microsoft365PolicyError("MICROSOFT_365_CAPABILITY_DENIED");
  }
  return { connection, approvalMode, loggingMode: capability.loggingMode };
}
