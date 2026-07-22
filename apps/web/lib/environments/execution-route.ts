import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq } from "drizzle-orm";
import { resolveEffectiveProjectAppsAccess } from "@/lib/apps/project-service";
import { ensureEnvironmentAppPolicies } from "@/lib/apps/service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { issueHostedMcpRunContext } from "@/lib/mcp/grant-service";
import {
  getHostedEnvironmentRuntimeMode,
  requireHostedEnvironmentsEnabled,
} from "./config";
import {
  requestWorkspaceStart,
  resolveOrCreateThreadExecutionBinding,
} from "./store";

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

const ROUTE_CAPABILITIES = [
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
  "workspace.backups.export",
  "workspace.backups.restore",
  "workspace.skills.read",
  "workspace.skills.write",
  "workspace.promotions.read",
  "workspace.promotions.apply",
  "knowledge.search",
  "kestrel.tools.invoke",
] as const;

export async function resolveEnvironmentExecutionRoute(input: {
  organizationId: string;
  expectedEnvironmentId?: string;
  threadId: string;
  actorUserId: string;
  agentId?: string | undefined;
  recordExecution?: {
    projectContextRevisionId?: string | undefined;
  };
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
      "Thread Environment changed after this turn was queued. Submit a new turn in the active Environment."
    );
  }
  if (resolved.created && resolved.operation?.status === "queued") {
    await enqueueEnvironmentOperation(resolved.operation.id);
  }
  if (
    !resolved.created &&
    (resolved.workspace.status === "stopped" ||
      resolved.workspace.status === "degraded")
  ) {
    const operation = await requestWorkspaceStart({
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      workspaceId: resolved.binding.workspaceId,
      userId: input.actorUserId,
    });
    if (operation?.status === "queued") {
      await enqueueEnvironmentOperation(operation.id);
    }
  }
  const { environment, workspace } = await waitForExecutionResources({
    organizationId: input.organizationId,
    environmentId: resolved.binding.environmentId,
    workspaceId: resolved.binding.workspaceId,
    actorUserId: input.actorUserId,
    onProgress: input.onProgress,
  });
  const now = Math.floor(Date.now() / 1000);
  const runId = crypto.randomUUID();
  const effectiveCapabilities = await snapshotEffectiveCapabilities({
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
  let mcpContext;
  if (input.recordExecution) {
    const projectId = await recordEnvironmentExecution({
      id: runId,
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: input.threadId,
      actorId: input.actorUserId,
      runtimeImage: workspace.runtimeImage,
      routeCapabilities: [...ROUTE_CAPABILITIES],
      effectiveCapabilities,
      reasoningPolicy,
      projectContextRevisionId: input.recordExecution.projectContextRevisionId,
    });
    mcpContext = await issueHostedMcpRunContext({
      runExecutionId: runId,
      organizationId: input.organizationId,
      environmentId: environment.id,
      projectId,
      threadId: input.threadId,
    });
  }
  const privateKey = process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "";
  const token = signEnvironmentExecutionTicket({
    privateKey,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: input.threadId,
      runId,
      actorId: input.actorUserId,
      agentId: input.agentId ?? "kestrel-one-ui",
      flyAppName: environment.flyAppName,
      flyMachineId: workspace.flyMachineId,
      capabilities: [...ROUTE_CAPABILITIES],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: crypto.randomUUID(),
    },
  });
  input.onProgress?.({
    stage: "environment.activation.ready",
    detail: "Environment ready.",
    status: "ready",
  });
  return {
    baseUrl: environment.routerUrl,
    authToken: token,
    executionTicket: token,
    runId,
    environmentId: environment.id,
    workspaceId: workspace.id,
    effectiveCapabilities,
    reasoningPolicy,
    ...(mcpContext ? { mcpContext } : {}),
  };
}

