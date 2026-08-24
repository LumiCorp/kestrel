import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
  WORKSPACE_EXECUTION_ACTIVATION_TIMEOUT_MS,
} from "@lumi/kestrel-environment-auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isGatewayCredentialReadyForRuntime } from "@/lib/ai/gateway-credential-health";
import type { KestrelOneCapabilityApprovalPolicyEvidence } from "@/lib/agent/kestrel-tool-profile";
import { resolveEffectiveProjectAppsAccess } from "@/lib/apps/project-service";
import { ensureEnvironmentAppPolicies } from "@/lib/apps/service";
import { getCoreAppDefinition } from "@/lib/apps/catalog";
import { applyMinimumApprovalMode } from "@/lib/apps/policy";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import { resolveHostedMcpRunPolicy } from "@/lib/mcp/grant-service";
import {
  getHostedEnvironmentRuntimeMode,
  requireHostedEnvironmentsEnabled,
} from "./config";
import type { EnvironmentProvider } from "./contracts";
import {
  requestFailedWorkspaceProvisionRetry,
  requestFailedWorkspaceStartRetry,
  requestWorkspaceStart,
  resolveOrCreateThreadExecutionBinding,
} from "./store";
import {
  findActiveWorkspaceLifecycleOperation,
  hasActiveWorkspaceLifecycleOperation,
} from "./lifecycle-operations";
import { createDesktopEnvironmentRunnerFetch } from "./desktop-runner-fetch";
import {
  environmentLifecycleLockKey,
  workspaceLifecycleLockKey,
} from "./lifecycle-lock";
import {
  createExecutionAuthorizationRenewalToken,
  EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
} from "./authorization-renewal";
import {
  LOCAL_ENVIRONMENT_RUNTIME_IMAGE,
  localEnvironmentExecutionTarget,
} from "./local-execution";

export type EnvironmentActivationProgress = {
  stage:
    | "environment.activation.requested"
    | "environment.machine.starting"
    | "environment.runtime.connecting"
    | "environment.workspace.mounting"
    | "environment.health.checking"
    | "environment.activation.ready"
    | "environment.activation.failed";
  detail: string;
  status: "pending" | "ready" | "failed";
};

export class EnvironmentActivationError extends Error {
  readonly code = "ENVIRONMENT_ACTIVATION_TIMEOUT";

  constructor() {
    super("Environment activation timed out.");
    this.name = "EnvironmentActivationError";
  }
}

export const ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES = [
  "profile.read",
  "run.stream",
  "run.cancel",
  "session.read",
  "events.subscribe",
  "workspace.files.read",
  "workspace.files.write",
  "workspace.terminal.exec",
  "workspace.apps.read",
  "workspace.apps.write",
  "workspace.previews.read",
  "workspace.previews.write",
  "gateway.config.refresh",
  "workspace.backups.export",
  "workspace.backups.restore",
  "workspace.skills.read",
  "workspace.skills.write",
  "workspace.promotions.read",
  "workspace.promotions.apply",
  "knowledge.search",
  "kestrel.tools.invoke",
] as const;

const ROUTE_CAPABILITIES = ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES;

type ResolvedThreadExecutionBinding = Awaited<
  ReturnType<typeof resolveOrCreateThreadExecutionBinding>
>;

export async function requestEnvironmentWorkspaceActivation(input: {
  organizationId: string;
  userId: string;
  provider: EnvironmentProvider;
  resolved: ResolvedThreadExecutionBinding;
}) {
  if (input.provider === "desktop") return null;

  let operation = input.resolved.created ? input.resolved.operation : null;
  if (!input.resolved.created && input.resolved.workspace.status === "failed") {
    operation =
      (await requestFailedWorkspaceProvisionRetry({
        organizationId: input.organizationId,
        environmentId: input.resolved.binding.environmentId,
        workspaceId: input.resolved.binding.workspaceId,
        userId: input.userId,
      })) ??
      (await requestFailedWorkspaceStartRetry({
        organizationId: input.organizationId,
        environmentId: input.resolved.binding.environmentId,
        workspaceId: input.resolved.binding.workspaceId,
        userId: input.userId,
      }));
  }
  if (
    !input.resolved.created &&
    (input.resolved.workspace.status === "stopped" ||
      input.resolved.workspace.status === "degraded")
  ) {
    operation = await requestWorkspaceStart({
      organizationId: input.organizationId,
      environmentId: input.resolved.binding.environmentId,
      workspaceId: input.resolved.binding.workspaceId,
      userId: input.userId,
    });
  }
  if (operation?.status === "queued") {
    await enqueueEnvironmentOperation(operation.id);
  }
  return operation;
}

