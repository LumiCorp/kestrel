import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  ENVIRONMENT_TICKET_MAX_TTL_SECONDS,
  getDesktopEnvironmentExecutionTarget,
  getFlyEnvironmentExecutionTarget,
  getGatewayEnvironmentExecutionTarget,
  signEnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicketForRenewal,
  type EnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { refreshProjectContextGrant } from "@/lib/projects/context-grants";
import {
  digestHostedMcpRunPolicyEvidence,
  resolveHostedMcpRunPolicy,
} from "@/lib/mcp/grant-service";
import { resolveHostedRoutingAuthority } from "./routing-authority";

export const EXECUTION_AUTHORIZATION_RENEWAL_VERSION =
  "execution-authorization-renewal-v1" as const;
export const EXECUTION_AUTHORIZATION_RENEW_AFTER_SECONDS = 240;

export class ExecutionAuthorizationRenewalError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_AUTH_RENEWAL_DENIED"
      | "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
    readonly status: 401 | 403 | 503,
  ) {
    super(code);
    this.name = "ExecutionAuthorizationRenewalError";
  }
}

export function createExecutionAuthorizationRenewalToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashExecutionAuthorizationRenewalToken(token) };
}

export function hashExecutionAuthorizationRenewalToken(token: string) {
  const normalized = token.trim();
  if (!normalized) throw new Error("Execution authorization renewal token is required.");
  return createHash("sha256").update(normalized, "utf8").digest("base64url");
}

export async function renewEnvironmentExecutionAuthorization(input: {
  executionId: string;
  renewalToken: string;
  executionTicket: string;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  const [row] = await knowledgeDb
    .select({
      execution: schema.environmentRunExecutions,
      environment: schema.environments,
      workspace: schema.environmentWorkspaces,
    })
    .from(schema.environmentRunExecutions)
    .innerJoin(
      schema.environments,
      eq(schema.environments.id, schema.environmentRunExecutions.environmentId),
    )
    .innerJoin(
      schema.environmentWorkspaces,
      eq(schema.environmentWorkspaces.id, schema.environmentRunExecutions.workspaceId),
    )
    .where(eq(schema.environmentRunExecutions.id, input.executionId))
    .limit(1);
  if (
    !row ||
    !["routed", "running"].includes(row.execution.status) ||
    !row.execution.authorizationRenewalTokenHash ||
    !matchesHash(
      hashExecutionAuthorizationRenewalToken(input.renewalToken),
      row.execution.authorizationRenewalTokenHash,
    )
  ) {
    throw new ExecutionAuthorizationRenewalError(
      "EXECUTION_AUTH_RENEWAL_DENIED",
      403,
    );
  }

  let current;
  try {
    current = verifyEnvironmentExecutionTicketForRenewal({
      token: input.executionTicket,
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
  } catch {
    throw new ExecutionAuthorizationRenewalError(
      "EXECUTION_AUTH_RENEWAL_DENIED",
      401,
    );
  }
  if (
    current.runId !== row.execution.id ||
    current.organizationId !== row.execution.organizationId ||
    current.environmentId !== row.execution.environmentId ||
    current.workspaceId !== row.execution.workspaceId ||
    current.threadId !== row.execution.threadId ||
    current.actorId !== row.execution.actorId ||
    !sameStringSet(
      current.capabilities,
      expectedTicketCapabilities(row.execution.effectiveCapabilities, current),
    ) ||
    !(await targetMatches(row, current))
  ) {
    throw new ExecutionAuthorizationRenewalError(
      "EXECUTION_AUTH_RENEWAL_DENIED",
      403,
    );
  }

  const renewableGrants = await knowledgeDb
    .select()
    .from(schema.mcpRunGrants)
    .where(and(
      eq(schema.mcpRunGrants.runExecutionId, row.execution.id),
      inArray(schema.mcpRunGrants.status, ["issued", "active"]),
    ));
  for (const grant of renewableGrants) {
    if (
      grant.organizationId !== row.execution.organizationId ||
      grant.environmentId !== row.execution.environmentId ||
      grant.projectId !== row.execution.projectId ||
      grant.threadId !== row.execution.threadId ||
      !grant.executionProfileId ||
      !grant.executionProfileFingerprint
    ) {
      throw new ExecutionAuthorizationRenewalError(
        "EXECUTION_AUTH_RENEWAL_DENIED",
        403,
      );
    }
    const policy = await resolveHostedMcpRunPolicy({
      organizationId: row.execution.organizationId,
      environmentId: row.execution.environmentId,
      projectId: row.execution.projectId,
    });
    if (
      !policy ||
      digestHostedMcpRunPolicyEvidence({
        threadId: row.execution.threadId,
        executionProfileId: grant.executionProfileId,
        executionProfileFingerprint: grant.executionProfileFingerprint,
        resolvedPolicy: policy,
      }) !== grant.policyDigest
    ) {
      throw new ExecutionAuthorizationRenewalError(
        "EXECUTION_AUTH_RENEWAL_DENIED",
        403,
      );
    }
  }

  let projectContextExtended = false;
  if (
    row.execution.projectContextGrantId &&
    row.execution.projectContextRevisionId &&
    row.execution.projectId
  ) {
    const revision = await knowledgeDb.query.projectContextRevisions.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.id, row.execution.projectContextRevisionId!),
        eq(table.projectId, row.execution.projectId!),
      ),
      columns: { revision: true },
    });
    if (!revision) {
      throw new ExecutionAuthorizationRenewalError(
        "EXECUTION_AUTH_RENEWAL_DENIED",
        403,
      );
    }
    await refreshProjectContextGrant({
      grantId: row.execution.projectContextGrantId,
      grant: {
        organizationId: row.execution.organizationId,
        projectId: row.execution.projectId,
        threadId: row.execution.threadId,
        actorUserId: row.execution.actorId,
        contextRevisionId: row.execution.projectContextRevisionId,
        contextRevision: revision.revision,
      },
    });
    projectContextExtended = true;
  }

  const expiresAt = new Date(
    now.getTime() + ENVIRONMENT_TICKET_MAX_TTL_SECONDS * 1000,
  );
  const renewedGrants = await knowledgeDb
    .update(schema.mcpRunGrants)
    .set({ expiresAt })
    .where(and(
      eq(schema.mcpRunGrants.runExecutionId, row.execution.id),
      inArray(schema.mcpRunGrants.status, ["issued", "active"]),
    ))
    .returning({ id: schema.mcpRunGrants.id });
  const issuedAt = Math.floor(now.getTime() / 1000);
  let renewedTicket: EnvironmentExecutionTicket;
  if (current.version === 1) {
    renewedTicket = {
        ...current,
        version: 1,
        audience: ENVIRONMENT_ROUTER_AUDIENCE,
        issuedAt,
        expiresAt: issuedAt + ENVIRONMENT_TICKET_MAX_TTL_SECONDS,
        nonce: crypto.randomUUID(),
      };
  } else if (current.version === 2) {
    renewedTicket = {
        ...current,
        version: 2,
        audience: ENVIRONMENT_ROUTER_AUDIENCE,
        issuedAt,
        expiresAt: issuedAt + ENVIRONMENT_TICKET_MAX_TTL_SECONDS,
        nonce: crypto.randomUUID(),
      };
  } else {
    renewedTicket = {
      ...current,
      version: 3,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      issuedAt,
      expiresAt: issuedAt + ENVIRONMENT_TICKET_MAX_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    };
  }
  const executionTicket = signEnvironmentExecutionTicket({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: renewedTicket,
  });
  const result = {
    version: EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
    executionTicket,
    expiresAt: expiresAt.toISOString(),
    renewAfter: new Date(
      now.getTime() + EXECUTION_AUTHORIZATION_RENEW_AFTER_SECONDS * 1000,
    ).toISOString(),
    mcpGrantIds: renewedGrants.map((grant) => grant.id),
    projectContextExtended,
  };
  process.stdout.write(`${JSON.stringify({
    type: "environment.authorization.renewed",
    executionId: row.execution.id,
    outcome: "renewed",
    oldExpiresAt: new Date(current.expiresAt * 1000).toISOString(),
    expiresAt: result.expiresAt,
    mcpGrantCount: result.mcpGrantIds.length,
    mcpAuthorityExtended: result.mcpGrantIds.length > 0,
    projectContextExtended,
    occurredAt: now.toISOString(),
  })}\n`);
  return result;
}

