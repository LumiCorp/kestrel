import "server-only";

import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  GOOGLE_WORKSPACE_PROVIDER_KEY,
  type GoogleCalendarCapability,
  intersectGoogleCalendarApprovalModes,
  requiresGoogleCalendarApproval,
} from "./google-calendar-contract";

export class GoogleCalendarPolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "GoogleCalendarPolicyError";
    this.code = code;
    this.status = status;
  }
}

export async function authorizeGoogleCalendarCapability(input: {
  ticket: EnvironmentExecutionTicket;
  capability: GoogleCalendarCapability;
  requireRunExecution?: boolean;
}) {
  const { ticket } = input;
  const [environment, workspace, thread] = await Promise.all([
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
  ]);
  if (!(environment && workspace && thread?.projectId)) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CONTEXT_DENIED");
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
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.threadId, ticket.threadId),
          equals(table.organizationId, ticket.organizationId),
          equals(table.environmentId, ticket.environmentId),
          equals(table.workspaceId, ticket.workspaceId)
        ),
      columns: { threadId: true },
    }),
    resolveEffectiveProjectAppAccess({
      organizationId: ticket.organizationId,
      projectId: thread.projectId,
      appKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
      userId: ticket.actorId,
    }),
  ]);
  if (
    !(actorMembership[0] && binding && access) ||
    access.environmentId !== ticket.environmentId
  ) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_PROJECT_DENIED");
  }
  if (input.requireRunExecution) {
    const execution =
      await knowledgeDb.query.environmentRunExecutions.findFirst({
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
      });
    if (!execution) {
      throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_RUN_DENIED");
    }
  }
  const capability = access.capabilities.find(
    (candidate) => candidate.key === input.capability
  );
  if (!capability) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CAPABILITY_DENIED");
  }
  if (!access.connectionId) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CONNECTION_DENIED");
  }
  const connectionId = access.connectionId;
  const [connection, subjectRestrictions] = await Promise.all([
    knowledgeDb.query.appConnections.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, connectionId),
          equals(table.organizationId, ticket.organizationId),
          equals(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
          equals(table.ownerType, "personal"),
          equals(table.userId, ticket.actorId),
          equals(table.status, "connected")
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
            GOOGLE_WORKSPACE_PROVIDER_KEY
          ),
          eq(
            schema.environmentCapabilitySubjectRestrictions.capabilityKey,
            input.capability
          ),
          or(
            and(
              eq(
                schema.environmentCapabilitySubjectRestrictions.subjectType,
                "actor"
              ),
              eq(
                schema.environmentCapabilitySubjectRestrictions.subjectId,
                ticket.actorId
              )
            ),
            and(
              eq(
                schema.environmentCapabilitySubjectRestrictions.subjectType,
                "agent"
              ),
              eq(
                schema.environmentCapabilitySubjectRestrictions.subjectId,
                ticket.agentId
              )
            )
          ),
          isNull(schema.environmentCapabilitySubjectRestrictions.resourceId)
        )
      ),
  ]);
  if (!connection) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CONNECTION_DENIED");
  }
  if (
    subjectRestrictions.some(
      (restriction) =>
        !restriction.enabled || restriction.approvalMode === "deny"
    )
  ) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_RESTRICTION_DENIED");
  }
  const approvalMode = intersectGoogleCalendarApprovalModes({
    environmentMode: capability.approvalMode,
    restrictionModes: subjectRestrictions.map(
      (restriction) => restriction.approvalMode
    ),
    writeRequiresApproval: requiresGoogleCalendarApproval(input.capability),
  });
  if (approvalMode === "deny") {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CAPABILITY_DENIED");
  }
  return {
    connection,
    projectId: thread.projectId,
    approvalMode,
    loggingMode: capability.loggingMode,
  };
}

export async function listGoogleCalendarAvailabilitySubjects(input: {
  projectId: string;
  organizationId: string;
  actorUserId: string;
}) {
  return knowledgeDb
    .select({
      subjectId: schema.projectAppUserCapabilities.id,
      connectionId: schema.appConnections.id,
      userId: schema.appConnections.userId,
      providerAccountId: schema.appConnections.externalAccountId,
      displayName: schema.users.name,
    })
    .from(schema.projectAppUserCapabilities)
    .innerJoin(
      schema.appConnections,
      and(
        eq(
          schema.appConnections.id,
          schema.projectAppUserCapabilities.connectionId
        ),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
        eq(schema.appConnections.ownerType, "personal"),
        eq(schema.appConnections.status, "connected")
      )
    )
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.userId, schema.appConnections.userId),
        eq(schema.members.organizationId, input.organizationId)
      )
    )
    .innerJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.organizationMemberId, schema.members.id),
        eq(schema.projectMembers.projectId, input.projectId)
      )
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.projectAppUserCapabilities.projectId, input.projectId),
        eq(
          schema.projectAppUserCapabilities.appKey,
          GOOGLE_WORKSPACE_PROVIDER_KEY
        ),
        eq(
          schema.projectAppUserCapabilities.capabilityKey,
          "calendar.availability.read"
        ),
        eq(schema.projectAppUserCapabilities.audience, "project"),
        eq(schema.projectAppUserCapabilities.enabled, true),
        ne(schema.appConnections.userId, input.actorUserId)
      )
    );
}

export async function authorizeGoogleCalendarAvailabilitySubjects(input: {
  ticket: EnvironmentExecutionTicket;
  subjectIds: string[];
  projectId: string;
}) {
  const available = await listGoogleCalendarAvailabilitySubjects({
    projectId: input.projectId,
    organizationId: input.ticket.organizationId,
    actorUserId: input.ticket.actorId,
  });
  const byId = new Map(
    available.map((subject) => [subject.subjectId, subject])
  );
  const resolved = input.subjectIds.map((subjectId) => byId.get(subjectId));
  if (resolved.some((subject) => !subject)) {
    throw new GoogleCalendarPolicyError(
      "GOOGLE_CALENDAR_AVAILABILITY_SUBJECT_DENIED"
    );
  }
  return resolved.filter((subject) => subject !== undefined);
}