export async function resolveEnvironmentExecutionRoute(input: {
  organizationId: string;
  expectedEnvironmentId?: string;
  threadId: string;
  actorUserId: string;
  agentId?: string | undefined;
  recordExecution?: {
    projectContextRevisionId?: string | undefined;
    projectContextGrantId?: string | undefined;
    durableTurnId?: string | undefined;
  };
  owningLifecycleOperationIds?: readonly string[] | undefined;
  onProgress?: (progress: EnvironmentActivationProgress) => void;
}) {
  await requireHostedEnvironmentsEnabled({
    organizationId: input.organizationId,
  });
  input.onProgress?.({
    stage: "environment.activation.requested",
    detail: "Preparing the Environment…",
    status: "pending",
  });
  if (getHostedEnvironmentRuntimeMode() === "local") {
    return resolveLocalEnvironmentExecutionRoute(input);
  }
  const resolved = await resolveOrCreateThreadExecutionBinding({
    organizationId: input.organizationId,
    threadId: input.threadId,
    userId: input.actorUserId,
  });
  if (
    input.expectedEnvironmentId &&
    resolved.binding.environmentId !== input.expectedEnvironmentId
  ) {
    throw new Error(
      "Thread Environment changed after this turn was queued. Submit a new turn in the active Environment.",
    );
  }
  const selectedEnvironment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.id, resolved.binding.environmentId),
        eq(table.organizationId, input.organizationId),
        isNull(table.archivedAt),
      ),
    columns: { provider: true },
  });
  if (selectedEnvironment?.provider === "desktop") {
    return resolveDesktopEnvironmentExecutionRoute({
      ...input,
      binding: resolved.binding,
      workspace: resolved.workspace,
    });
  }
  await requestEnvironmentWorkspaceActivation({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    provider: selectedEnvironment?.provider ?? "fly",
    resolved,
  });
  let authorization: Awaited<
    ReturnType<typeof finalizeHostedEnvironmentExecutionAuthorization>
  > | null = null;
  while (!authorization) {
    const { environment, workspace } = await waitForExecutionResources({
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      workspaceId: resolved.binding.workspaceId,
      actorUserId: input.actorUserId,
      owningLifecycleOperationIds: input.owningLifecycleOperationIds,
      onProgress: input.onProgress,
    });
    const { effectiveCapabilities, approvalPolicies } =
      await snapshotEffectiveCapabilities({
        organizationId: input.organizationId,
        environmentId: environment.id,
        threadId: input.threadId,
        actorId: input.actorUserId,
        agentId: input.agentId ?? "kestrel-one-ui",
      });
    const reasoningPolicy = await readEnvironmentReasoningPolicy({
      organizationId: input.organizationId,
      environmentId: environment.id,
    });
    authorization = await finalizeHostedEnvironmentExecutionAuthorization({
      runId: crypto.randomUUID(),
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: input.threadId,
      actorUserId: input.actorUserId,
      agentId: input.agentId ?? "kestrel-one-ui",
      effectiveCapabilities,
      approvalPolicies,
      reasoningPolicy,
      recordExecution: input.recordExecution,
      owningLifecycleOperationIds: input.owningLifecycleOperationIds,
    });
  }
  let mcpPolicy;
  if (input.recordExecution) {
    mcpPolicy = await resolveHostedMcpRunPolicy({
      organizationId: input.organizationId,
      environmentId: authorization.environmentId,
      projectId: authorization.projectId ?? null,
    });
  }
  input.onProgress?.({
    stage: "environment.activation.ready",
    detail: "Environment ready.",
    status: "ready",
  });
  return {
    provider: "fly" as const,
    baseUrl: authorization.baseUrl,
    authToken: authorization.executionTicket,
    executionTicket: authorization.executionTicket,
    runId: authorization.runId,
    environmentId: authorization.environmentId,
    workspaceId: authorization.workspaceId,
    projectId: authorization.projectId,
    effectiveCapabilities: authorization.effectiveCapabilities,
    approvalPolicies: authorization.approvalPolicies,
    reasoningPolicy: authorization.reasoningPolicy,
    ...(authorization.authorizationRenewal
      ? { authorizationRenewal: authorization.authorizationRenewal }
      : {}),
    ...(mcpPolicy ? { mcpPolicy } : {}),
  };
}

async function resolveDesktopEnvironmentExecutionRoute(input: {
  organizationId: string;
  threadId: string;
  actorUserId: string;
  agentId?: string | undefined;
  recordExecution?: {
    projectContextRevisionId?: string | undefined;
    projectContextGrantId?: string | undefined;
    durableTurnId?: string | undefined;
  };
  onProgress?: (progress: EnvironmentActivationProgress) => void;
  binding: {
    environmentId: string;
    workspaceId: string;
  };
  workspace: {
    id: string;
    status: string;
    runtimeImage: string | null;
    desktopCatalogId: string | null;
  };
}) {
  if (input.workspace.status !== "ready" || !input.workspace.desktopCatalogId) {
    throw new Error("The bound Desktop workspace is unavailable.");
  }
  const [environment, connection, catalog] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.binding.environmentId),
          eq(table.organizationId, input.organizationId),
          eq(table.provider, "desktop"),
          eq(table.status, "ready"),
          isNull(table.archivedAt),
        ),
    }),
    knowledgeDb.query.desktopEnvironmentConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.environmentId, input.binding.environmentId),
          eq(table.organizationId, input.organizationId),
          eq(table.status, "active"),
        ),
    }),
    knowledgeDb.query.desktopEnvironmentWorkspaceCatalog.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.workspace.desktopCatalogId!),
          eq(table.environmentId, input.binding.environmentId),
          eq(table.availability, "available"),
        ),
    }),
  ]);
  if (!(environment && connection && catalog)) {
    throw new Error(
      "Desktop Environment was revoked or its workspace is unavailable.",
    );
  }
  const runId = crypto.randomUUID();
  const { effectiveCapabilities, approvalPolicies } =
    await snapshotEffectiveCapabilities({
      organizationId: input.organizationId,
      environmentId: environment.id,
      threadId: input.threadId,
      actorId: input.actorUserId,
      agentId: input.agentId ?? "kestrel-one-ui",
    });
  const reasoningPolicy = await readEnvironmentReasoningPolicy({
    organizationId: input.organizationId,
    environmentId: environment.id,
  });
  let projectId: string | null | undefined;
  let mcpPolicy;
  if (input.recordExecution) {
    projectId = await recordEnvironmentExecution({
      id: runId,
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: input.workspace.id,
      threadId: input.threadId,
      actorId: input.actorUserId,
      runtimeImage: input.workspace.runtimeImage ?? "desktop-local",
      routeCapabilities: [...ROUTE_CAPABILITIES],
      effectiveCapabilities,
      reasoningPolicy,
      projectContextRevisionId: input.recordExecution.projectContextRevisionId,
      projectContextGrantId: input.recordExecution.projectContextGrantId,
      durableTurnId: input.recordExecution.durableTurnId,
    });
    mcpPolicy = await resolveHostedMcpRunPolicy({
      organizationId: input.organizationId,
      environmentId: environment.id,
      projectId,
    });
  }
  const online =
    connection.lastSeenAt &&
    Date.now() - connection.lastSeenAt.getTime() <= 90_000;
  input.onProgress?.({
    stage: online
      ? "environment.activation.ready"
      : "environment.runtime.connecting",
    detail: online
      ? "Desktop Environment ready."
      : "Desktop Environment offline. This turn will remain queued.",
    status: online ? "ready" : "pending",
  });
  return {
    provider: "desktop" as const,
    baseUrl: "https://desktop-environment.invalid",
    authToken: "desktop-internal",
    fetchImpl: createDesktopEnvironmentRunnerFetch({
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: input.workspace.id,
      executionId: runId,
      actorUserId: input.actorUserId,
    }),
    executionTicket: undefined,
    runId,
    environmentId: environment.id,
    workspaceId: input.workspace.id,
    projectId,
    effectiveCapabilities,
    approvalPolicies,
    reasoningPolicy,
    ...(mcpPolicy ? { mcpPolicy } : {}),
  };
}

