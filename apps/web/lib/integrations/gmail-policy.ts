import "server-only";

import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, isNull, or } from "drizzle-orm";
import { parseModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration.js";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  admitGmailRestrictedData,
  readGmailRestrictedDataRouteEvidence,
} from "./gmail-restricted-data-admission";
import { GOOGLE_WORKSPACE_PROVIDER_KEY } from "./google-calendar-contract";
import type { GmailCapability } from "./gmail-contract";

export class GmailPolicyError extends Error {
  constructor(readonly code: string, readonly status = 403) {
    super(code);
    this.name = "GmailPolicyError";
  }
}

/** Project/connection/subject gate. Model-route admission is checked separately below. */
export async function authorizeGmailCapability(input: {
  ticket: EnvironmentExecutionTicket;
  capability: GmailCapability;
}) {
  const { ticket } = input;
  const [environment, workspace, thread] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, ticket.environmentId), eq(table.organizationId, ticket.organizationId)),
      columns: { id: true },
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, ticket.workspaceId), eq(table.environmentId, ticket.environmentId), eq(table.organizationId, ticket.organizationId)),
      columns: { id: true },
    }),
    knowledgeDb.query.threads.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, ticket.threadId), eq(table.organizationId, ticket.organizationId)),
      columns: { id: true, projectId: true },
    }),
  ]);
  if (!(environment && workspace && thread?.projectId)) {
    throw new GmailPolicyError("GMAIL_CONTEXT_DENIED");
  }
  const [membership, binding, execution, access] = await Promise.all([
    knowledgeDb.select({ id: schema.projectMembers.organizationMemberId }).from(schema.projectMembers).innerJoin(
      schema.members,
      and(eq(schema.members.id, schema.projectMembers.organizationMemberId), eq(schema.members.organizationId, ticket.organizationId), eq(schema.members.userId, ticket.actorId)),
    ).where(eq(schema.projectMembers.projectId, thread.projectId)).limit(1),
    knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, { and, eq }) => and(eq(table.threadId, ticket.threadId), eq(table.organizationId, ticket.organizationId), eq(table.environmentId, ticket.environmentId), eq(table.workspaceId, ticket.workspaceId)),
      columns: { threadId: true },
    }),
    knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, ticket.runId), eq(table.organizationId, ticket.organizationId), eq(table.environmentId, ticket.environmentId), eq(table.workspaceId, ticket.workspaceId), eq(table.threadId, ticket.threadId), eq(table.actorId, ticket.actorId)),
      columns: { id: true },
    }),
    resolveEffectiveProjectAppAccess({ organizationId: ticket.organizationId, projectId: thread.projectId, appKey: GOOGLE_WORKSPACE_PROVIDER_KEY, userId: ticket.actorId }),
  ]);
  if (!(membership[0] && binding && execution && access) || access.environmentId !== ticket.environmentId) {
    throw new GmailPolicyError("GMAIL_PROJECT_DENIED");
  }
  const capability = access.capabilities.find((candidate) => candidate.key === input.capability);
  if (!capability || !access.connectionId) throw new GmailPolicyError("GMAIL_CAPABILITY_DENIED");
  const [connection, restrictions] = await Promise.all([
    knowledgeDb.query.appConnections.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, access.connectionId!), eq(table.organizationId, ticket.organizationId), eq(table.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY), eq(table.ownerType, "personal"), eq(table.userId, ticket.actorId), eq(table.status, "connected")),
    }),
    knowledgeDb.select().from(schema.environmentCapabilitySubjectRestrictions).where(and(
      eq(schema.environmentCapabilitySubjectRestrictions.organizationId, ticket.organizationId),
      eq(schema.environmentCapabilitySubjectRestrictions.environmentId, ticket.environmentId),
      eq(schema.environmentCapabilitySubjectRestrictions.providerKey, GOOGLE_WORKSPACE_PROVIDER_KEY),
      eq(schema.environmentCapabilitySubjectRestrictions.capabilityKey, input.capability),
      or(
        and(eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "actor"), eq(schema.environmentCapabilitySubjectRestrictions.subjectId, ticket.actorId)),
        and(eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "agent"), eq(schema.environmentCapabilitySubjectRestrictions.subjectId, ticket.agentId)),
      ),
      isNull(schema.environmentCapabilitySubjectRestrictions.resourceId),
    )),
  ]);
  if (!connection) throw new GmailPolicyError("GMAIL_CONNECTION_DENIED");
  if (restrictions.some((restriction) => !restriction.enabled || restriction.approvalMode === "deny")) {
    throw new GmailPolicyError("GMAIL_RESTRICTION_DENIED");
  }
  return { connection, projectId: thread.projectId, loggingMode: capability.loggingMode };
}

/**
 * The active run identifies the sole model route that can receive this tool
 * result. A missing exact registration/evidence fails closed before Gmail.
 */
export async function admitGmailExecutionRoute(input: {
  ticket: EnvironmentExecutionTicket;
  projectAuthorized: boolean;
  gmailReadonlyGranted: boolean;
}) {
  const grant = await knowledgeDb.query.environmentModelGrants.findFirst({
    where: (table, { and, eq }) => and(eq(table.runId, input.ticket.runId), eq(table.organizationId, input.ticket.organizationId), eq(table.environmentId, input.ticket.environmentId), eq(table.workspaceId, input.ticket.workspaceId), eq(table.threadId, input.ticket.threadId), eq(table.status, "active")),
    columns: { gatewayModelId: true },
  });
  const model = grant?.gatewayModelId ? await knowledgeDb.query.aiGatewayModels.findFirst({
    where: (table, { and, eq }) => and(eq(table.id, grant.gatewayModelId!), eq(table.organizationId, input.ticket.organizationId)),
    columns: { metadata: true },
  }) : undefined;
  let primaryRoute: ReturnType<typeof readGmailRestrictedDataRouteEvidence>;
  try {
    const metadata = model?.metadata;
    const registration = parseModelRegistrationV2(
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).kestrelModelRegistrationV2
        : undefined,
    );
    primaryRoute = readGmailRestrictedDataRouteEvidence({ metadata, registration });
  } catch {
    primaryRoute = undefined;
  }
  const admission = admitGmailRestrictedData({
    projectAuthorized: input.projectAuthorized,
    gmailReadonlyGranted: input.gmailReadonlyGranted,
    primaryRoute,
    // Environment model grants pin one exact qualified route for one run.
    fallbackRoutes: [],
  });
  if (!admission.allowed) throw new GmailPolicyError(admission.code);
}