async function resolveLocalEnvironmentExecutionRoute(input: {
  organizationId: string;
  expectedEnvironmentId?: string;
  threadId: string;
  actorUserId: string;
  agentId?: string | undefined;
  recordExecution?: {
    projectContextRevisionId?: string | undefined;
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
      "Thread Environment changed after this turn was queued. Submit a new turn in the active Environment."
    );
  }
  const runId = crypto.randomUUID();
  const effectiveCapabilities = await snapshotEffectiveCapabilities({
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
  let mcpContext;
  if (input.recordExecution) {
    const projectId = await recordEnvironmentExecution({
      id: runId,
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      workspaceId: resolved.binding.workspaceId,
      threadId: input.threadId,
      actorId: input.actorUserId,
      runtimeImage: "local-runner",
      routeCapabilities: [...ROUTE_CAPABILITIES],
      effectiveCapabilities,
      reasoningPolicy,
      projectContextRevisionId: input.recordExecution.projectContextRevisionId,
    });
    mcpContext = await issueHostedMcpRunContext({
      runExecutionId: runId,
      organizationId: input.organizationId,
      environmentId: resolved.binding.environmentId,
      projectId,
      threadId: input.threadId,
    });
  }
  input.onProgress?.({
    stage: "environment.activation.ready",
    detail: "Local Environment ready.",
    status: "ready",
  });
  return {
    baseUrl: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL ?? "",
    authToken: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN ?? "",
    executionTicket: undefined,
    runId,
    environmentId: resolved.binding.environmentId,
    workspaceId: resolved.binding.workspaceId,
    effectiveCapabilities,
    reasoningPolicy,
    ...(mcpContext ? { mcpContext } : {}),
  };
}

async function waitForExecutionResources(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
  onProgress?: (progress: EnvironmentActivationProgress) => void;
}) {
  const deadline = Date.now() + 90_000;
  let lastDetail = "";
  let startRequested = false;
  while (Date.now() < deadline) {
    const [environment, workspace] = await Promise.all([
      knowledgeDb.query.environments.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.environmentId),
            eq(table.organizationId, input.organizationId)
          ),
      }),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.workspaceId),
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId)
          ),
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
      workspace.runtimeImage
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
  throw new Error("Environment activation timed out.");
}

export async function updateEnvironmentExecutionStatus(input: {
  organizationId: string;
  executionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
}) {
  const now = new Date();
  await knowledgeDb
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
        eq(schema.environmentRunExecutions.organizationId, input.organizationId)
      )
    );
}

export async function updateEnvironmentExecutionRuntimeIdentity(input: {
  organizationId: string;
  executionId: string;
  runtimeRunId: string;
  reasoningKeyReady?: boolean | undefined;
}) {
  await knowledgeDb
    .update(schema.environmentRunExecutions)
    .set({
      runtimeRunId: input.runtimeRunId,
      ...(input.reasoningKeyReady !== undefined ? { reasoningKeyReady: input.reasoningKeyReady } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.environmentRunExecutions.id, input.executionId),
      eq(schema.environmentRunExecutions.organizationId, input.organizationId),
    ));
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
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      runId,
      actorId: input.actorId,
      agentId: input.agentId ?? "kestrel-control-plane",
      flyAppName: input.flyAppName,
      flyMachineId: input.flyMachineId,
      capabilities: input.capabilities ?? [...ROUTE_CAPABILITIES],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: crypto.randomUUID(),
    },
  });
  return { baseUrl: input.routerUrl, authToken, runId };
}

async function recordEnvironmentExecution(input: {
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
  reasoningPolicy: {
    request: { mode: "off" | "summary" | "provider_visible"; effort?: "low" | "medium" | "high" | undefined };
    retention: { mode: "live_only" | "provider_visible"; days: number };
  };
}) {
  const thread = await knowledgeDb.query.threads.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.threadId),
          eq(table.organizationId, input.organizationId)
        ),
      columns: { projectId: true },
    });
  if (!thread) throw new Error("Environment execution Thread is unavailable.");
  if (input.projectContextRevisionId) {
    const revision = thread.projectId
      ? await knowledgeDb.query.projectContextRevisions.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, input.projectContextRevisionId!),
              eq(table.projectId, thread.projectId!)
            ),
          columns: { id: true },
        })
      : null;
    if (!revision) {
      throw new Error("Environment execution Project context is unavailable.");
    }
  }
  await knowledgeDb.insert(schema.environmentRunExecutions).values({
    id: input.id,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    projectId: thread.projectId,
    projectContextRevisionId: input.projectContextRevisionId ?? null,
    actorId: input.actorId,
    runtimeImage: input.runtimeImage,
    effectiveCapabilities: [
      ...input.routeCapabilities.map((capability) => `route:${capability}`),
      ...input.effectiveCapabilities,
    ].sort(),
    reasoningPolicySnapshot: input.reasoningPolicy,
    reasoningKeyReady: false,
  });
  return thread.projectId;
}