export async function finalizeHostedEnvironmentExecutionAuthorization(input: {
  runId: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  agentId: string;
  effectiveCapabilities: string[];
  approvalPolicies?:
    | Awaited<
        ReturnType<typeof snapshotEffectiveCapabilities>
      >["approvalPolicies"]
    | undefined;
  reasoningPolicy: Awaited<ReturnType<typeof readEnvironmentReasoningPolicy>>;
  recordExecution?:
    | {
        projectContextRevisionId?: string | undefined;
        projectContextGrantId?: string | undefined;
        durableTurnId?: string | undefined;
      }
    | undefined;
  owningLifecycleOperationIds?: readonly string[] | undefined;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
    );
    const [environment, workspace, activeLifecycleOperation] =
      await Promise.all([
        transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.id, input.environmentId),
              eq(table.organizationId, input.organizationId),
              eq(table.status, "ready"),
              isNull(table.archivedAt),
            ),
          columns: {
            id: true,
            flyAppName: true,
            routerUrl: true,
            flyGatewayMachineId: true,
          },
        }),
        transaction.query.environmentWorkspaces.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.id, input.workspaceId),
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, input.environmentId),
              eq(table.status, "ready"),
              isNull(table.deletedAt),
            ),
          columns: {
            id: true,
            flyMachineId: true,
            runtimeImage: true,
          },
        }),
        findActiveWorkspaceLifecycleOperation(transaction, {
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          excludedOperationIds: input.owningLifecycleOperationIds,
        }),
      ]);
    if (
      !(
        environment?.flyAppName &&
        environment.routerUrl &&
        environment.flyGatewayMachineId &&
        workspace?.flyMachineId &&
        workspace.runtimeImage
      ) ||
      activeLifecycleOperation
    ) {
      return null;
    }

    const renewal = input.recordExecution
      ? createExecutionAuthorizationRenewalToken()
      : undefined;
    const projectId = input.recordExecution
      ? await recordEnvironmentExecutionInTransaction(transaction, {
          id: input.runId,
          organizationId: input.organizationId,
          environmentId: environment.id,
          workspaceId: workspace.id,
          threadId: input.threadId,
          actorId: input.actorUserId,
          runtimeImage: workspace.runtimeImage,
          routeCapabilities: [...ROUTE_CAPABILITIES],
          effectiveCapabilities: input.effectiveCapabilities,
          reasoningPolicy: input.reasoningPolicy,
          projectContextRevisionId:
            input.recordExecution.projectContextRevisionId,
          projectContextGrantId: input.recordExecution.projectContextGrantId,
          authorizationRenewalTokenHash: renewal?.tokenHash,
          durableTurnId: input.recordExecution.durableTurnId,
        })
      : undefined;
    const now = Math.floor(Date.now() / 1000);
    const executionTicket = signEnvironmentExecutionTicket({
      privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
      ticket: {
        version: 2,
        audience: ENVIRONMENT_ROUTER_AUDIENCE,
        organizationId: input.organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
        threadId: input.threadId,
        runId: input.runId,
        actorId: input.actorUserId,
        agentId: input.agentId,
        target: {
          provider: "fly",
          appName: environment.flyAppName,
          machineId: workspace.flyMachineId,
        },
        capabilities: [...ROUTE_CAPABILITIES],
        issuedAt: now,
        expiresAt: now + 300,
        nonce: crypto.randomUUID(),
      },
    });
    return {
      baseUrl: environment.routerUrl,
      executionTicket,
      runId: input.runId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      projectId,
      effectiveCapabilities: input.effectiveCapabilities,
      approvalPolicies: input.approvalPolicies ?? [],
      reasoningPolicy: input.reasoningPolicy,
      ...(renewal
        ? {
            authorizationRenewal: {
              version: EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
              endpoint: new URL(
                `/api/runtime/executions/${encodeURIComponent(input.runId)}/authorization/renew`,
                resolveKestrelAppUrl(process.env),
              ).toString(),
              token: renewal.token,
            },
          }
        : {}),
    };
  });
}