async function targetMatches(
  row: {
    execution: typeof schema.environmentRunExecutions.$inferSelect;
    environment: typeof schema.environments.$inferSelect;
    workspace: typeof schema.environmentWorkspaces.$inferSelect;
  },
  ticket: EnvironmentExecutionTicket,
) {
  const fly = getFlyEnvironmentExecutionTarget(ticket);
  if (fly) {
    return fly.appName === row.environment.flyAppName &&
      fly.machineId === row.workspace.flyMachineId;
  }
  const gateway = getGatewayEnvironmentExecutionTarget(ticket);
  if (gateway) {
    try {
      const authority = await resolveHostedRoutingAuthority({
        organizationId: row.execution.organizationId,
        environmentId: row.execution.environmentId,
        workspaceId: row.execution.workspaceId,
      });
      return authority.gateway.id === gateway.gatewayId;
    } catch {
      return false;
    }
  }
  const desktop = getDesktopEnvironmentExecutionTarget(ticket);
  if (!desktop || !row.workspace.desktopCatalogId) return false;
  const catalog = await knowledgeDb.query.desktopEnvironmentWorkspaceCatalog.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.id, row.workspace.desktopCatalogId!),
      eq(table.connectionId, desktop.connectionId),
      eq(table.workspaceRef, desktop.workspaceRef),
      eq(table.availability, "available"),
    ),
    columns: { id: true },
  });
  return Boolean(catalog);
}

function matchesHash(supplied: string, expected: string) {
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function expectedTicketCapabilities(
  effectiveCapabilities: readonly string[],
  ticket: EnvironmentExecutionTicket,
) {
  const routeCapabilities = effectiveCapabilities
    .filter((capability) => capability.startsWith("route:"))
    .map((capability) => capability.slice("route:".length));
  return getDesktopEnvironmentExecutionTarget(ticket)
    ? [...new Set([...routeCapabilities, ...effectiveCapabilities])]
    : routeCapabilities;
}