async function readEnvironmentReasoningPolicy(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq }) => and(
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
  if (!environment) throw new Error("Environment reasoning policy is unavailable.");
  return {
    request: {
      mode: environment.reasoningRequestMode,
      ...(environment.reasoningEffort ? { effort: environment.reasoningEffort } : {}),
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
}) {
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
            eq(table.organizationId, input.organizationId)
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
                eq(table.subjectId, input.actorId)
              ),
              and(
                eq(table.subjectType, "agent"),
                eq(table.subjectId, input.agentId)
              )
            )
          ),
      }),
    ]);
  if (!thread) throw new Error("Environment execution Thread is unavailable.");
  const installationByApp = new Map(
    installations.map((installation) => [installation.appKey, installation])
  );
  const availableDefinitions = definitions.filter(
    (definition) =>
      definition.installMode === "inherited" ||
      installationByApp.get(definition.key)?.status === "installed"
  );

  function restrictApprovalMode(inputApproval: {
    appKey: string;
    capabilityKey: string;
    approvalMode: "auto" | "ask" | "deny";
  }) {
    const matchingRestrictions = subjectRestrictions.filter(
      (restriction) =>
        restriction.providerKey === inputApproval.appKey &&
        restriction.capabilityKey === inputApproval.capabilityKey &&
        restriction.resourceId === null
    );
    if (
      matchingRestrictions.some(
        (restriction) =>
          !restriction.enabled || restriction.approvalMode === "deny"
      )
    ) {
      return null;
    }
    return matchingRestrictions.some(
      (restriction) => restriction.approvalMode === "ask"
    )
      ? "ask"
      : inputApproval.approvalMode;
  }

  if (!thread.projectId) {
    const [grants, capabilities] = await Promise.all([
      knowledgeDb.query.environmentAppCapabilityGrants.findMany({
        where: (table, { eq }) => eq(table.environmentId, input.environmentId),
      }),
      knowledgeDb.query.appCapabilities.findMany(),
    ]);
    const definitionByKey = new Map(
      availableDefinitions.map((definition) => [definition.key, definition])
    );
    const capabilityByKey = new Map(
      capabilities.map((capability) => [
        `${capability.appKey}:${capability.key}`,
        capability,
      ])
    );
    return grants.flatMap((grant) => {
      const definition = definitionByKey.get(grant.appKey);
      const capability = capabilityByKey.get(
        `${grant.appKey}:${grant.capabilityKey}`
      );
      if (
        definition?.connectionModel !== "none" ||
        !capability?.runtimeName ||
        !grant.enabled ||
        grant.approvalMode === "deny"
      ) {
        return [];
      }
      const approvalMode = restrictApprovalMode({
        appKey: grant.appKey,
        capabilityKey: grant.capabilityKey,
        approvalMode: grant.approvalMode,
      });
      return approvalMode
        ? [`app:${grant.appKey}.${grant.capabilityKey}:${approvalMode}`]
        : [];
    });
  }

  const appAccess = await resolveEffectiveProjectAppsAccess({
    organizationId: input.organizationId,
    projectId: thread.projectId,
    userId: input.actorId,
  });
  const appCapabilities = appAccess.flatMap((access) =>
    access
      ? access.capabilities.flatMap((capability) => {
          const approvalMode = restrictApprovalMode({
            appKey: access.appKey,
            capabilityKey: capability.key,
            approvalMode: capability.approvalMode,
          });
          return approvalMode
            ? [`app:${access.appKey}.${capability.key}:${approvalMode}`]
            : [];
        })
      : []
  );
  return appCapabilities;
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
  if (
    input.workspaceStatus === "stopped" ||
    input.workspaceStatus === "starting" ||
    input.workspaceStatus === "degraded"
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