async function resolveLocalEnvironmentExecutionRoute(input: {
  organizationId: string;
  expectedEnvironmentId?: string;
  threadId: string;
  actorUserId: string;
  agentId?: string | undefined;
  recordExecution?: {
    projectContextRevisionId?: string | undefined;
    projectContextGrantId?: string | undefined;
    durableTurnId?: string | undefined;
  };
  onProgress?: (progress: EnvironmentActivationProgress) => void;
}) {
  input.onProgress?.({
    stage: "environment.runtime.connecting",
    detail: "Connecting to the local Environment runtime…",
    status: "pending",
  });
  const resolved = await resolveOrCreateThreadExecutionBinding({
    organizationId: input.organizationId,
    threadId: input.threadId,
    userId: input.actorUserId,
  });
  if (
    input.expectedEnvironmentId &&
    resolved.binding.environmentId !== input.expectedEnvironmentId
  ) {
    throw new Error(
      "Thread Environment changed after this turn was queued. Submit a new turn in the active Environment.",
    );
  }
  const runId = crypto.randomUUID();
  const { effectiveCapabilities, approvalPolicies } =
    await snapshotEffectiveCapabilities({
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      threadId: input.threadId,
      actorId: input.actorUserId,
      agentId: input.agentId ?? "kestrel-one-ui",
    });
  const reasoningPolicy = await readEnvironmentReasoningPolicy({
    organizationId: input.organizationId,
    environmentId: resolved.binding.environmentId,
  });
  const issuedAt = Math.floor(Date.now() / 1000);
  const executionTicket = signEnvironmentExecutionTicket({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: 2,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      workspaceId: resolved.binding.workspaceId,
      threadId: input.threadId,
      runId,
      actorId: input.actorUserId,
      agentId: input.agentId ?? "kestrel-one-ui",
      target: localEnvironmentExecutionTarget(resolved.binding.workspaceId),
      capabilities: [...ROUTE_CAPABILITIES],
      issuedAt,
      expiresAt: issuedAt + 300,
      nonce: crypto.randomUUID(),
    },
  });
  const renewal = input.recordExecution
    ? createExecutionAuthorizationRenewalToken()
    : undefined;
  let mcpPolicy;
  let projectId: string | null | undefined;
  if (input.recordExecution) {
    projectId = await recordEnvironmentExecution({
      id: runId,
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      workspaceId: resolved.binding.workspaceId,
      threadId: input.threadId,
      actorId: input.actorUserId,
      runtimeImage: LOCAL_ENVIRONMENT_RUNTIME_IMAGE,
      routeCapabilities: [...ROUTE_CAPABILITIES],
      effectiveCapabilities,
      reasoningPolicy,
      projectContextRevisionId: input.recordExecution.projectContextRevisionId,
      projectContextGrantId: input.recordExecution.projectContextGrantId,
      authorizationRenewalTokenHash: renewal?.tokenHash,
      durableTurnId: input.recordExecution.durableTurnId,
    });
    mcpPolicy = await resolveHostedMcpRunPolicy({
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      projectId,
    });
  }
  input.onProgress?.({
    stage: "environment.activation.ready",
    detail: "Local Environment ready.",
    status: "ready",
  });
  return {
    provider: "local" as const,
    baseUrl: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL ?? "",
    authToken: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN ?? "",
    executionTicket,
    runId,
    environmentId: resolved.binding.environmentId,
    workspaceId: resolved.binding.workspaceId,
    projectId,
    effectiveCapabilities,
    approvalPolicies,
    reasoningPolicy,
    ...(renewal
      ? {
          authorizationRenewal: {
            version: EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
            endpoint: new URL(
              `/api/runtime/executions/${encodeURIComponent(runId)}/authorization/renew`,
              resolveKestrelAppUrl(process.env),
            ).toString(),
            token: renewal.token,
          },
        }
      : {}),
    ...(mcpPolicy ? { mcpPolicy } : {}),
  };
}

async function waitForExecutionResources(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  owningLifecycleOperationIds?: readonly string[] | undefined;
  onProgress?: (progress: EnvironmentActivationProgress) => void;
}) {
  const deadline = Date.now() + WORKSPACE_EXECUTION_ACTIVATION_TIMEOUT_MS;
  let lastDetail = "";
  let startRequested = false;
  while (Date.now() < deadline) {
    const [environment, workspace, activeLifecycleOperation] =
      await Promise.all([
        knowledgeDb.query.environments.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, input.environmentId),
              eq(table.organizationId, input.organizationId),
            ),
        }),
        knowledgeDb.query.environmentWorkspaces.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, input.workspaceId),
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, input.environmentId),
            ),
        }),
        hasActiveWorkspaceLifecycleOperation({
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          excludedOperationIds: input.owningLifecycleOperationIds,
        }),
      ]);
    if (!(environment && workspace)) {
      throw new Error("Environment execution binding is unavailable.");
    }
    if (environment.status === "failed" || workspace.status === "failed") {
      const failure = describeEnvironmentActivation({
        environmentStatus: environment.status,
        workspaceStatus: workspace.status,
        failureMessage: workspace.failureMessage ?? environment.failureMessage,
      });
      input.onProgress?.(failure);
      throw new Error(failure.detail);
    }
    if (
      environment.status === "ready" &&
      environment.flyAppName &&
      environment.routerUrl &&
      environment.flyGatewayMachineId &&
      workspace.status === "ready" &&
      workspace.flyMachineId &&
      workspace.runtimeImage &&
      !activeLifecycleOperation
    ) {
      return {
        environment: {
          id: environment.id,
          flyAppName: environment.flyAppName,
          routerUrl: environment.routerUrl,
        },
        workspace: {
          id: workspace.id,
          flyMachineId: workspace.flyMachineId,
          runtimeImage: workspace.runtimeImage,
        },
      };
    }
    if (
      !startRequested &&
      (workspace.status === "stopped" || workspace.status === "degraded")
    ) {
      const operation = await requestWorkspaceStart({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
      });
      if (operation?.status === "queued") {
        await enqueueEnvironmentOperation(operation.id);
      }
      startRequested = true;
    }
    const progress = describeEnvironmentActivation({
      environmentStatus: environment.status,
      workspaceStatus: workspace.status,
      failureMessage: workspace.failureMessage ?? environment.failureMessage,
    });
    if (progress.detail !== lastDetail) {
      lastDetail = progress.detail;
      input.onProgress?.(progress);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new EnvironmentActivationError();
}

export async function updateEnvironmentExecutionStatus(input: {
  organizationId: string;
  executionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.environmentRunExecutions)
      .set({
        status: input.status,
        ...(input.status === "running"
          ? { startedAt: now }
          : { completedAt: now }),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environmentRunExecutions.id, input.executionId),
          eq(
            schema.environmentRunExecutions.organizationId,
            input.organizationId,
          ),
        ),
      );
    if (input.status !== "running") {
      await transaction
        .update(schema.environmentModelGrants)
        .set({ status: "closed", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.environmentModelGrants.runId, input.executionId),
            eq(
              schema.environmentModelGrants.organizationId,
              input.organizationId,
            ),
          ),
        );
      await transaction
        .update(schema.mcpRunGrants)
        .set({ status: "revoked", revokedAt: now })
        .where(
          and(
            eq(schema.mcpRunGrants.runExecutionId, input.executionId),
            eq(schema.mcpRunGrants.organizationId, input.organizationId),
            inArray(schema.mcpRunGrants.status, ["issued", "active"]),
          ),
        );
    }
  });
}

export async function activateEnvironmentModelGrant(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  gatewayId: string;
  rawModelId: string;
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select({ deploymentId: schema.aiGateways.deploymentId })
      .from(schema.aiGatewayModels)
      .innerJoin(
        schema.aiGateways,
        eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId),
      )
      .where(
        and(
          eq(schema.aiGatewayModels.organizationId, input.organizationId),
          eq(schema.aiGatewayModels.gatewayId, input.gatewayId),
          eq(schema.aiGatewayModels.rawModelId, input.rawModelId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new Error("Environment model grant gateway model is unavailable.");
    }
    if (candidate.deploymentId) {
      const [deployment] = await transaction
        .select({ status: schema.aiDeployments.status })
        .from(schema.aiDeployments)
        .where(
          and(
            eq(schema.aiDeployments.id, candidate.deploymentId),
            eq(schema.aiDeployments.organizationId, input.organizationId),
            eq(schema.aiDeployments.environmentId, input.environmentId),
          ),
        )
        .limit(1)
        .for("share");
      if (deployment?.status !== "ready") {
        throw new Error(
          "Environment model grant gateway model is unavailable.",
        );
      }
    }
    const [model] = await transaction
      .select({
        id: schema.aiGatewayModels.id,
        enabled: schema.aiGateways.enabled,
        deploymentId: schema.aiGateways.deploymentId,
        provider: schema.aiGateways.provider,
        apiKey: schema.aiGateways.apiKey,
        providerConnectionId: schema.aiGateways.providerConnectionId,
        credentialStatus: schema.aiGateways.credentialStatus,
        credentialValidatedAt: schema.aiGateways.credentialValidatedAt,
        credentialRevision: schema.aiGateways.credentialRevision,
      })
      .from(schema.aiGatewayModels)
      .innerJoin(
        schema.aiGateways,
        eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId),
      )
      .where(
        and(
          eq(schema.aiGatewayModels.organizationId, input.organizationId),
          eq(schema.aiGatewayModels.gatewayId, input.gatewayId),
          eq(schema.aiGatewayModels.rawModelId, input.rawModelId),
        ),
      )
      .limit(1)
      .for("share");
    if (
      !model?.enabled ||
      model.deploymentId !== candidate.deploymentId ||
      !isGatewayCredentialReadyForRuntime({
        provider: model.provider,
        credentialStatus: model.credentialStatus,
        credentialValidatedAt: model.credentialValidatedAt,
        hasRequiredCredential:
          model.provider === "ollama" ||
          Boolean(model.apiKey?.trim()) ||
          Boolean(model.providerConnectionId) ||
          Boolean(model.deploymentId),
      })
    ) {
      throw new Error("Environment model grant gateway model is unavailable.");
    }
    const [grant] = await transaction
      .insert(schema.environmentModelGrants)
      .values({
        ...input,
        gatewayModelId: model.id,
        gatewayCredentialRevision: model.credentialRevision,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.environmentModelGrants.runId,
        setWhere: and(
          eq(schema.environmentModelGrants.gatewayId, input.gatewayId),
          eq(schema.environmentModelGrants.rawModelId, input.rawModelId),
        ),
        set: {
          gatewayModelId: model.id,
          gatewayCredentialRevision: model.credentialRevision,
          status: "active",
          closedAt: null,
          updatedAt: now,
        },
      })
      .returning({ runId: schema.environmentModelGrants.runId });
    if (!grant) {
      throw new Error(
        "Environment model grant historical model identity is immutable.",
      );
    }
  });
}

export async function updateEnvironmentExecutionRuntimeIdentity(input: {
  organizationId: string;
  executionId: string;
  runtimeRunId: string;
  reasoningKeyReady?: boolean | undefined;
}) {
  const [updated] = await knowledgeDb
    .update(schema.environmentRunExecutions)
    .set({
      runtimeRunId: input.runtimeRunId,
      ...(input.reasoningKeyReady !== undefined
        ? { reasoningKeyReady: input.reasoningKeyReady }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.environmentRunExecutions.id, input.executionId),
        eq(
          schema.environmentRunExecutions.organizationId,
          input.organizationId,
        ),
      ),
    )
    .returning({ id: schema.environmentRunExecutions.id });
  if (!updated) {
    throw new Error(
      "Environment execution runtime identity was not persisted.",
    );
  }
}

export async function updateEnvironmentExecutionRuntimeCursor(input: {
  organizationId: string;
  executionId: string;
  eventId: string;
}) {
  await settleEnvironmentExecutionRuntimeEvent(input);
}

export async function readEnvironmentExecutionTerminalStatus(input: {
  organizationId: string;
  executionId: string;
}) {
  const execution = await knowledgeDb.query.environmentRunExecutions.findFirst({
    where: and(
      eq(schema.environmentRunExecutions.id, input.executionId),
      eq(schema.environmentRunExecutions.organizationId, input.organizationId),
      inArray(schema.environmentRunExecutions.status, [
        "completed",
        "failed",
        "cancelled",
      ]),
    ),
    columns: {
      status: true,
      lastRuntimeEventId: true,
      completedAt: true,
    },
  });
  if (
    !(
      execution &&
      ["completed", "failed", "cancelled"].includes(execution.status)
    )
  ) {
    return null;
  }
  return {
    ...execution,
    status: execution.status as "completed" | "failed" | "cancelled",
  };
}

export async function settleEnvironmentExecutionRuntimeEvent(input: {
  organizationId: string;
  executionId: string;
  eventId: string;
  terminalStatus?: "completed" | "failed" | "cancelled" | undefined;
}) {
  await knowledgeDb.transaction(async (transaction) => {
    const [execution] = await transaction
      .select({
        status: schema.environmentRunExecutions.status,
        lastRuntimeEventId: schema.environmentRunExecutions.lastRuntimeEventId,
      })
      .from(schema.environmentRunExecutions)
      .where(
        and(
          eq(schema.environmentRunExecutions.id, input.executionId),
          eq(
            schema.environmentRunExecutions.organizationId,
            input.organizationId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!execution)
      throw new Error("Environment execution runtime event was not persisted.");
    const terminal = ["completed", "failed", "cancelled"].includes(
      execution.status,
    );
    if (terminal) {
      if (execution.lastRuntimeEventId === input.eventId) return;
      throw new Error(
        "Environment execution runtime event was observed after terminal settlement.",
      );
    }
    if (!(["routed", "running"] as string[]).includes(execution.status)) {
      throw new Error("Environment execution runtime event was not persisted.");
    }
    const now = new Date();
    await transaction
      .update(schema.environmentRunExecutions)
      .set({
        lastRuntimeEventId: input.eventId,
        ...(input.terminalStatus
          ? { status: input.terminalStatus, completedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environmentRunExecutions.id, input.executionId),
          eq(
            schema.environmentRunExecutions.organizationId,
            input.organizationId,
          ),
        ),
      );
    if (!input.terminalStatus) return;
    await transaction
      .update(schema.environmentModelGrants)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.environmentModelGrants.runId, input.executionId),
          eq(
            schema.environmentModelGrants.organizationId,
            input.organizationId,
          ),
        ),
      );
    await transaction
      .update(schema.mcpRunGrants)
      .set({ status: "revoked", revokedAt: now })
      .where(
        and(
          eq(schema.mcpRunGrants.runExecutionId, input.executionId),
          eq(schema.mcpRunGrants.organizationId, input.organizationId),
          inArray(schema.mcpRunGrants.status, ["issued", "active"]),
        ),
      );
  });
}

export async function resolveEnvironmentExecutionAuthorizationRoute(input: {
  organizationId: string;
  executionId: string;
}) {
  return resolvePersistedEnvironmentExecutionRoute({
    ...input,
    statuses: ["routed", "running"],
    capabilities: ROUTE_CAPABILITIES,
  });
}

export async function resolveEnvironmentExecutionRecoveryRoute(input: {
  organizationId: string;
  executionId: string;
}) {
  return resolvePersistedEnvironmentExecutionRoute({
    ...input,
    statuses: ["completed"],
    capabilities: ["session.read"],
  });
}

export async function resolveEnvironmentPublicationRoute(input: {
  organizationId: string;
  executionId: string;
}) {
  return resolvePersistedEnvironmentExecutionRoute({
    ...input,
    statuses: ["completed"],
    capabilities: [
      "session.read",
      "workspace.promotions.read",
      "workspace.git.publish",
    ],
  });
}

async function resolvePersistedEnvironmentExecutionRoute(input: {
  organizationId: string;
  executionId: string;
  statuses: Array<"routed" | "running" | "completed">;
  capabilities: readonly string[];
}) {
  const [route] = await knowledgeDb
    .select({
      status: schema.environmentRunExecutions.status,
      environmentId: schema.environmentRunExecutions.environmentId,
      workspaceId: schema.environmentRunExecutions.workspaceId,
      threadId: schema.environmentRunExecutions.threadId,
      actorId: schema.environmentRunExecutions.actorId,
      runtimeRunId: schema.environmentRunExecutions.runtimeRunId,
      lastRuntimeEventId: schema.environmentRunExecutions.lastRuntimeEventId,
      completedAt: schema.environmentRunExecutions.completedAt,
      flyAppName: schema.environments.flyAppName,
      routerUrl: schema.environments.routerUrl,
      flyMachineId: schema.environmentWorkspaces.flyMachineId,
    })
    .from(schema.environmentRunExecutions)
    .innerJoin(
      schema.environments,
      eq(schema.environments.id, schema.environmentRunExecutions.environmentId),
    )
    .innerJoin(
      schema.environmentWorkspaces,
      eq(
        schema.environmentWorkspaces.id,
        schema.environmentRunExecutions.workspaceId,
      ),
    )
    .where(
      and(
        eq(schema.environmentRunExecutions.id, input.executionId),
        eq(
          schema.environmentRunExecutions.organizationId,
          input.organizationId,
        ),
        inArray(schema.environmentRunExecutions.status, input.statuses),
      ),
    )
    .limit(1);
  if (!route) return null;
  if (!(route.flyAppName && route.flyMachineId && route.routerUrl)) {
    throw new Error("Environment execution authorization route is incomplete.");
  }
  const now = Math.floor(Date.now() / 1000);
  const authToken = signEnvironmentExecutionTicket({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: 2,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: route.environmentId,
      workspaceId: route.workspaceId,
      threadId: route.threadId,
      runId: input.executionId,
      actorId: route.actorId,
      agentId: "kestrel-one-turn-worker",
      target: {
        provider: "fly",
        appName: route.flyAppName,
        machineId: route.flyMachineId,
      },
      capabilities: [...input.capabilities],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: crypto.randomUUID(),
    },
  });
  return {
    baseUrl: route.routerUrl,
    authToken,
    environmentId: route.environmentId,
    workspaceId: route.workspaceId,
    threadId: route.threadId,
    runtimeRunId: route.runtimeRunId,
    lastRuntimeEventId: route.lastRuntimeEventId,
    status: route.status,
    completedAt: route.completedAt,
    sessionId: route.threadId,
    actorId: route.actorId,
  };
}

export async function resolveEnvironmentExecutionCancellationRoute(input: {
  organizationId: string;
  executionId: string;
}) {
  const route = await resolveEnvironmentExecutionAuthorizationRoute(input);
  if (!route?.runtimeRunId) return null;
  return {
    baseUrl: route.baseUrl,
    authToken: route.authToken,
    runtimeRunId: route.runtimeRunId,
    lastRuntimeEventId: route.lastRuntimeEventId,
    sessionId: route.sessionId,
    actorId: route.actorId,
  };
}

export function createEnvironmentMachineRoute(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorId: string;
  agentId?: string | undefined;
  flyAppName: string;
  flyMachineId: string;
  routerUrl: string;
  capabilities?: string[] | undefined;
}) {
  const now = Math.floor(Date.now() / 1000);
  const runId = crypto.randomUUID();
  const authToken = signEnvironmentExecutionTicket({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: 2,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      runId,
      actorId: input.actorId,
      agentId: input.agentId ?? "kestrel-control-plane",
      target: {
        provider: "fly",
        appName: input.flyAppName,
        machineId: input.flyMachineId,
      },
      capabilities: input.capabilities ?? [...ROUTE_CAPABILITIES],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: crypto.randomUUID(),
    },
  });
  return { baseUrl: input.routerUrl, authToken, runId };
}

type EnvironmentExecutionTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

type EnvironmentExecutionRecordInput = {
  id: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorId: string;
  runtimeImage: string;
  routeCapabilities: string[];
  effectiveCapabilities: string[];
  projectContextRevisionId?: string | undefined;
  projectContextGrantId?: string | undefined;
  authorizationRenewalTokenHash?: string | undefined;
  durableTurnId?: string | undefined;
  reasoningPolicy: {
    request: {
      mode: "off" | "summary" | "provider_visible";
      effort?: "low" | "medium" | "high" | undefined;
    };
    retention: { mode: "live_only" | "provider_visible"; days: number };
  };
};

async function recordEnvironmentExecution(
  input: EnvironmentExecutionRecordInput,
) {
  return knowledgeDb.transaction((transaction) =>
    recordEnvironmentExecutionInTransaction(transaction, input),
  );
}

async function recordEnvironmentExecutionInTransaction(
  transaction: EnvironmentExecutionTransaction,
  input: EnvironmentExecutionRecordInput,
) {
  const thread = await transaction.query.threads.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.threadId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: { projectId: true },
  });
  if (!thread) throw new Error("Environment execution Thread is unavailable.");
  if (input.projectContextRevisionId) {
    const revision = thread.projectId
      ? await transaction.query.projectContextRevisions.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, input.projectContextRevisionId!),
              eq(table.projectId, thread.projectId!),
            ),
          columns: { id: true },
        })
      : null;
    if (!revision) {
      throw new Error("Environment execution Project context is unavailable.");
    }
  }
  await transaction.insert(schema.environmentRunExecutions).values({
    id: input.id,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    projectId: thread.projectId,
    projectContextRevisionId: input.projectContextRevisionId ?? null,
    projectContextGrantId: input.projectContextGrantId ?? null,
    authorizationRenewalTokenHash: input.authorizationRenewalTokenHash ?? null,
    actorId: input.actorId,
    runtimeImage: input.runtimeImage,
    effectiveCapabilities: [
      ...input.routeCapabilities.map((capability) => `route:${capability}`),
      ...input.effectiveCapabilities,
    ].sort(),
    reasoningPolicySnapshot: input.reasoningPolicy,
    reasoningKeyReady: false,
  });
  if (input.durableTurnId) {
    const [bound] = await transaction
      .update(schema.threadTurns)
      .set({ environmentExecutionId: input.id, updatedAt: new Date() })
      .where(
        and(
          eq(schema.threadTurns.id, input.durableTurnId),
          eq(schema.threadTurns.organizationId, input.organizationId),
          eq(schema.threadTurns.threadId, input.threadId),
          eq(schema.threadTurns.status, "running"),
        ),
      )
      .returning({ id: schema.threadTurns.id });
    if (!bound) {
      throw new Error(
        "Durable turn could not be bound to its Environment execution.",
      );
    }
  }
  return thread.projectId;
}

async function readEnvironmentReasoningPolicy(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.environmentId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: {
      reasoningRequestMode: true,
      reasoningEffort: true,
      reasoningRetentionMode: true,
      reasoningRetentionDays: true,
    },
  });
  if (!environment)
    throw new Error("Environment reasoning policy is unavailable.");
  return {
    request: {
      mode: environment.reasoningRequestMode,
      ...(environment.reasoningEffort
        ? { effort: environment.reasoningEffort }
        : {}),
    },
    retention: {
      mode: environment.reasoningRetentionMode,
      days: environment.reasoningRetentionDays,
    },
  };
}

async function snapshotEffectiveCapabilities(input: {
  organizationId: string;
  environmentId: string;
  threadId: string;
  actorId: string;
  agentId: string;
}): Promise<{
  effectiveCapabilities: string[];
  approvalPolicies: KestrelOneCapabilityApprovalPolicyEvidence[];
}> {
  await ensureEnvironmentAppPolicies({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  const [thread, definitions, installations, subjectRestrictions] =
    await Promise.all([
      knowledgeDb.query.threads.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.threadId),
            eq(table.organizationId, input.organizationId),
          ),
        columns: { projectId: true },
      }),
      knowledgeDb.query.appDefinitions.findMany({
        where: (table, { eq }) => eq(table.published, true),
      }),
      knowledgeDb.query.appInstallations.findMany({
        where: (table, { eq }) =>
          eq(table.organizationId, input.organizationId),
      }),
      knowledgeDb.query.environmentCapabilitySubjectRestrictions.findMany({
        where: (table, { and, eq, or }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId),
            or(
              and(
                eq(table.subjectType, "actor"),
                eq(table.subjectId, input.actorId),
              ),
              and(
                eq(table.subjectType, "agent"),
                eq(table.subjectId, input.agentId),
              ),
            ),
          ),
      }),
    ]);
  if (!thread) throw new Error("Environment execution Thread is unavailable.");
  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation]),
  );
  const availableDefinitions = definitions.filter(
    (definition) =>
      definition.installMode === "inherited" ||
      installationByApp.get(definition.key)?.status === "installed",
  );

  function subjectApprovalMode(inputApproval: {
    appKey: string;
    capabilityKey: string;
  }): "ask" | "deny" | undefined {
    const matchingRestrictions = subjectRestrictions.filter(
      (restriction) =>
        restriction.providerKey === inputApproval.appKey &&
        restriction.capabilityKey === inputApproval.capabilityKey &&
        restriction.resourceId === null,
    );
    if (
      matchingRestrictions.some(
        (restriction) =>
          !restriction.enabled || restriction.approvalMode === "deny",
      )
    ) {
      return "deny";
    }
    return matchingRestrictions.some(
      (restriction) => restriction.approvalMode === "ask",
    )
      ? "ask"
      : undefined;
  }

  function restrictApprovalMode(inputApproval: {
    appKey: string;
    capabilityKey: string;
    approvalMode: "auto" | "ask" | "deny";
  }) {
    const subject = subjectApprovalMode(inputApproval);
    if (subject === "deny") return null;
    return subject === "ask" ? "ask" : inputApproval.approvalMode;
  }

  if (!thread.projectId) {
    const [grants, capabilities] = await Promise.all([
      knowledgeDb.query.environmentAppCapabilityGrants.findMany({
        where: (table, { eq }) => eq(table.environmentId, input.environmentId),
      }),
      knowledgeDb.query.appCapabilities.findMany(),
    ]);
    const definitionByKey = new Map(
      availableDefinitions.map((definition) => [definition.key, definition]),
    );
    const capabilityByKey = new Map(
      capabilities.map((capability) => [
        `${capability.appKey}:${capability.key}`,
        capability,
      ]),
    );
    const entries = grants.flatMap((grant) => {
      const definition = definitionByKey.get(grant.appKey);
      const capability = capabilityByKey.get(
        `${grant.appKey}:${grant.capabilityKey}`,
      );
      if (
        definition?.connectionModel !== "none" ||
        !capability?.runtimeName ||
        !grant.enabled ||
        grant.approvalMode === "deny"
      ) {
        return [];
      }
      const minimum =
        getCoreAppDefinition(grant.appKey)?.capabilities.find(
          (candidate) => candidate.key === grant.capabilityKey,
        )?.minimumApprovalMode ?? "auto";
      const subject = subjectApprovalMode({
        appKey: grant.appKey,
        capabilityKey: grant.capabilityKey,
      });
      const approvalMode = restrictApprovalMode({
        appKey: grant.appKey,
        capabilityKey: grant.capabilityKey,
        approvalMode: applyMinimumApprovalMode({
          requested: grant.approvalMode,
          minimum,
        }),
      });
      return approvalMode
        ? [
            {
              capability: `app:${grant.appKey}.${grant.capabilityKey}:${approvalMode}`,
              policy: {
                appKey: grant.appKey,
                capabilityKey: grant.capabilityKey,
                environment: grant.approvalMode,
                ...(subject === undefined ? {} : { subject }),
                minimum,
              },
            },
          ]
        : [];
    });
    return {
      effectiveCapabilities: entries.map((entry) => entry.capability),
      approvalPolicies: entries.map((entry) => entry.policy),
    };
  }

  const appAccess = await resolveEffectiveProjectAppsAccess({
    organizationId: input.organizationId,
    projectId: thread.projectId,
    userId: input.actorId,
  });
  const entries = appAccess.flatMap((access) =>
    access
      ? access.capabilities.flatMap((capability) => {
          const subject = subjectApprovalMode({
            appKey: access.appKey,
            capabilityKey: capability.key,
          });
          const approvalMode = restrictApprovalMode({
            appKey: access.appKey,
            capabilityKey: capability.key,
            approvalMode: capability.approvalMode,
          });
          return approvalMode
            ? [
                {
                  capability: `app:${access.appKey}.${capability.key}:${approvalMode}`,
                  policy: {
                    appKey: access.appKey,
                    capabilityKey: capability.key,
                    environment: capability.environmentApprovalMode,
                    project: capability.projectApprovalMode,
                    ...(subject === undefined ? {} : { subject }),
                    minimum: capability.minimumApprovalMode,
                  },
                },
              ]
            : [];
        })
      : [],
  );
  return {
    effectiveCapabilities: entries.map((entry) => entry.capability),
    approvalPolicies: entries.map((entry) => entry.policy),
  };
}

export function describeEnvironmentActivation(input: {
  environmentStatus: string;
  workspaceStatus: string;
  failureMessage?: string | null | undefined;
}): EnvironmentActivationProgress {
  if (
    input.environmentStatus === "failed" ||
    input.workspaceStatus === "failed"
  ) {
    return {
      stage: "environment.activation.failed",
      detail: input.failureMessage?.trim() || "Environment activation failed.",
      status: "failed",
    };
  }
  if (input.workspaceStatus === "stopping") {
    return {
      stage: "environment.machine.starting",
      detail: "Finishing the Workspace sleep transition…",
      status: "pending",
    };
  }
  if (
    input.environmentStatus === "ready" &&
    input.workspaceStatus === "ready"
  ) {
    return {
      stage: "environment.activation.ready",
      detail: "Environment ready.",
      status: "ready",
    };
  }
  if (input.environmentStatus !== "ready") {
    return {
      stage: "environment.runtime.connecting",
      detail: "Provisioning the Environment runtime…",
      status: "pending",
    };
  }
  if (input.workspaceStatus === "degraded") {
    return {
      stage: "environment.health.checking",
      detail: "Reconnecting to the Workspace Runtime…",
      status: "pending",
    };
  }
  if (
    input.workspaceStatus === "stopped" ||
    input.workspaceStatus === "starting"
  ) {
    return {
      stage: "environment.machine.starting",
      detail: "Waking the Workspace Machine…",
      status: "pending",
    };
  }
  if (
    input.workspaceStatus === "requested" ||
    input.workspaceStatus === "provisioning"
  ) {
    return {
      stage: "environment.workspace.mounting",
      detail: "Mounting the persistent Workspace…",
      status: "pending",
    };
  }
  return {
    stage: "environment.health.checking",
    detail: "Checking Workspace health…",
    status: "pending",
  };
}
