import "server-only";

import type { KestrelInteractionPresentation } from "@kestrel-agents/ai-sdk";
import {
  CONVERSATION_ATTACHMENT_MAX_COUNT,
  CONVERSATION_ATTACHMENT_MAX_TURN_BYTES,
} from "@kestrel-agents/conversation";
import {
  isRememberApprovalEligibleV1,
  parseRunnerExternalApprovalBinding,
  RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
  parseRememberedToolApprovalEvidenceSetV1,
  parseRememberedToolApprovalV1,
  parseRunnerHostedToolApprovalInteractionV2,
  parseRunnerHostedToolApprovalInteractionV3,
  parseRunnerHostedToolApprovalInteractionV4,
  RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION,
  parseRunnerStructuredReviewInteractionV1,
  resolveToolApprovalDispositionV1,
  serializeCanonicalApprovalPayload,
  type RememberedToolApprovalEvidenceV1,
  type RememberedToolApprovalV1,
  type StableToolApprovalIdentityV1,
} from "@kestrel-agents/protocol";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { shouldInvalidateGatewayCredential } from "@/lib/ai/gateway-credential-health";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isHostedMutationToolName } from "@/lib/apps/hosted-app-operation-contract";
import { getCoreAppDefinition } from "@/lib/apps/catalog";
import {
  AppOperationApprovalError,
  decideAppOperationApprovalInTransaction,
  linkAppOperationApprovalToInteractionInTransaction,
  validateAppApprovalDecisionEligibilityInTransaction,
} from "@/lib/apps/app-operation-approvals";
import { hashAppApprovalAuthority } from "@/lib/apps/app-operation-approval-contract";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { resolveKestrelOneToolCapability } from "@/lib/agent/kestrel-tool-profile";
import { meterPersistedModelMessages } from "@/lib/costs/metering";
import type { DbThreadTurn, DbThreadTurnEvent } from "@/lib/knowledge/db-types";
import {
  type MobileActivityStage,
  mobileActivity,
  mobileActivityForStage,
} from "@/lib/mobile/activity";
import {
  assertThreadTurnTransition,
  DURABLE_TURN_STOP_GRACE_MS,
  type ThreadTurnSource,
  type ThreadTurnTerminalStatus,
  terminalQueueOutcome,
} from "@/lib/turns/contracts";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";
import {
  defaultThreadWorkspaceMode,
  resolveTurnConcurrencyGroup,
} from "@/lib/turns/concurrency";
import {
  projectSafeThreadInteraction,
  setInteractionPresentationStatus,
} from "@/lib/turns/interaction-projection";
import { assertHostedApprovalOutcomeInvariant } from "@/lib/turns/outcome-invariant";
import {
  preparedApprovalQueueLockKey,
  preparedApprovalCleanupFailure,
  readPreparedApprovalCleanupFromResponse,
  schedulePreparedApprovalCleanupInTransaction,
  type PreparedApprovalCleanupV1,
} from "@/lib/turns/prepared-approval-cleanup";

export type TurnTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export class DurableTurnError extends Error {
  readonly code:
    | "TURN_NOT_FOUND"
    | "TURN_FORBIDDEN"
    | "TURN_CONFLICT"
    | "QUEUE_PAUSED"
    | "INVALID_CONTEXT_REVISION";

  constructor(code: DurableTurnError["code"], message: string) {
    super(message);
    this.name = "DurableTurnError";
    this.code = code;
  }
}

type MobileActivityMilestone = {
  id: string;
  kind:
    | "accepted"
    | "started"
    | "context_ready"
    | "capability_used"
    | "response_started"
    | "waiting"
    | "retrying"
    | "completed";
  createdAt: string;
};

const milestoneForStage: Record<
  MobileActivityStage,
  MobileActivityMilestone["kind"]
> = {
  queued: "accepted",
  preparing: "started",
  reading_context: "context_ready",
  working: "response_started",
  using_capability: "capability_used",
  finalizing: "completed",
  waiting: "waiting",
  retrying: "retrying",
};

function mobileActivityMilestones(value: unknown): MobileActivityMilestone[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MobileActivityMilestone[] => {
    if (!(entry && typeof entry === "object")) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.id === "string" &&
      typeof record.kind === "string" &&
      typeof record.createdAt === "string"
      ? [record as MobileActivityMilestone]
      : [];
  });
}

async function updateMobileTurnPresentation(
  tx: TurnTransaction,
  input: {
    turnId: string;
    stage: MobileActivityStage;
    now: Date;
    milestoneId?: string;
  },
) {
  const existing = await tx.query.threadTurnPresentations.findFirst({
    where: eq(schema.threadTurnPresentations.turnId, input.turnId),
  });
  const milestone = {
    id: input.milestoneId ?? crypto.randomUUID(),
    kind: milestoneForStage[input.stage],
    createdAt: input.now.toISOString(),
  } satisfies MobileActivityMilestone;
  const existingMilestones = mobileActivityMilestones(existing?.milestones);
  const shouldAppendMilestone =
    existing?.stage !== input.stage &&
    !existingMilestones.some((entry) => entry.id === milestone.id);
  const milestones = (
    shouldAppendMilestone
      ? [...existingMilestones, milestone]
      : existingMilestones
  ).slice(-8);
  await tx
    .insert(schema.threadTurnPresentations)
    .values({
      turnId: input.turnId,
      stage: input.stage,
      milestones,
      startedAt: existing?.startedAt ?? input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.threadTurnPresentations.turnId,
      set: { stage: input.stage, milestones, updatedAt: input.now },
    });
  return existing?.stage !== input.stage;
}

export async function recordMobileTurnRuntimeActivity(input: {
  turnId: string;
  eventId: string;
  eventType: string;
  progressCode?: string;
}) {
  const activity = mobileActivity({
    kind: "runtime_event",
    eventType: input.eventType,
    code: input.progressCode,
  });
  if (!activity) return;
  await knowledgeDb.transaction(async (tx) => {
    const changed = await updateMobileTurnPresentation(tx, {
      turnId: input.turnId,
      stage: activity.stage,
      now: new Date(),
      milestoneId: input.eventId,
    });
    if (changed) {
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "turn.activity",
        data: activity,
      });
    }
  });
}

export async function recordMobileTurnActivity(input: {
  turnId: string;
  stage: MobileActivityStage;
  milestoneId: string;
}) {
  const activity = mobileActivityForStage(input.stage);
  await knowledgeDb.transaction(async (tx) => {
    const changed = await updateMobileTurnPresentation(tx, {
      turnId: input.turnId,
      stage: input.stage,
      now: new Date(),
      milestoneId: input.milestoneId,
    });
    if (changed) {
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "turn.activity",
        data: activity,
      });
    }
  });
}

function queueLockKey(threadId: string) {
  return preparedApprovalQueueLockKey(threadId);
}

async function lockAccessibleThread(
  tx: TurnTransaction,
  input: {
    threadId: string;
    organizationId: string;
    userId: string;
    includeArchived?: boolean;
  },
) {
  const [thread] = await tx
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.id, input.threadId),
        eq(schema.threads.organizationId, input.organizationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!thread || (thread.archivedAt && !input.includeArchived)) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  if (!thread.projectId) {
    if (thread.createdByUserId !== input.userId) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
    }
    return thread;
  }
  const [membership] = await tx
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.organizationMemberId, schema.members.id),
        eq(schema.projectMembers.projectId, thread.projectId),
      ),
    )
    .where(
      and(
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
    )
    .limit(1);
  if (!membership) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  return thread;
}

async function lockPreparedApprovalCleanupThread(
  tx: TurnTransaction,
  input: { threadId: string; organizationId: string },
) {
  const [thread] = await tx
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.id, input.threadId),
        eq(schema.threads.organizationId, input.organizationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!thread) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  return thread;
}

function buildPreparedApprovalCleanupResponse(
  turn: typeof schema.threadTurns.$inferSelect,
  interaction: typeof schema.threadInteractions.$inferSelect,
  cleanup: PreparedApprovalCleanupV1,
) {
  const response = readPlainRecord(interaction.responseEnvelope);
  if (
    response === null ||
    typeof response.eventType !== "string" ||
    typeof response.message !== "string"
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Prepared approval cleanup response is invalid.",
    );
  }
  return {
    requestId: interaction.requestId,
    eventType: response.eventType,
    message: response.message,
    ...(typeof response.approved === "boolean"
      ? { approved: response.approved }
      : {}),
    decision: "decline" as const,
    decidingActor: {
      actorType: "end_user" as const,
      actorId: turn.authorUserId,
      tenantId: interaction.organizationId,
    },
    preparedApprovalCleanup: {
      version: RUNNER_PREPARED_APPROVAL_CLEANUP_VERSION,
      organizationId: interaction.organizationId,
      threadId: interaction.threadId,
      turnId: turn.id,
      interactionId: interaction.id,
      requestId: interaction.requestId,
      failureCode: cleanup.failureCode,
      failureMessage: cleanup.failureMessage,
    },
    preparedApprovalCleanupFailureCode: cleanup.failureCode,
    preparedApprovalCleanupFailureMessage: cleanup.failureMessage,
    ...(typeof response.reason === "string" ? { reason: response.reason } : {}),
  };
}

async function validateRememberApprovalEligibilityInTransaction(
  tx: TurnTransaction,
  input: {
    organizationId: string;
    projectId: string;
    environmentId: string | null;
    userId: string;
    toolName: string;
    stableToolIdentity: StableToolApprovalIdentityV1;
    presentedReasonCode: string | undefined;
    presentedRememberApprovalEligible: boolean;
  },
) {
  const binding = resolveKestrelOneToolCapability(input.toolName);
  if (
    binding === null ||
    input.stableToolIdentity.toolId !== input.toolName ||
    input.presentedRememberApprovalEligible !== true
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_ACCESS_DENIED");
  }
  const hostedAgentId =
    process.env.KESTREL_ONE_AGENT_ID?.trim() || "kestrel-one";
  const [project, definition, capability, projectApp, environmentGrant, projectPolicy] =
    await Promise.all([
      tx.query.projects.findFirst({
        where: and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
        ),
        columns: { id: true, environmentId: true },
      }),
      tx.query.appDefinitions.findFirst({
        where: and(
          eq(schema.appDefinitions.key, binding.appKey),
          eq(schema.appDefinitions.published, true),
        ),
        columns: { installMode: true },
      }),
      tx.query.appCapabilities.findFirst({
        where: and(
          eq(schema.appCapabilities.appKey, binding.appKey),
          eq(schema.appCapabilities.key, binding.capabilityKey),
        ),
        columns: { active: true, runtimeName: true },
      }),
      tx.query.projectApps.findFirst({
        where: and(
          eq(schema.projectApps.projectId, input.projectId),
          eq(schema.projectApps.appKey, binding.appKey),
        ),
        columns: { enabled: true },
      }),
      input.environmentId === null
        ? undefined
        : tx.query.environmentAppCapabilityGrants.findFirst({
            where: and(
              eq(schema.environmentAppCapabilityGrants.environmentId, input.environmentId),
              eq(schema.environmentAppCapabilityGrants.appKey, binding.appKey),
              eq(schema.environmentAppCapabilityGrants.capabilityKey, binding.capabilityKey),
            ),
          }),
      tx.query.projectAppCapabilityPolicies.findFirst({
        where: and(
          eq(schema.projectAppCapabilityPolicies.projectId, input.projectId),
          eq(schema.projectAppCapabilityPolicies.appKey, binding.appKey),
          eq(schema.projectAppCapabilityPolicies.capabilityKey, binding.capabilityKey),
        ),
      }),
    ]);
  if (
    !project ||
    input.environmentId !== project.environmentId ||
    !definition ||
    (projectApp?.enabled ?? definition.installMode === "inherited") !== true ||
    capability?.active !== true ||
    capability.runtimeName !== input.toolName ||
    environmentGrant?.enabled !== true ||
    environmentGrant.approvalMode === "deny" ||
    (projectPolicy !== undefined &&
      (projectPolicy.enabled !== true || projectPolicy.approvalMode === "deny"))
  ) {
    throw new AppOperationApprovalError(
      "APP_OPERATION_APPROVAL_POLICY_CHANGED",
    );
  }
  const subjectRestrictions =
    await tx.query.environmentCapabilitySubjectRestrictions.findMany({
      where: and(
        eq(schema.environmentCapabilitySubjectRestrictions.organizationId, input.organizationId),
        eq(schema.environmentCapabilitySubjectRestrictions.environmentId, project.environmentId),
        eq(schema.environmentCapabilitySubjectRestrictions.providerKey, binding.appKey),
        eq(schema.environmentCapabilitySubjectRestrictions.capabilityKey, binding.capabilityKey),
        isNull(schema.environmentCapabilitySubjectRestrictions.resourceId),
        or(
          and(
            eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "actor"),
            eq(schema.environmentCapabilitySubjectRestrictions.subjectId, input.userId),
          ),
          and(
            eq(schema.environmentCapabilitySubjectRestrictions.subjectType, "agent"),
            eq(schema.environmentCapabilitySubjectRestrictions.subjectId, hostedAgentId),
          ),
        ),
      ),
    });
  const subjectMode = subjectRestrictions.some(
    (restriction) => !restriction.enabled || restriction.approvalMode === "deny",
  )
    ? "deny" as const
    : subjectRestrictions.some((restriction) => restriction.approvalMode === "ask")
      ? "ask" as const
      : undefined;
  const minimum =
    getCoreAppDefinition(binding.appKey)?.capabilities.find(
      (candidate) => candidate.key === binding.capabilityKey,
    )?.minimumApprovalMode ?? "auto";
  const currentPolicy = {
    environment: environmentGrant.approvalMode,
    project: projectPolicy?.approvalMode ?? environmentGrant.approvalMode,
    ...(subjectMode === undefined ? {} : { subject: subjectMode }),
    minimum,
  };
  const disposition = resolveToolApprovalDispositionV1({
    ...currentPolicy,
    authority: {
      kind: "hosted_app_policy",
      revision: input.stableToolIdentity.approvalAuthorityRevision,
    },
  });
  if (
    disposition.reasonCode !== input.presentedReasonCode ||
    !isRememberApprovalEligibleV1({ disposition, currentPolicy })
  ) {
    throw new AppOperationApprovalError(
      "APP_OPERATION_APPROVAL_POLICY_CHANGED",
    );
  }
}

/** Persists thread-lifetime approval evidence from the exact V3 interaction. */
export async function insertRememberedToolApprovalInTransaction(
  tx: TurnTransaction,
  input: { approval: RememberedToolApprovalV1 },
): Promise<RememberedToolApprovalV1> {
  const approval = parseRememberedToolApprovalV1(input.approval);
  const [thread] = await tx
    .select({
      id: schema.threads.id,
      organizationId: schema.threads.organizationId,
      projectId: schema.threads.projectId,
    })
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.id, approval.threadId),
        eq(schema.threads.organizationId, approval.organizationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!thread?.projectId) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval requires the owning Project thread.",
    );
  }
  const [source] = await tx
    .select({
      id: schema.threadInteractions.id,
      organizationId: schema.threadInteractions.organizationId,
      threadId: schema.threadInteractions.threadId,
      kind: schema.threadInteractions.kind,
      status: schema.threadInteractions.status,
      requestEnvelope: schema.threadInteractions.requestEnvelope,
      responseEnvelope: schema.threadInteractions.responseEnvelope,
      resolvedByUserId: schema.threadInteractions.resolvedByUserId,
    })
    .from(schema.threadInteractions)
    .where(eq(schema.threadInteractions.id, approval.sourceInteractionId))
    .limit(1)
    .for("update");
  const sourceDecision = readPlainRecord(source?.responseEnvelope)?.decision;
  if (
    source === undefined ||
    source.kind !== "approval" ||
    source.status !== "processing" ||
    typeof source.resolvedByUserId !== "string" ||
    sourceDecision !== "remember_approval"
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval source interaction is not the exact remember decision by this actor.",
    );
  }
  let sourceRequest: ReturnType<typeof parseRunnerHostedToolApprovalInteractionV4>;
  try {
    sourceRequest = parseRunnerHostedToolApprovalInteractionV4(
      source.requestEnvelope,
    );
  } catch {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval source interaction does not contain exact prepared tool identity.",
    );
  }
  const sourceToolIdentity = sourceRequest.approval.stableToolIdentity;
  if (
    Date.parse(sourceRequest.approval.expiresAt) <=
    Date.parse(approval.createdAt)
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval source interaction expired before the decision.",
    );
  }
  if (
    approval.sourceInteractionId !== source.id ||
    approval.organizationId !== source.organizationId ||
    approval.threadId !== source.threadId ||
    approval.actorUserId !== source.resolvedByUserId ||
    approval.toolIdentity.toolId !== sourceToolIdentity.toolId ||
    approval.toolIdentity.descriptorContractRevision !==
      sourceToolIdentity.descriptorContractRevision ||
    approval.toolIdentity.approvalAuthorityRevision !==
      sourceToolIdentity.approvalAuthorityRevision
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval does not match the locked source interaction authority.",
    );
  }
  const [stored] = await tx
    .insert(schema.rememberedToolApprovals)
    .values({
      id: approval.id,
      version: approval.version,
      organizationId: source.organizationId,
      threadId: source.threadId,
      actorUserId: source.resolvedByUserId,
      toolId: sourceToolIdentity.toolId,
      descriptorContractRevision: sourceToolIdentity.descriptorContractRevision,
      approvalAuthorityRevision: sourceToolIdentity.approvalAuthorityRevision,
      sourceInteractionId: source.id,
      createdAt: new Date(approval.createdAt),
    })
    .returning();
  if (stored === undefined) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Remembered approval was not persisted.",
    );
  }
  return parseRememberedToolApprovalV1({
    version: stored.version,
    id: stored.id,
    organizationId: stored.organizationId,
    threadId: stored.threadId,
    actorUserId: stored.actorUserId,
    toolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: stored.toolId,
      descriptorContractRevision: stored.descriptorContractRevision,
      approvalAuthorityRevision: stored.approvalAuthorityRevision,
    },
    sourceInteractionId: stored.sourceInteractionId,
    createdAt: stored.createdAt.toISOString(),
  });
}

export async function listRememberedToolApprovalEvidenceForRuntime(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<RememberedToolApprovalEvidenceV1[]> {
  return knowledgeDb.transaction(async (tx) => {
    const thread = await lockAccessibleThread(tx, input);
    if (!thread.projectId) return [];
    const project = await tx.query.projects.findFirst({
      where: and(
        eq(schema.projects.id, thread.projectId),
        eq(schema.projects.organizationId, input.organizationId),
      ),
      columns: { id: true, environmentId: true },
    });
    if (project === undefined) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Remembered approval Project authority is unavailable.",
      );
    }
    const rows = await tx.query.rememberedToolApprovals.findMany({
      where: and(
        eq(schema.rememberedToolApprovals.organizationId, input.organizationId),
        eq(schema.rememberedToolApprovals.threadId, input.threadId),
        eq(schema.rememberedToolApprovals.actorUserId, input.userId),
      ),
      orderBy: (table, { asc }) => [
        asc(table.toolId),
        asc(table.descriptorContractRevision),
        asc(table.approvalAuthorityRevision),
      ],
    });
    return parseRememberedToolApprovalEvidenceSetV1(
      rows.map((row) => ({
        version: "remembered_tool_approval_evidence_v1",
        organizationId: row.organizationId,
        projectId: project.id,
        environmentId: project.environmentId,
        threadId: row.threadId,
        actorUserId: row.actorUserId,
        toolIdentity: {
          version: "stable_tool_approval_identity_v1",
          toolId: row.toolId,
          descriptorContractRevision: row.descriptorContractRevision,
          approvalAuthorityRevision: row.approvalAuthorityRevision,
        },
        sourceInteractionId: row.sourceInteractionId,
      })),
    );
  });
}

function extractSearchText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractSearchText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
  }
  return "";
}

async function appendTurnEvent(
  tx: TurnTransaction,
  input: { turnId: string; type: string; data?: unknown },
): Promise<DbThreadTurnEvent> {
  // The parent turn row is the single serialization authority for its event
  // sequence. Other durable-turn transactions already lock this row before
  // appending events, so taking the same lock here preserves one lock order
  // and avoids the parent-row/advisory-lock inversion that can deadlock the
  // worker during terminal persistence.
  const [turn] = await tx
    .select({ id: schema.threadTurns.id })
    .from(schema.threadTurns)
    .where(eq(schema.threadTurns.id, input.turnId))
    .limit(1)
    .for("update");
  if (!turn) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
  }
  const [latest] = await tx
    .select({ sequence: max(schema.threadTurnEvents.sequence) })
    .from(schema.threadTurnEvents)
    .where(eq(schema.threadTurnEvents.turnId, input.turnId));
  const [event] = await tx
    .insert(schema.threadTurnEvents)
    .values({
      id: crypto.randomUUID(),
      turnId: input.turnId,
      sequence: (latest?.sequence ?? 0) + 1,
      type: input.type,
      data: input.data ?? null,
    })
    .returning();
  if (!event) {
    throw new Error("Durable turn event insert failed.");
  }
  return event;
}

async function findNextQueuedTurn(
  tx: TurnTransaction,
  threadId: string,
): Promise<DbThreadTurn | null> {
  const [turn] = await tx
    .select()
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, threadId),
        eq(schema.threadTurns.status, "queued"),
      ),
    )
    .orderBy(asc(schema.threadTurns.queueOrdinal))
    .limit(1);
  return turn ?? null;
}

type DurableThreadTurnInput = {
  threadId: string;
  organizationId: string;
  authorUserId: string;
  idempotencyKey: string;
  requestedEnvironmentId: string;
  projectContextRevisionId?: string | null;
  requestedModelId?: string | null;
  requestedInteractionMode?: KestrelOneInteractionMode;
  noninteractive?: boolean;
  source: ThreadTurnSource;
} & (
  | {
      messageId: string;
      messageParts: unknown;
      attachmentIds?: string[];
      sourceMessageId?: string | null;
      approvalDecision?: undefined;
      resumeInteractionId?: undefined;
    }
  | {
      messageId?: null;
      messageParts?: undefined;
      assistantMessage?: {
        id: string;
        parts: unknown;
      };
      approvalDecision: {
        approvalId: string;
        approved: boolean;
        reason?: string | undefined;
      };
      resumeInteractionId?: undefined;
    }
  | {
      messageId?: null;
      messageParts?: undefined;
      approvalDecision?: undefined;
      resumeInteractionId: string;
    }
);

export async function createDurableThreadTurn(input: DurableThreadTurnInput) {
  return knowledgeDb.transaction((tx) =>
    createDurableThreadTurnInTransaction(tx, input),
  );
}

export async function createDurableApprovalResponseTurn(
  input: Extract<DurableThreadTurnInput, { approvalDecision: object }>,
) {
  return knowledgeDb.transaction(async (tx) => {
    const persistedInteraction = await tx.query.threadInteractions.findFirst({
      where: and(
        eq(schema.threadInteractions.organizationId, input.organizationId),
        eq(schema.threadInteractions.threadId, input.threadId),
        eq(
          schema.threadInteractions.runtimeApprovalId,
          input.approvalDecision.approvalId,
        ),
      ),
      columns: { runtimeApprovalId: true, requestEnvelope: true },
    });
    const persistedApproval = readPlainRecord(
      persistedInteraction?.requestEnvelope,
    );
    const hostedMutation = isHostedMutationToolName(
      readPlainRecord(persistedApproval?.approval)?.toolName,
    );
    await decideAppOperationApprovalInTransaction(tx, {
      organizationId: input.organizationId,
      threadId: input.threadId,
      userId: input.authorUserId,
      runtimeApprovalId:
        persistedInteraction?.runtimeApprovalId ??
        input.approvalDecision.approvalId,
      approved: input.approvalDecision.approved,
      required: hostedMutation,
      now: new Date(),
    });
    if (input.assistantMessage) {
      await tx
        .insert(schema.threadMessages)
        .values({
          id: input.assistantMessage.id,
          threadId: input.threadId,
          role: "assistant",
          authorUserId: null,
          projectContextRevisionId: input.projectContextRevisionId,
          parts: input.assistantMessage.parts,
          searchText: "",
          source: input.source,
        })
        .onConflictDoUpdate({
          target: schema.threadMessages.id,
          set: {
            parts: input.assistantMessage.parts,
            projectContextRevisionId: input.projectContextRevisionId,
            source: input.source,
          },
        });
    }
    return createDurableThreadTurnInTransaction(tx, input);
  });
}

export async function createDurableThreadTurnInTransaction(
  tx: TurnTransaction,
  input: DurableThreadTurnInput,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
  );
  const thread = await lockAccessibleThread(tx, {
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.authorUserId,
  });
  const [existing] = await tx
    .select()
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, input.threadId),
        eq(schema.threadTurns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      input.approvalDecision &&
      (existing.authorUserId !== input.authorUserId ||
        existing.approvalId !== input.approvalDecision.approvalId ||
        existing.approvalApproved !== input.approvalDecision.approved)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The approval response conflicts with the recorded decision.",
      );
    }
    const queueState = await tx.query.threadTurnQueueState.findFirst({
      where: eq(schema.threadTurnQueueState.threadId, input.threadId),
    });
    const shouldDispatch =
      existing.status === "queued" &&
      queueState?.state === "running" &&
      queueState.activeTurnId === existing.id;
    return {
      turn: existing,
      created: false,
      shouldDispatch,
      dispatchTurnId: shouldDispatch ? existing.id : null,
    };
  }
  if (input.projectContextRevisionId) {
    const [revision] = await tx
      .select({ projectId: schema.projectContextRevisions.projectId })
      .from(schema.projectContextRevisions)
      .where(
        eq(schema.projectContextRevisions.id, input.projectContextRevisionId),
      )
      .limit(1);
    if (!(revision && revision.projectId === thread.projectId)) {
      throw new DurableTurnError(
        "INVALID_CONTEXT_REVISION",
        "Project context revision does not belong to this Thread.",
      );
    }
  } else if (thread.projectId) {
    throw new DurableTurnError(
      "INVALID_CONTEXT_REVISION",
      "Project Threads require a bound context revision.",
    );
  }

  if (input.messageId) {
    const [messageConflict] = await tx
      .select({ id: schema.threadTurns.id })
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.inputMessageId, input.messageId))
      .limit(1);
    if (messageConflict) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The input message is already bound to another turn.",
      );
    }
    if (input.sourceMessageId) {
      const [sourceMessage] = await tx
        .select({
          id: schema.threadMessages.id,
          sourceMessageId: schema.threadMessages.sourceMessageId,
        })
        .from(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.id, input.sourceMessageId),
            eq(schema.threadMessages.threadId, input.threadId),
            eq(schema.threadMessages.role, "user"),
          ),
        )
        .limit(1);
      if (
        !sourceMessage ||
        (sourceMessage.sourceMessageId &&
          sourceMessage.sourceMessageId !== sourceMessage.id)
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The retry source message is unavailable.",
        );
      }
    }
  }

  const [queueState] = await tx
    .select()
    .from(schema.threadTurnQueueState)
    .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
    .limit(1)
    .for("update");
  const sequence = queueState?.nextSequence ?? 1;
  const turnId = crypto.randomUUID();
  const now = new Date();
  const requestedInteractionMode = input.requestedInteractionMode ?? "chat";
  if (input.messageId) {
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > CONVERSATION_ATTACHMENT_MAX_COUNT) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A message can include at most 20 attachments.",
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Attachment IDs must be unique.",
      );
    }
    const attachments =
      attachmentIds.length === 0
        ? []
        : await tx
            .select({
              id: schema.kestrelFiles.id,
              sizeBytes: schema.kestrelFiles.sizeBytes,
              sha256: schema.kestrelFiles.sha256,
              detectedMediaType: schema.kestrelFiles.detectedMediaType,
              lifecycleState: schema.kestrelFiles.lifecycleState,
            })
            .from(schema.kestrelFiles)
            .innerJoin(
              schema.fileScopeGrants,
              and(
                eq(schema.fileScopeGrants.fileId, schema.kestrelFiles.id),
                eq(schema.fileScopeGrants.scopeType, "thread"),
                eq(schema.fileScopeGrants.threadId, input.threadId),
                isNull(schema.fileScopeGrants.revokedAt),
              ),
            )
            .where(
              and(
                eq(schema.kestrelFiles.organizationId, input.organizationId),
                inArray(schema.kestrelFiles.id, attachmentIds),
              ),
            )
            .for("update");
    const attachmentsById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    const orderedAttachments = attachmentIds.map((attachmentId) =>
      attachmentsById.get(attachmentId),
    );
    if (
      orderedAttachments.some(
        (attachment) =>
          !attachment ||
          attachment.lifecycleState !== "ready" ||
          !attachment.sha256 ||
          !attachment.detectedMediaType,
      )
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "One or more attachments are unavailable, incomplete, or quarantined.",
      );
    }
    if (
      orderedAttachments.reduce(
        (sum, attachment) => sum + (attachment?.sizeBytes ?? 0),
        0,
      ) > CONVERSATION_ATTACHMENT_MAX_TURN_BYTES
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Attachments exceed the 500 MiB per-message limit.",
      );
    }
    const [insertedMessage] = await tx
      .insert(schema.threadMessages)
      .values({
        id: input.messageId,
        threadId: input.threadId,
        role: "user",
        authorUserId: input.authorUserId,
        projectContextRevisionId: input.projectContextRevisionId ?? null,
        parts: input.messageParts,
        searchText: extractSearchText(input.messageParts),
        source: input.source,
        sourceMessageId: input.sourceMessageId ?? null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: schema.threadMessages.id })
      .returning({ id: schema.threadMessages.id });
    if (!insertedMessage) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The input message ID is already in use.",
      );
    }
    if (attachmentIds.length > 0) {
      await tx.insert(schema.threadMessageFiles).values(
        attachmentIds.map((attachmentId, ordinal) => ({
          messageId: input.messageId,
          fileId: attachmentId,
          ordinal,
        })),
      );
    }
  }
  const [turn] = await tx
    .insert(schema.threadTurns)
    .values({
      id: turnId,
      organizationId: input.organizationId,
      threadId: input.threadId,
      authorUserId: input.authorUserId,
      inputMessageId: input.messageId ?? null,
      approvalId: input.approvalDecision?.approvalId ?? null,
      approvalApproved: input.approvalDecision?.approved ?? null,
      approvalReason: input.approvalDecision?.reason ?? null,
      resumeInteractionId: input.resumeInteractionId ?? null,
      projectContextRevisionId: input.projectContextRevisionId ?? null,
      requestedEnvironmentId: input.requestedEnvironmentId,
      idempotencyKey: input.idempotencyKey,
      sequence,
      queueOrdinal: sequence,
      source: input.source,
      requestedModelId: input.requestedModelId ?? null,
      requestedInteractionMode,
      concurrencyGroupKey: resolveTurnConcurrencyGroup(thread),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!turn) {
    throw new Error("Durable turn insert failed.");
  }
  await tx
    .update(schema.threads)
    .set({ interactionMode: requestedInteractionMode, updatedAt: now })
    .where(eq(schema.threads.id, input.threadId));
  await updateMobileTurnPresentation(tx, { turnId, stage: "queued", now });
  if (input.messageId) {
    await tx
      .update(schema.threadMessages)
      .set({ turnId })
      .where(
        and(
          eq(schema.threadMessages.id, input.messageId),
          eq(schema.threadMessages.threadId, input.threadId),
        ),
      );
  }
  await appendTurnEvent(tx, {
    turnId,
    type: "turn.queued",
    data: {
      status: "queued",
      sequence,
      ...(input.noninteractive === true ? { noninteractive: true } : {}),
    },
  });
  const resumesTerminallyPausedQueue = Boolean(
    (input.messageId || input.resumeInteractionId) &&
    queueState?.state === "paused" &&
    (queueState.pauseReason === "turn_failed" ||
      queueState.pauseReason === "turn_cancelled") &&
    !queueState.activeTurnId,
  );
  const dispatchTurnId =
    (!queueState || queueState.state === "running") && !queueState?.activeTurnId
      ? turnId
      : resumesTerminallyPausedQueue
        ? ((await findNextQueuedTurn(tx, input.threadId))?.id ?? null)
        : null;
  const shouldDispatch = dispatchTurnId !== null;
  const nextQueueState = resumesTerminallyPausedQueue
    ? "running"
    : (queueState?.state ?? "running");
  const nextPauseReason = resumesTerminallyPausedQueue
    ? null
    : (queueState?.pauseReason ?? null);
  await tx
    .insert(schema.threadTurnQueueState)
    .values({
      threadId: input.threadId,
      activeTurnId: dispatchTurnId ?? queueState?.activeTurnId ?? null,
      nextSequence: sequence + 1,
      state: nextQueueState,
      pauseReason: nextPauseReason,
      version: (queueState?.version ?? 0) + 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.threadTurnQueueState.threadId,
      set: {
        activeTurnId: dispatchTurnId ?? queueState?.activeTurnId ?? null,
        nextSequence: sequence + 1,
        state: nextQueueState,
        pauseReason: nextPauseReason,
        version: (queueState?.version ?? 0) + 1,
        updatedAt: now,
      },
    });
  await tx
    .update(schema.threads)
    .set({ updatedAt: now })
    .where(eq(schema.threads.id, input.threadId));
  return { turn, created: true, shouldDispatch, dispatchTurnId };
}

export async function createMobileThreadWithFirstTurn(
  input: DurableThreadTurnInput & { projectId: string | null },
) {
  return runMobileThreadTransaction(async (tx) => {
    const existing = await tx.query.threads.findFirst({
      where: eq(schema.threads.id, input.threadId),
    });
    if (existing) {
      if (
        existing.origin !== "mobile" ||
        existing.mode !== "chat" ||
        existing.projectId !== input.projectId
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The Thread ID is already in use.",
        );
      }
    } else {
      const now = new Date();
      const [thread] = await tx
        .insert(schema.threads)
        .values({
          id: input.threadId,
          createdByUserId: input.authorUserId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          workspaceMode: defaultThreadWorkspaceMode(input.projectId),
          mode: "chat",
          origin: "mobile",
          activeStreamId: null,
          title: "",
          isPublic: false,
          shareToken: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!thread) {
        throw new Error("Thread creation failed.");
      }
      if (input.projectId) {
        await tx.insert(schema.projectAuditEvents).values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          actorUserId: input.authorUserId,
          action: "thread.created",
          targetType: "thread",
          targetId: input.threadId,
          createdAt: now,
        });
      }
    }
    return createDurableThreadTurnInTransaction(tx, input);
  });
}

async function runMobileThreadTransaction<T>(
  callback: (tx: TurnTransaction) => Promise<T>,
): Promise<T> {
  return knowledgeDb.transaction(callback);
}

function branchMessageParts(value: unknown) {
  if (!Array.isArray(value)) return [];
  const durableTypes = new Set([
    "text",
    "source-url",
    "source-document",
    "data-kestrel-citation",
    "data-kestrel-artifact",
  ]);
  return value.filter((part) => {
    if (!(part && typeof part === "object" && !Array.isArray(part)))
      return false;
    const type = (part as Record<string, unknown>).type;
    return typeof type === "string" && durableTypes.has(type);
  });
}

export async function createMobileThreadBranchWithFirstTurn(
  input: DurableThreadTurnInput & {
    projectId: string | null;
    parentThreadId: string;
    anchorMessageId: string;
    workspaceBaseRef?: string | null;
  },
) {
  return knowledgeDb.transaction(async (tx) => {
    const parent = await lockAccessibleThread(tx, {
      threadId: input.parentThreadId,
      organizationId: input.organizationId,
      userId: input.authorUserId,
    });
    if (parent.mode !== "chat" || parent.projectId !== input.projectId) {
      throw new DurableTurnError("TURN_CONFLICT", "Branch context changed.");
    }
    const [anchor] = await tx
      .select()
      .from(schema.threadMessages)
      .where(
        and(
          eq(schema.threadMessages.id, input.anchorMessageId),
          eq(schema.threadMessages.threadId, input.parentThreadId),
        ),
      )
      .limit(1);
    if (!anchor) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Branch anchor not found.");
    }
    const existing = await tx.query.threads.findFirst({
      where: eq(schema.threads.id, input.threadId),
    });
    if (existing) {
      if (
        existing.origin !== "mobile" ||
        existing.mode !== "chat" ||
        existing.parentThreadId !== input.parentThreadId ||
        existing.branchAnchorMessageId !== input.anchorMessageId
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The Thread ID is already in use.",
        );
      }
      return createDurableThreadTurnInTransaction(tx, input);
    }

    const now = new Date();
    const [thread] = await tx
      .insert(schema.threads)
      .values({
        id: input.threadId,
        createdByUserId: input.authorUserId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        branchAnchorMessageId: input.anchorMessageId,
        mode: "chat",
        origin: "mobile",
        workspaceMode: parent.workspaceMode,
        workspaceBaseRef: input.workspaceBaseRef ?? null,
        activeStreamId: null,
        title: "",
        isPublic: false,
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!thread) throw new Error("Branch creation failed.");

    const prefix = await tx
      .select()
      .from(schema.threadMessages)
      .where(
        and(
          eq(schema.threadMessages.threadId, input.parentThreadId),
          or(
            lt(schema.threadMessages.createdAt, anchor.createdAt),
            and(
              eq(schema.threadMessages.createdAt, anchor.createdAt),
              lte(schema.threadMessages.id, anchor.id),
            ),
          ),
        ),
      )
      .orderBy(
        asc(schema.threadMessages.createdAt),
        asc(schema.threadMessages.id),
      );
    if (prefix.length > 0) {
      await tx.insert(schema.threadMessages).values(
        prefix.map((message) => ({
          id: crypto.randomUUID(),
          threadId: input.threadId,
          turnId: null,
          role: message.role,
          authorUserId: message.authorUserId,
          projectContextRevisionId: message.projectContextRevisionId,
          parts: branchMessageParts(message.parts),
          searchText: message.searchText,
          source: "mobile" as const,
          sourceMessageId: message.id,
          createdAt: message.createdAt,
        })),
      );
    }
    if (input.projectId) {
      await tx.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        actorUserId: input.authorUserId,
        action: "thread.created",
        targetType: "thread",
        targetId: input.threadId,
        createdAt: now,
      });
    }
    return createDurableThreadTurnInTransaction(tx, input);
  });
}

export async function reorderDurableThreadQueue(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  expectedVersion: number;
  orderedQueuedTurnIds: string[];
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    await lockAccessibleThread(tx, input);
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    if (!queueState || queueState.version !== input.expectedVersion) {
      throw new DurableTurnError("TURN_CONFLICT", "Queue version changed.");
    }
    const queued = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.threadId, input.threadId),
          eq(schema.threadTurns.status, "queued"),
        ),
      )
      .orderBy(asc(schema.threadTurns.queueOrdinal));
    const currentIds = queued.map((turn) => turn.id);
    if (
      currentIds.length !== input.orderedQueuedTurnIds.length ||
      currentIds.some((id) => !input.orderedQueuedTurnIds.includes(id))
    ) {
      throw new DurableTurnError("TURN_CONFLICT", "Queued Turns changed.");
    }
    const ordinals = queued
      .map((turn) => turn.queueOrdinal)
      .sort((a, b) => a - b);
    for (const [index, turnId] of input.orderedQueuedTurnIds.entries()) {
      await tx
        .update(schema.threadTurns)
        .set({ queueOrdinal: ordinals[index], updatedAt: new Date() })
        .where(eq(schema.threadTurns.id, turnId));
    }
    const now = new Date();
    await tx
      .update(schema.threadTurnQueueState)
      .set({ version: queueState.version + 1, updatedAt: now })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    if (queueState.activeTurnId) {
      await appendTurnEvent(tx, {
        turnId: queueState.activeTurnId,
        type: "queue.reordered",
        data: { version: queueState.version + 1 },
      });
    }
    return { threadId: input.threadId, version: queueState.version + 1 };
  });
}

export async function claimDurableThreadTurn(
  turnId: string,
  options: { resumeRunning?: boolean } = {},
) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turnId))
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    const [capacity] = await tx
      .select()
      .from(schema.platformTurnWorkerCapacity)
      .where(eq(schema.platformTurnWorkerCapacity.id, "default"))
      .limit(1)
      .for("update");
    if (!capacity) {
      throw new Error("Turn Worker capacity configuration is unavailable.");
    }
    if (
      capacity.admissionClosedUntil &&
      capacity.admissionClosedUntil.getTime() > Date.now()
    ) {
      return null;
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    const maintenanceInteraction = candidate.resumeInteractionId
      ? await tx.query.threadInteractions.findFirst({
          where: and(
            eq(schema.threadInteractions.id, candidate.resumeInteractionId),
            eq(schema.threadInteractions.source, "runtime"),
            eq(schema.threadInteractions.status, "processing"),
          ),
        })
      : candidate.status === "waiting_for_input" ||
          (options.resumeRunning && candidate.status === "running")
        ? await tx.query.threadInteractions.findFirst({
            where: and(
              eq(schema.threadInteractions.turnId, candidate.id),
              eq(schema.threadInteractions.source, "runtime"),
              eq(schema.threadInteractions.status, "processing"),
              options.resumeRunning && candidate.status === "running"
                ? undefined
                : isNull(schema.threadInteractions.resumedAt),
            ),
            orderBy: (table, { asc }) => [asc(table.resolvedAt)],
          })
        : null;
    const maintenanceCleanup = readPreparedApprovalCleanupFromResponse(
      maintenanceInteraction?.responseEnvelope,
    );
    const isCanonicalMaintenanceClaim =
      maintenanceCleanup !== null &&
      maintenanceInteraction?.organizationId === candidate.organizationId &&
      maintenanceInteraction.threadId === candidate.threadId &&
      maintenanceInteraction.turnId === candidate.id;
    const thread = isCanonicalMaintenanceClaim
      ? await lockPreparedApprovalCleanupThread(tx, {
          threadId: candidate.threadId,
          organizationId: candidate.organizationId,
        })
      : await lockAccessibleThread(tx, {
          threadId: candidate.threadId,
          organizationId: candidate.organizationId,
          userId: candidate.authorUserId,
        });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (
      !turn ||
      queueState?.state !== "running" ||
      queueState.activeTurnId !== turn.id
    ) {
      return null;
    }
    const isInitialClaim = turn.status === "queued";
    const interactionWhere = turn.resumeInteractionId
      ? and(
          eq(schema.threadInteractions.id, turn.resumeInteractionId),
          eq(schema.threadInteractions.source, "runtime"),
          eq(schema.threadInteractions.status, "processing"),
          options.resumeRunning && turn.status === "running"
            ? undefined
            : isNull(schema.threadInteractions.resumedAt),
        )
      : turn.status === "waiting_for_input" ||
          (options.resumeRunning && turn.status === "running")
        ? and(
            eq(schema.threadInteractions.turnId, turn.id),
            eq(schema.threadInteractions.source, "runtime"),
            eq(schema.threadInteractions.status, "processing"),
            options.resumeRunning && turn.status === "running"
              ? undefined
              : isNull(schema.threadInteractions.resumedAt),
          )
        : undefined;
    const [interaction] = interactionWhere
      ? await tx
          .select()
          .from(schema.threadInteractions)
          .where(interactionWhere)
          .orderBy(asc(schema.threadInteractions.resolvedAt))
          .limit(1)
          .for("update")
      : [];
    const isRunningResume = options.resumeRunning && turn.status === "running";
    if (!(isInitialClaim || interaction || isRunningResume)) {
      return null;
    }
    const resumedCleanup = readPreparedApprovalCleanupFromResponse(
      interaction?.responseEnvelope,
    );
    if (
      isCanonicalMaintenanceClaim &&
      (interaction?.id !== maintenanceInteraction?.id ||
        resumedCleanup === null ||
        interaction.organizationId !== turn.organizationId ||
        interaction.threadId !== turn.threadId ||
        interaction.turnId !== turn.id)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Prepared approval cleanup binding changed during claim.",
      );
    }
    if (isRunningResume) {
      return {
        ...turn,
        interactionResponse:
          interaction && resumedCleanup
            ? buildPreparedApprovalCleanupResponse(turn, interaction, resumedCleanup)
            : null,
      };
    }
    const concurrencyGroupKey =
      turn.concurrencyGroupKey ?? resolveTurnConcurrencyGroup(thread);
    const [groupConflict] = await tx
      .select({ id: schema.threadTurns.id })
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.concurrencyGroupKey, concurrencyGroupKey),
          eq(schema.threadTurns.status, "running"),
          ne(schema.threadTurns.id, turn.id),
        ),
      )
      .limit(1);
    if (groupConflict) return null;
    assertThreadTurnTransition(turn.status, "running");
    const now = new Date();
    const [running] = await tx
      .update(schema.threadTurns)
      .set({
        concurrencyGroupKey,
        status: "running",
        startedAt: turn.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.running",
      data: {
        status: "running",
        ...(interaction ? { resumedRequestId: interaction.requestId } : {}),
      },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: interaction ? "retrying" : "preparing",
      now,
    });
    if (interaction) {
      await tx
        .update(schema.threadInteractions)
        .set({ resumedAt: now, updatedAt: now })
        .where(eq(schema.threadInteractions.id, interaction.id));
    }
    const response = readPlainRecord(interaction?.responseEnvelope);
    const preparedApprovalCleanup = resumedCleanup;
    const hostedApproval =
      interaction && preparedApprovalCleanup === null
        ? parseHostedPreparedApprovalInteraction(interaction)
        : null;
    const decidingActor =
      preparedApprovalCleanup !== null && interaction
        ? {
            actorType: "end_user" as const,
            actorId: turn.authorUserId,
            tenantId: interaction.organizationId,
          }
        : hostedApproval &&
      (response?.decision === "decline" ||
        response?.decision === "approve_once" ||
        response?.decision === "remember_approval")
        ? hostedApproval.approval.requestingActor
        : undefined;
    if (
      decidingActor !== undefined &&
      preparedApprovalCleanup === null &&
      (decidingActor.actorType !== "end_user" ||
        decidingActor.actorId !== interaction?.resolvedByUserId ||
        decidingActor.tenantId !== interaction?.organizationId)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The hosted approval deciding actor is invalid.",
      );
    }
    return running
      ? {
          ...running,
          interactionResponse:
            interaction &&
            response &&
            typeof response.eventType === "string" &&
            typeof response.message === "string"
              ? {
                  requestId: interaction.requestId,
                  eventType: response.eventType,
                  message: response.message,
                  ...(typeof response.approved === "boolean"
                    ? { approved: response.approved }
                    : {}),
                  ...(preparedApprovalCleanup !== null ||
                  response.decision === "decline" ||
                  response.decision === "approve_once" ||
                  response.decision === "remember_approval"
                    ? {
                        decision:
                          preparedApprovalCleanup !== null
                            ? "decline" as const
                            : response.decision as
                                | "decline"
                                | "approve_once"
                                | "remember_approval",
                        decidingActor: {
                          actorType: decidingActor!.actorType,
                          actorId: decidingActor!.actorId,
                          tenantId: decidingActor!.tenantId,
                        },
                      }
                    : {}),
                  ...(preparedApprovalCleanup === null || !interaction
                    ? {}
                    : buildPreparedApprovalCleanupResponse(
                        turn,
                        interaction,
                        preparedApprovalCleanup,
                      )),
                  ...(typeof response.reason === "string"
                    ? { reason: response.reason }
                    : {}),
                  ...(typeof response.recoveryOptionId === "string"
                    ? { recoveryOptionId: response.recoveryOptionId }
                    : {}),
                }
              : null,
        }
      : null;
  });
}

export type DurableAssistantOutcomeMessage = {
  id: string;
  parts: unknown;
  model: string;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  durationMs?: number | undefined;
  source: ThreadTurnSource;
  projectContextRevisionId: string | null;
};

export type DurableReplayChunk = {
  type: string;
  [key: string]: unknown;
};

async function appendDurableReplayChunks(
  tx: TurnTransaction,
  turnId: string,
  chunks: readonly DurableReplayChunk[],
) {
  for (const chunk of chunks) {
    await appendTurnEvent(tx, {
      turnId,
      type: "ui.message",
      data: chunk,
    });
  }
}

async function persistDurableAssistantMessages(
  tx: TurnTransaction,
  input: {
    turn: DbThreadTurn;
    messages: DurableAssistantOutcomeMessage[];
    now: Date;
    bindMcpInteractions: boolean;
  },
) {
  const mcpInteractions = await tx.query.threadInteractions.findMany({
    where: and(
      eq(schema.threadInteractions.turnId, input.turn.id),
      eq(schema.threadInteractions.source, "mcp"),
    ),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  const messages = input.messages
    .flatMap(splitDialogPresentationMessages)
    .map((message) => ({
      ...message,
      parts:
        message.dialog === undefined
          ? appendInteractionPresentationParts(
              message.parts,
              mcpInteractions.map((interaction) => ({
                requestId: interaction.requestId,
                kind: interaction.kind,
                eventType: interaction.eventType,
                prompt: interaction.prompt,
                requestEnvelope: interaction.requestEnvelope,
                source: "mcp" as const,
                status: interaction.status,
              })),
            )
          : message.parts,
    }));
  const turnMessages = messages.filter(
    (message) => message.dialog === undefined,
  );
  const dialogs = [
    ...new Map(
      messages.flatMap((message) =>
        message.dialog === undefined
          ? []
          : [[message.dialog.dialogId, message.dialog] as const],
      ),
    ).values(),
  ];
  if (dialogs.length > 0) {
    await tx
      .insert(schema.threadDialogs)
      .values(
        dialogs.map((dialog) => ({
          id: dialog.dialogId,
          threadId: input.turn.threadId,
          runtimeChildThreadId: dialog.childSessionId,
          name: dialog.name,
          status: dialog.status,
          createdAt: dialog.createdAt,
          updatedAt: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: schema.threadDialogs.id,
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          updatedAt: input.now,
        },
      });
  }
  if (messages.length > 0) {
    await tx
      .insert(schema.threadMessages)
      .values(
        messages.map((message) => ({
          id: message.id,
          threadId: input.turn.threadId,
          turnId: message.dialog === undefined ? input.turn.id : null,
          role: "assistant" as const,
          authorUserId: null,
          projectContextRevisionId: message.projectContextRevisionId,
          parts: message.parts,
          searchText: extractSearchText(message.parts),
          model: message.model,
          inputTokens: message.inputTokens ?? null,
          cachedInputTokens: message.cachedInputTokens ?? null,
          outputTokens: message.outputTokens ?? null,
          reasoningTokens: message.reasoningTokens ?? null,
          durationMs: message.durationMs ?? null,
          source: message.source,
          ...(message.dialog !== undefined
            ? {
                dialogId: message.dialog.dialogId,
                dialogMessageId: message.dialog.messageId,
                dialogName: message.dialog.name,
                dialogSender: message.dialog.sender,
              }
            : {}),
          createdAt: message.dialog?.createdAt ?? input.now,
        })),
      )
      .onConflictDoUpdate({
        target: schema.threadMessages.id,
        set: {
          parts: sql`excluded.parts`,
          searchText: sql`excluded.search_text`,
          model: sql`excluded.model`,
          inputTokens: sql`excluded.input_tokens`,
          cachedInputTokens: sql`excluded.cached_input_tokens`,
          outputTokens: sql`excluded.output_tokens`,
          reasoningTokens: sql`excluded.reasoning_tokens`,
          durationMs: sql`excluded.duration_ms`,
          turnId: sql`excluded.turn_id`,
        },
      });
    await tx
      .update(schema.threadTurns)
      .set({
        outputMessageId: turnMessages.at(-1)?.id ?? null,
        updatedAt: input.now,
      })
      .where(eq(schema.threadTurns.id, input.turn.id));
  }
  await tx
    .update(schema.threads)
    .set({ updatedAt: input.now })
    .where(eq(schema.threads.id, input.turn.threadId));

  const assistantMessageId = turnMessages.at(-1)?.id ?? null;
  if (
    input.bindMcpInteractions &&
    assistantMessageId &&
    mcpInteractions.length > 0
  ) {
    await tx
      .update(schema.threadInteractions)
      .set({ assistantMessageId, updatedAt: input.now })
      .where(
        and(
          eq(schema.threadInteractions.turnId, input.turn.id),
          eq(schema.threadInteractions.source, "mcp"),
        ),
      );
  }
  return assistantMessageId;
}

async function meterDurableAssistantMessages(
  messages: DurableAssistantOutcomeMessage[],
) {
  await meterPersistedModelMessages(
    messages.map((message) => message.id),
  ).catch((error) => {
    console.error(
      "Model usage metering will retry from the durable message ledger.",
      {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    );
  });
}

export async function persistDurableAssistantOutcome(input: {
  turnId: string;
  messages: DurableAssistantOutcomeMessage[];
  interaction: KestrelInteractionPresentation | null;
  sourceRuntimeRunId?: string | undefined;
  runtimeApprovalId?: string | undefined;
  replayChunks?: readonly DurableReplayChunk[];
}) {
  const result = await knowledgeDb.transaction(async (tx) => {
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!turn) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    const now = new Date();
    const assistantMessageId = await persistDurableAssistantMessages(tx, {
      turn,
      messages: input.messages,
      now,
      bindMcpInteractions: !input.interaction,
    });

    if (!input.interaction) {
      await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
      return { turn, interaction: null };
    }
    if (turn.status !== "running") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only a running turn can publish a pending interaction.",
      );
    }
    if (!assistantMessageId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A pending interaction must be attached to an assistant message.",
      );
    }
    if (
      input.interaction.kind !== "user_input" &&
      input.interaction.kind !== "approval"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "A runtime turn can only publish a runtime interaction kind.",
      );
    }
    const [requestConflict] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        eq(schema.threadInteractions.requestId, input.interaction.requestId),
      )
      .limit(1);
    if (requestConflict && requestConflict.turnId !== turn.id) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction request ID is already in use.",
      );
    }
    const requestEnvelope = {
      version: input.interaction.version,
      requestId: input.interaction.requestId,
      kind: input.interaction.kind,
      eventType: input.interaction.eventType,
      prompt: input.interaction.prompt,
      ...(input.interaction.inputSchema
        ? { inputSchema: input.interaction.inputSchema }
        : {}),
      ...(input.interaction.metadata
        ? { metadata: input.interaction.metadata }
        : {}),
      ...(input.interaction.approval
        ? { approval: input.interaction.approval }
        : {}),
    };
    const [interaction] = await tx
      .insert(schema.threadInteractions)
      .values({
        id: requestConflict?.id ?? crypto.randomUUID(),
        requestId: input.interaction.requestId,
        organizationId: turn.organizationId,
        threadId: turn.threadId,
        turnId: turn.id,
        assistantMessageId,
        source: "runtime",
        kind: input.interaction.kind,
        eventType: input.interaction.eventType,
        prompt: input.interaction.prompt,
        status: "pending",
        requestEnvelope,
        sourceRuntimeRunId: input.sourceRuntimeRunId ?? null,
        runtimeApprovalId: input.runtimeApprovalId ?? null,
        createdAt: requestConflict?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadInteractions.requestId,
        set: {
          assistantMessageId,
          prompt: input.interaction.prompt,
          requestEnvelope,
          sourceRuntimeRunId: input.sourceRuntimeRunId ?? null,
          runtimeApprovalId: input.runtimeApprovalId ?? null,
          updatedAt: now,
        },
      })
      .returning();
    if (
      interaction &&
      input.runtimeApprovalId &&
      input.interaction.kind === "approval" &&
      isHostedMutationToolName(input.interaction.approval?.toolName)
    ) {
      await linkAppOperationApprovalToInteractionInTransaction(tx, {
        organizationId: turn.organizationId,
        threadId: turn.threadId,
        runtimeApprovalId: input.runtimeApprovalId,
        interactionId: interaction.id,
        now,
      });
    }
    assertThreadTurnTransition(turn.status, "waiting_for_input");
    const [waiting] = await tx
      .update(schema.threadTurns)
      .set({ status: "waiting_for_input", updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    if (queueState?.activeTurnId !== turn.id) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The waiting turn is no longer active.",
      );
    }
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: "paused",
        pauseReason: "interaction_required",
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "interaction.required",
      data: {
        requestId: input.interaction.requestId,
        kind: input.interaction.kind,
        eventType: input.interaction.eventType,
        assistantMessageId,
        status: "waiting_for_input",
      },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: "waiting",
      now,
    });
    const devices = await tx
      .select({ id: schema.mobileDeviceRegistrations.id })
      .from(schema.mobileDeviceRegistrations)
      .where(
        and(
          eq(schema.mobileDeviceRegistrations.userId, turn.authorUserId),
          eq(schema.mobileDeviceRegistrations.enabled, true),
        ),
      );
    if (devices.length > 0) {
      await tx
        .insert(schema.mobilePushDeliveries)
        .values(
          devices.map((device) => ({
            id: crypto.randomUUID(),
            deviceRegistrationId: device.id,
            organizationId: turn.organizationId,
            threadId: turn.threadId,
            turnId: turn.id,
            kind: "attention" as const,
            status: "pending" as const,
          })),
        )
        .onConflictDoNothing({
          target: [
            schema.mobilePushDeliveries.turnId,
            schema.mobilePushDeliveries.deviceRegistrationId,
            schema.mobilePushDeliveries.kind,
          ],
        });
    }
    return { turn: waiting ?? turn, interaction: interaction ?? null };
  });
  await meterDurableAssistantMessages(input.messages);
  return result;
}

function splitDialogPresentationMessages<
  T extends { id: string; parts: unknown },
>(
  message: T,
): Array<
  T & {
    dialog?: {
      dialogId: string;
      messageId: string;
      name: string;
      childSessionId: string;
      sender: "kestrel" | "collaborator" | "system";
      createdAt: Date;
      status: "open" | "closed";
    };
  }
> {
  if (!Array.isArray(message.parts)) return [message];
  const dialogParts = message.parts.filter((part) =>
    isDialogPresentationPart(part),
  );
  if (dialogParts.length === 0) return [message];
  const ordinaryParts = message.parts.filter(
    (part) => !isDialogPresentationPart(part),
  );
  const result: Array<
    T & {
      dialog?: {
        dialogId: string;
        messageId: string;
        name: string;
        childSessionId: string;
        sender: "kestrel" | "collaborator" | "system";
        createdAt: Date;
        status: "open" | "closed";
      };
    }
  > = [];
  if (ordinaryParts.length > 0)
    result.push({ ...message, parts: ordinaryParts });
  for (const part of dialogParts) {
    const data = (
      part as {
        data: {
          dialogId: string;
          messageId: string;
          name: string;
          childSessionId: string;
          sender: "kestrel" | "collaborator" | "system";
          createdAt: string;
          dialogStatus: "open" | "closed";
          status?: "failed" | "cancelled";
        };
      }
    ).data;
    result.push({
      ...message,
      id: data.messageId,
      parts: [part],
      dialog: {
        dialogId: data.dialogId,
        messageId: data.messageId,
        name: data.name,
        childSessionId: data.childSessionId,
        sender: data.sender,
        createdAt: new Date(data.createdAt),
        status: data.dialogStatus,
      },
    });
  }
  return result;
}

function isDialogPresentationPart(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const part = value as Record<string, unknown>;
  if (
    part.type !== "data-kestrel-dialog-message" ||
    typeof part.data !== "object" ||
    part.data === null ||
    Array.isArray(part.data)
  )
    return false;
  const data = part.data as Record<string, unknown>;
  return (
    typeof data.dialogId === "string" &&
    typeof data.messageId === "string" &&
    typeof data.name === "string" &&
    typeof data.childSessionId === "string" &&
    (data.sender === "kestrel" ||
      data.sender === "collaborator" ||
      data.sender === "system") &&
    typeof data.createdAt === "string" &&
    (data.dialogStatus === "open" || data.dialogStatus === "closed")
  );
}

export async function resolveDurableRuntimeInteraction(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  eventType: string;
  turnId: string;
  message: string;
  approved?: boolean | undefined;
  decision?: "decline" | "approve_once" | "remember_approval" | undefined;
  reason?: string | undefined;
  recoveryOptionId?: string | undefined;
  messageId: string;
  source: ThreadTurnSource;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const accessibleThread = await lockAccessibleThread(tx, input);
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.threadId, input.threadId),
          eq(schema.threadInteractions.organizationId, input.organizationId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction?.turnId) {
      throw new DurableTurnError(
        "TURN_NOT_FOUND",
        "Pending runtime interaction not found.",
      );
    }
    if (interaction.turnId !== input.turnId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response turn does not match the pending request.",
      );
    }
    if (interaction.eventType !== input.eventType) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response event type does not match the pending request.",
      );
    }
    const requestEnvelopeRecord = readPlainRecord(interaction.requestEnvelope);
    const rawHostedApprovalVersion = requestEnvelopeRecord?.version;
    const isRawPreparedApproval =
      interaction.kind === "approval" &&
      (rawHostedApprovalVersion ===
        "runner_hosted_tool_approval_interaction_v2" ||
        rawHostedApprovalVersion ===
          "runner_hosted_tool_approval_interaction_v3" ||
        rawHostedApprovalVersion ===
          "runner_hosted_tool_approval_interaction_v4");
    const existingCleanup = readPreparedApprovalCleanupFromResponse(
      interaction.responseEnvelope,
    );
    let hostedApproval: ReturnType<
      typeof parseHostedPreparedApprovalInteraction
    > = null;
    let hostedApprovalMalformed = false;
    let hostedApprovalActorMismatch = false;
    if (existingCleanup === null) {
      try {
        hostedApproval = parseHostedPreparedApprovalInteraction(interaction);
      } catch (error) {
        if (!isRawPreparedApproval) throw error;
        hostedApprovalMalformed = true;
      }
    }
    const decision =
      input.decision ??
      ((hostedApproval?.version ?? rawHostedApprovalVersion) ===
          "runner_hosted_tool_approval_interaction_v3" &&
        typeof input.approved === "boolean"
        ? input.approved
          ? "approve_once"
          : "decline"
        : undefined);
    const approved =
      (hostedApproval?.version ?? rawHostedApprovalVersion) ===
        "runner_hosted_tool_approval_interaction_v3" ||
      (hostedApproval?.version ?? rawHostedApprovalVersion) ===
        "runner_hosted_tool_approval_interaction_v4"
        ? undefined
        : input.approved;
    if (
      hostedApproval !== null &&
      (hostedApproval.approval.requestingActor.actorType !== "end_user" ||
        hostedApproval.approval.requestingActor.actorId !== input.userId ||
        hostedApproval.approval.requestingActor.tenantId !== input.organizationId)
    ) {
      hostedApprovalActorMismatch = true;
    }
    if (
      interaction.status === "processing" ||
      interaction.status === "resolved" ||
      interaction.status === "failed"
    ) {
      const recordedResponse = readPlainRecord(interaction.responseEnvelope);
      if (
        interaction.resolvedByUserId !== input.userId ||
        (interaction.kind === "approval" &&
          (recordedResponse?.decision !== undefined || decision !== undefined
            ? recordedResponse?.decision !== decision
            : recordedResponse?.approved !== approved))
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The interaction response conflicts with the recorded decision.",
        );
      }
      const [resolvedEvent] = await tx
        .select({ sequence: schema.threadTurnEvents.sequence })
        .from(schema.threadTurnEvents)
        .where(
          and(
            eq(schema.threadTurnEvents.turnId, interaction.turnId),
            inArray(schema.threadTurnEvents.type, [
              "interaction.decision_recorded",
              "interaction.cleanup_requested",
            ]),
            sql`${schema.threadTurnEvents.data}->>'requestId' = ${input.requestId}`,
          ),
        )
        .orderBy(desc(schema.threadTurnEvents.sequence))
        .limit(1);
      return {
        turnId: interaction.turnId,
        shouldDispatch: false,
        replayAfterSequence: resolvedEvent?.sequence ?? 0,
      };
    }
    if (interaction.status !== "pending") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The runtime interaction is no longer pending.",
      );
    }
    let invalidPreparedDecision = false;
    if (interaction.kind === "approval") {
      const validDecision = hostedApproval
        ? approved === undefined &&
          (decision === "decline" ||
            decision === "approve_once" ||
            (hostedApproval.version ===
              "runner_hosted_tool_approval_interaction_v4" &&
              decision === "remember_approval"))
        : decision === undefined && typeof approved === "boolean";
      if (!validDecision) {
        if (
          isRawPreparedApproval &&
          (decision !== undefined || typeof approved === "boolean")
        ) {
          invalidPreparedDecision = true;
        } else {
          throw new DurableTurnError(
            "TURN_CONFLICT",
            "The approval decision does not match its version.",
          );
        }
      }
    }
    const structuredReview = parseRunnerStructuredReviewInteractionV1(
      interaction.requestEnvelope,
    );
    if (structuredReview.kind === "invalid_review") {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "This structured review cannot be answered safely. End the waiting turn.",
      );
    }
    if (
      structuredReview.kind === "structured_review" &&
      (input.recoveryOptionId === undefined ||
        !structuredReview.allowedOptionIds.some(
          (optionId) => optionId === input.recoveryOptionId,
        ))
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response must select one exact allowed recovery option.",
      );
    }
    const inputSchema = readPlainRecord(
      interaction.requestEnvelope,
    )?.inputSchema;
    const inputContract = readPlainRecord(inputSchema);
    const properties = readPlainRecord(inputContract?.properties);
    const optionSchema = readPlainRecord(properties?.recoveryOptionId);
    const allowedOptionIds = Array.isArray(optionSchema?.enum)
      ? optionSchema.enum.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const requiresRecoveryOption =
      Array.isArray(inputContract?.required) &&
      inputContract.required.includes("recoveryOptionId");
    if (
      (structuredReview.kind === "ordinary" &&
        requiresRecoveryOption &&
        input.recoveryOptionId === undefined) ||
      (input.recoveryOptionId !== undefined &&
        allowedOptionIds.includes(input.recoveryOptionId) === false)
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The interaction response must select one exact allowed recovery option.",
      );
    }
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, interaction.turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    if (
      turn?.status !== "waiting_for_input" ||
      queueState?.activeTurnId !== turn.id ||
      queueState.state !== "paused" ||
      queueState.pauseReason !== "interaction_required"
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The pending interaction does not own the active waiting turn.",
      );
    }
    if (
      (hostedApprovalMalformed ||
        hostedApprovalActorMismatch ||
        invalidPreparedDecision) &&
      turn.authorUserId !== input.userId
    ) {
      throw new DurableTurnError(
        "TURN_FORBIDDEN",
        "Only the waiting turn author may reject invalid prepared authority.",
      );
    }
    const now = new Date();
    const responseEnvelope = {
      requestId: input.requestId,
      eventType: input.eventType,
      message: input.message,
      messageId: input.messageId,
      ...(typeof approved === "boolean"
        ? { approved }
        : {}),
      ...(decision !== undefined ? { decision } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.recoveryOptionId !== undefined
        ? { recoveryOptionId: input.recoveryOptionId }
        : {}),
    };
    await tx.insert(schema.threadMessages).values({
      id: input.messageId,
      threadId: input.threadId,
      turnId: turn.id,
      role: "user",
      authorUserId: input.userId,
      projectContextRevisionId: turn.projectContextRevisionId,
      parts: [{ type: "text", text: input.message }],
      searchText: input.message,
      source: input.source,
      createdAt: now,
    });
    const requestEnvelope = readPlainRecord(interaction.requestEnvelope);
    const approvalEnvelope = readPlainRecord(requestEnvelope?.approval);
    const hostedMutation = isHostedMutationToolName(approvalEnvelope?.toolName);
    const presentation = readPlainRecord(hostedApproval?.approval.presentation);
    const presentationPolicy = readPlainRecord(presentation?.policy);
    const approvesPreparedDecision =
      decision === "approve_once" || decision === "remember_approval";
    const approvesCurrentInvocation =
      approvesPreparedDecision || approved === true;
    let preparedApprovalCleanup: PreparedApprovalCleanupV1 | null =
      hostedApprovalMalformed ||
      hostedApprovalActorMismatch ||
      invalidPreparedDecision
        ? preparedApprovalCleanupFailure(
            "EXTERNAL_APPROVAL_IDENTITY_MISMATCH",
          )
        : null;
    if (
      preparedApprovalCleanup === null &&
      (hostedMutation || approvesPreparedDecision)
    ) {
      try {
        if (
          decision === "remember_approval" &&
          (hostedApproval?.version !==
            "runner_hosted_tool_approval_interaction_v4" ||
            !accessibleThread.projectId ||
            (presentationPolicy?.reasonCode !== "environment_policy" &&
              presentationPolicy?.reasonCode !== "project_restriction"))
        ) {
          preparedApprovalCleanup = preparedApprovalCleanupFailure(
            "EXTERNAL_APPROVAL_POLICY_CHANGED",
          );
        }
        if (
          approvesPreparedDecision &&
          hostedApproval?.version ===
            "runner_hosted_tool_approval_interaction_v4" &&
          Date.parse(hostedApproval.approval.expiresAt) <= now.getTime()
        ) {
          preparedApprovalCleanup = preparedApprovalCleanupFailure(
            "EXTERNAL_APPROVAL_EXPIRED",
          );
        }
        if (
          decision === "remember_approval" &&
          hostedApproval &&
          accessibleThread.projectId &&
          preparedApprovalCleanup === null
        ) {
          try {
            await validateRememberApprovalEligibilityInTransaction(tx, {
              organizationId: input.organizationId,
              projectId: accessibleThread.projectId,
              environmentId: turn.requestedEnvironmentId,
              userId: input.userId,
              toolName: hostedApproval.approval.toolName,
              stableToolIdentity: hostedApproval.approval.stableToolIdentity,
              presentedReasonCode:
                typeof presentationPolicy?.reasonCode === "string"
                  ? presentationPolicy.reasonCode
                  : undefined,
              presentedRememberApprovalEligible:
                presentationPolicy?.rememberApprovalEligible === true,
            });
          } catch (error) {
            if (
              error instanceof AppOperationApprovalError &&
              error.code === "APP_OPERATION_APPROVAL_POLICY_CHANGED"
            ) {
              preparedApprovalCleanup = preparedApprovalCleanupFailure(
                "EXTERNAL_APPROVAL_POLICY_CHANGED",
              );
            } else {
              throw error;
            }
          }
        }
        if (hostedMutation) {
          if (!interaction.runtimeApprovalId) {
            throw new AppOperationApprovalError(
              "APP_OPERATION_APPROVAL_REQUIRED",
            );
          }
          if (
            approvesCurrentInvocation &&
            !(hostedApproval && accessibleThread.projectId)
          ) {
            throw new AppOperationApprovalError(
              "APP_OPERATION_APPROVAL_BINDING_MISMATCH",
            );
          }
          if (
            approvesPreparedDecision &&
            hostedApproval &&
            accessibleThread.projectId &&
            preparedApprovalCleanup === null
          ) {
            try {
              await validateAppApprovalDecisionEligibilityInTransaction(tx, {
                organizationId: input.organizationId,
                projectId: accessibleThread.projectId,
                threadId: input.threadId,
                userId: input.userId,
                runtimeApprovalId: interaction.runtimeApprovalId,
                interactionId: interaction.id,
                toolName: hostedApproval.approval.toolName,
                stableToolIdentity: hostedApproval.approval.stableToolIdentity,
                decision,
                now,
              });
            } catch (error) {
              if (
                decision === "remember_approval" &&
                error instanceof AppOperationApprovalError &&
                error.code === "APP_OPERATION_APPROVAL_ACCESS_DENIED"
              ) {
                preparedApprovalCleanup = preparedApprovalCleanupFailure(
                  "EXTERNAL_APPROVAL_POLICY_CHANGED",
                );
              } else {
                throw error;
              }
            }
          }
          if (preparedApprovalCleanup === null) {
            await decideAppOperationApprovalInTransaction(tx, {
              organizationId: input.organizationId,
              threadId: input.threadId,
              userId: input.userId,
              runtimeApprovalId: interaction.runtimeApprovalId,
              interactionId: interaction.id,
              approved: approvesCurrentInvocation,
              required: true,
              now,
            });
          }
        }
      } catch (error) {
        if (!(error instanceof AppOperationApprovalError)) throw error;
        const failureCode =
          error.code === "APP_OPERATION_APPROVAL_NOT_PENDING"
            ? "EXTERNAL_APPROVAL_EXPIRED"
            : error.code === "APP_OPERATION_APPROVAL_ACCESS_DENIED"
              ? "EXTERNAL_APPROVAL_POLICY_CHANGED"
              : "EXTERNAL_APPROVAL_IDENTITY_MISMATCH";
        preparedApprovalCleanup = preparedApprovalCleanupFailure(failureCode);
      }
    }
    if (preparedApprovalCleanup !== null) {
      const cleanup = await schedulePreparedApprovalCleanupInTransaction(tx, {
        interaction,
        turn,
        queueState,
        responseEnvelope,
        cleanup: preparedApprovalCleanup,
        resolvedByUserId: input.userId,
        resolvedAt: now,
        now,
      });
      return {
        turnId: turn.id,
        shouldDispatch: cleanup.scheduled,
        replayAfterSequence: cleanup.sequence,
      };
    }
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "processing",
        responseEnvelope,
        resolvedByUserId: input.userId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    if (
      decision === "remember_approval" &&
      hostedApproval !== null
    ) {
      await insertRememberedToolApprovalInTransaction(tx, {
        approval: {
          version: "remembered_tool_approval_v1",
          id: crypto.randomUUID(),
          organizationId: input.organizationId,
          threadId: input.threadId,
          actorUserId: input.userId,
          toolIdentity: hostedApproval.approval.stableToolIdentity,
          sourceInteractionId: interaction.id,
          createdAt: now.toISOString(),
        },
      });
    }
    if (interaction.assistantMessageId) {
      const [assistantMessage] = await tx
        .select({ parts: schema.threadMessages.parts })
        .from(schema.threadMessages)
        .where(eq(schema.threadMessages.id, interaction.assistantMessageId))
        .limit(1)
        .for("update");
      if (assistantMessage) {
        await tx
          .update(schema.threadMessages)
          .set({
            parts: setInteractionPresentationStatus(
              assistantMessage.parts,
              interaction.requestId,
              "processing",
              {
                decision:
                  decision === "approve_once" ||
                  decision === "remember_approval" ||
                  approved === true
                    ? "approved"
                    : "denied",
                authorizationState: "pending",
                effectState: "not_started",
                retryEligible: false,
              },
            ),
          })
          .where(eq(schema.threadMessages.id, interaction.assistantMessageId));
      }
    }
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: "running",
        pauseReason: null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    const resolvedEvent = await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "interaction.decision_recorded",
      data: {
        requestId: input.requestId,
        eventType: input.eventType,
        status: "processing",
        messageId: input.messageId,
      },
    });
    return {
      turnId: turn.id,
      shouldDispatch: true,
      replayAfterSequence: resolvedEvent.sequence,
    };
  });
}

export async function recordDurableRuntimeStarted(input: {
  turnId: string;
  eventId: string;
  executionId: string;
  runtimeRunId: string;
  requestedInteractionMode: string | null;
  effectiveInteractionMode: string | null;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const existingStartedEvent = await tx.query.threadTurnEvents.findFirst({
      where: and(
        eq(schema.threadTurnEvents.turnId, input.turnId),
        eq(schema.threadTurnEvents.type, "runtime.started"),
        sql`${schema.threadTurnEvents.data}->>'eventId' = ${input.eventId}`,
      ),
    });
    if (!existingStartedEvent) {
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "runtime.started",
        data: {
          eventId: input.eventId,
          executionId: input.executionId,
          runtimeRunId: input.runtimeRunId,
          requestedInteractionMode: input.requestedInteractionMode,
          effectiveInteractionMode: input.effectiveInteractionMode,
        },
      });
    }
    const currentTurn = await tx.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, input.turnId),
      columns: { resumeInteractionId: true },
    });
    const interaction = await tx.query.threadInteractions.findFirst({
      where: and(
        currentTurn?.resumeInteractionId
          ? eq(schema.threadInteractions.id, currentTurn.resumeInteractionId)
          : eq(schema.threadInteractions.turnId, input.turnId),
        eq(schema.threadInteractions.source, "runtime"),
        inArray(schema.threadInteractions.status, ["processing", "resolved"]),
        isNotNull(schema.threadInteractions.resumedAt),
      ),
    });
    if (!interaction) return false;
    if (parseHostedPreparedApprovalInteraction(interaction) !== null) {
      return true;
    }
    if (interaction.status === "processing") {
      const now = new Date();
      await tx
        .update(schema.threadInteractions)
        .set({
          status: "resolved",
          responseFailureCode: null,
          responseFailureMessage: null,
          effectStatus: null,
          responseRetryable: false,
          updatedAt: now,
        })
        .where(eq(schema.threadInteractions.id, interaction.id));
      await updateInteractionMessagePresentation(tx, interaction, "resolved", {
        decision: readApprovalDecision(interaction.responseEnvelope),
        authorizationState: "accepted",
        effectState: "not_started",
        retryEligible: false,
      });
      await appendTurnEvent(tx, {
        turnId: input.turnId,
        type: "interaction.authorization_accepted",
        data: {
          requestId: interaction.requestId,
          runtimeRunId: input.runtimeRunId,
          code: "AUTHORIZATION_ACCEPTED",
        },
      });
    }
    return true;
  });
}

export type DurableRuntimeToolOutcomeEvidence = {
  callId: string;
  kind: "success" | "partial" | "failure" | "cancellation";
  effectState: "not_applicable" | "not_started" | "committed" | "unknown";
  normalizedFailureCode?: string | undefined;
  retryable?: boolean | undefined;
  error?: { message?: string | undefined } | undefined;
};

export async function recordDurableRuntimeToolOutcome(input: {
  turnId: string;
  eventId: string;
  outcome: DurableRuntimeToolOutcomeEvidence;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const currentTurn = await tx.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, input.turnId),
      columns: { resumeInteractionId: true },
    });
    if (!currentTurn) return false;
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(and(
        currentTurn.resumeInteractionId
          ? eq(schema.threadInteractions.id, currentTurn.resumeInteractionId)
          : eq(schema.threadInteractions.turnId, input.turnId),
        eq(schema.threadInteractions.source, "runtime"),
        inArray(schema.threadInteractions.status, [
          "processing",
          "resolved",
          "failed",
        ]),
        isNotNull(schema.threadInteractions.resumedAt),
      ))
      .limit(1)
      .for("update");
    if (!interaction) return false;
    const hostedApproval = parseHostedPreparedApprovalInteraction(interaction);
    if (
      hostedApproval === null ||
      hostedApproval.approval.preparedInvocationId !== input.outcome.callId
    ) {
      return false;
    }
    const existing = await tx.query.threadTurnEvents.findFirst({
      where: and(
        eq(schema.threadTurnEvents.turnId, input.turnId),
        eq(schema.threadTurnEvents.type, "interaction.execution_settled"),
        sql`${schema.threadTurnEvents.data}->>'eventId' = ${input.eventId}`,
      ),
    });
    if (existing || interaction.status !== "processing") return true;

    try {
      assertHostedApprovalOutcomeInvariant(input.outcome);
    } catch {
      return failDurableRuntimeInteractionInTransaction(tx, input.turnId, {
        failureCode: "TOOL_OUTCOME_INVALID",
        failureMessage: "The tool outcome did not carry valid effect evidence.",
        effectStatus: "unknown",
        retryable: false,
      });
    }

    if (input.outcome.kind !== "success") {
      const effectStatus = input.outcome.effectState === "not_started"
        ? "not_started" as const
        : input.outcome.effectState === "unknown"
          ? "unknown" as const
          : input.outcome.effectState === "committed"
            ? "committed" as const
            : "started" as const;
      return failDurableRuntimeInteractionInTransaction(tx, input.turnId, {
        failureCode:
          input.outcome.normalizedFailureCode ?? "TOOL_EXECUTION_FAILED",
        failureMessage:
          input.outcome.error?.message ?? "The approved operation failed.",
        effectStatus,
        retryable:
          effectStatus === "not_started" && input.outcome.retryable === true,
      });
    }

    const now = new Date();
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "resolved",
        responseFailureCode: null,
        responseFailureMessage: null,
        effectStatus:
          input.outcome.effectState === "committed"
            ? "committed"
            : input.outcome.effectState === "unknown"
              ? "unknown"
              : input.outcome.effectState === "not_started"
                ? "not_started"
                : "started",
        responseRetryable: false,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    await updateInteractionMessagePresentation(tx, interaction, "resolved", {
      decision: readApprovalDecision(interaction.responseEnvelope),
      authorizationState: "accepted",
      effectState: input.outcome.effectState,
      retryEligible: false,
    });
    await appendTurnEvent(tx, {
      turnId: input.turnId,
      type: "interaction.execution_settled",
      data: {
        eventId: input.eventId,
        requestId: interaction.requestId,
        preparedInvocationId: input.outcome.callId,
        outcomeKind: input.outcome.kind,
        effectState: input.outcome.effectState,
      },
    });
    return true;
  });
}

export async function recordDurableRuntimeDeclineCompleted(input: {
  turnId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const currentTurn = await tx.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, input.turnId),
      columns: { resumeInteractionId: true },
    });
    if (!currentTurn) return false;
    const interaction = await tx.query.threadInteractions.findFirst({
      where: and(
        currentTurn.resumeInteractionId
          ? eq(schema.threadInteractions.id, currentTurn.resumeInteractionId)
          : eq(schema.threadInteractions.turnId, input.turnId),
        eq(schema.threadInteractions.source, "runtime"),
        eq(schema.threadInteractions.status, "processing"),
        isNotNull(schema.threadInteractions.resumedAt),
      ),
    });
    if (
      !interaction ||
      parseHostedPreparedApprovalInteraction(interaction) === null ||
      readPlainRecord(interaction.responseEnvelope)?.decision !== "decline"
    ) {
      return false;
    }
    const now = new Date();
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "resolved",
        responseFailureCode: null,
        responseFailureMessage: null,
        effectStatus: "not_started",
        responseRetryable: false,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    await updateInteractionMessagePresentation(tx, interaction, "resolved", {
      decision: "denied",
      authorizationState: "denied",
      effectState: "not_started",
      retryEligible: false,
    });
    await appendTurnEvent(tx, {
      turnId: input.turnId,
      type: "interaction.authorization_denied",
      data: {
        requestId: interaction.requestId,
        effectState: "not_started",
      },
    });
    return true;
  });
}

export async function recordDurablePreparedApprovalCleanupCompleted(input: {
  turnId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const currentTurn = await tx.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, input.turnId),
    });
    if (!currentTurn) return false;
    return completePreparedApprovalCleanupInTransaction(tx, currentTurn);
  });
}

async function completePreparedApprovalCleanupInTransaction(
  tx: TurnTransaction,
  currentTurn: typeof schema.threadTurns.$inferSelect,
) {
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          currentTurn.resumeInteractionId
            ? eq(
                schema.threadInteractions.id,
                currentTurn.resumeInteractionId,
              )
            : eq(schema.threadInteractions.turnId, currentTurn.id),
          eq(schema.threadInteractions.source, "runtime"),
          eq(schema.threadInteractions.status, "processing"),
          isNotNull(schema.threadInteractions.resumedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!interaction) return false;
    const cleanup = readPreparedApprovalCleanupFromResponse(
      interaction.responseEnvelope,
    );
    if (cleanup === null) return false;
    const now = new Date();
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "failed",
        responseFailureCode: cleanup.failureCode,
        responseFailureMessage: cleanup.failureMessage,
        effectStatus: "not_started",
        responseRetryable: false,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    const response = readPlainRecord(interaction.responseEnvelope);
    await updateInteractionMessagePresentation(tx, interaction, "failed", {
      decision:
        response?.decision === "approve_once" ||
        response?.decision === "remember_approval" ||
        response?.approved === true
          ? "approved"
          : response?.decision === "decline" || response?.approved === false
            ? "denied"
            : "expired",
      authorizationState: "failed",
      effectState: "not_started",
      failureCode: cleanup.failureCode,
      publicMessage: cleanup.failureMessage,
      retryEligible: false,
    });
    await appendTurnEvent(tx, {
      turnId: currentTurn.id,
      type: "interaction.authorization_failed",
      data: {
        requestId: interaction.requestId,
        failureCode: cleanup.failureCode,
        effectState: "not_started",
        retryable: false,
        cleanupCompleted: true,
      },
    });
    return true;
}

export async function resetDurablePreparedApprovalCleanupForRetry(input: {
  turnId: string;
}) {
  return reconcileDurablePreparedApprovalCleanupForRetry(input);
}

export async function reconcileDurablePreparedApprovalCleanupForRetry(input: {
  turnId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) return false;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    await lockPreparedApprovalCleanupThread(tx, {
      threadId: candidate.threadId,
      organizationId: candidate.organizationId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (
      !turn ||
      (turn.status !== "running" && turn.status !== "waiting_for_input")
    ) return false;
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          turn.resumeInteractionId
            ? eq(schema.threadInteractions.id, turn.resumeInteractionId)
            : eq(schema.threadInteractions.turnId, turn.id),
          eq(schema.threadInteractions.organizationId, turn.organizationId),
          eq(schema.threadInteractions.threadId, turn.threadId),
          eq(schema.threadInteractions.turnId, turn.id),
          eq(schema.threadInteractions.source, "runtime"),
          eq(schema.threadInteractions.status, "processing"),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !interaction ||
      readPreparedApprovalCleanupFromResponse(interaction.responseEnvelope) === null
    ) return false;
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    if (queueState?.activeTurnId !== turn.id) return false;
    const requiresStateReset =
      turn.status === "running" ||
      turn.environmentExecutionId !== null ||
      interaction.resumedAt !== null ||
      queueState.state !== "running" ||
      queueState.pauseReason !== null;
    if (!requiresStateReset) return true;
    const now = new Date();
    if (turn.status === "running") {
      assertThreadTurnTransition(turn.status, "waiting_for_input");
      await tx
        .update(schema.threadTurns)
        .set({
          status: "waiting_for_input",
          environmentExecutionId: null,
          updatedAt: now,
        })
        .where(eq(schema.threadTurns.id, turn.id));
    }
    if (interaction.resumedAt !== null) {
      await tx
        .update(schema.threadInteractions)
        .set({ resumedAt: null, updatedAt: now })
        .where(eq(schema.threadInteractions.id, interaction.id));
    }
    if (queueState.state !== "running" || queueState.pauseReason !== null) {
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          state: "running",
          pauseReason: null,
          version: queueState.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    }
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "interaction.cleanup_retry_scheduled",
      data: { requestId: interaction.requestId },
    });
    return true;
  });
}

export async function hasDurablePreparedApprovalCleanupPending(input: {
  turnId: string;
}) {
  const [binding] = await knowledgeDb
    .select({
      activeTurnId: schema.threadTurnQueueState.activeTurnId,
      interactionOrganizationId: schema.threadInteractions.organizationId,
      interactionResponse: schema.threadInteractions.responseEnvelope,
      interactionStatus: schema.threadInteractions.status,
      interactionThreadId: schema.threadInteractions.threadId,
      interactionTurnId: schema.threadInteractions.turnId,
      source: schema.threadInteractions.source,
      turnOrganizationId: schema.threadTurns.organizationId,
      turnStatus: schema.threadTurns.status,
      turnThreadId: schema.threadTurns.threadId,
    })
    .from(schema.threadTurns)
    .innerJoin(
      schema.threadTurnQueueState,
      eq(schema.threadTurnQueueState.threadId, schema.threadTurns.threadId),
    )
    .innerJoin(
      schema.threadInteractions,
      or(
        and(
          isNotNull(schema.threadTurns.resumeInteractionId),
          eq(
            schema.threadInteractions.id,
            schema.threadTurns.resumeInteractionId,
          ),
        ),
        and(
          isNull(schema.threadTurns.resumeInteractionId),
          eq(schema.threadInteractions.turnId, schema.threadTurns.id),
        ),
      ),
    )
    .where(
      and(
        eq(schema.threadTurns.id, input.turnId),
        eq(schema.threadInteractions.source, "runtime"),
        eq(schema.threadInteractions.status, "processing"),
      ),
    )
    .limit(1);
  return Boolean(
    binding &&
      (binding.turnStatus === "running" ||
        binding.turnStatus === "waiting_for_input") &&
      binding.activeTurnId === input.turnId &&
      binding.source === "runtime" &&
      binding.interactionStatus === "processing" &&
      binding.interactionOrganizationId === binding.turnOrganizationId &&
      binding.interactionThreadId === binding.turnThreadId &&
      binding.interactionTurnId === input.turnId &&
      readPreparedApprovalCleanupFromResponse(binding.interactionResponse) !==
        null,
  );
}

export type DurableInteractionFailureEvidence = {
  failureCode: string;
  failureMessage: string;
  effectStatus: "not_started" | "started" | "committed" | "unknown";
  retryable: boolean;
};

function publicInteractionFailureMessage(failureCode: string) {
  switch (failureCode) {
    case "EXTERNAL_APPROVAL_IDENTITY_MISMATCH":
      return "Authorization no longer matches the requested operation. Request a fresh approval.";
    case "TURN_DISPATCH_FAILED":
      return "Authorization could not be started. The operation was not executed.";
    case "TURN_STOPPED":
      return "Authorization was cancelled before the operation started.";
    default:
      return "Authorization failed before the operation could be confirmed.";
  }
}

async function failDurableRuntimeInteractionInTransaction(
  tx: TurnTransaction,
  turnId: string,
  input: DurableInteractionFailureEvidence,
) {
  const currentTurn = await tx.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.id, turnId),
    columns: { resumeInteractionId: true },
  });
  const [interaction] = await tx
    .select()
    .from(schema.threadInteractions)
    .where(and(
      currentTurn?.resumeInteractionId
        ? eq(schema.threadInteractions.id, currentTurn.resumeInteractionId)
        : eq(schema.threadInteractions.turnId, turnId),
      eq(schema.threadInteractions.source, "runtime"),
      eq(schema.threadInteractions.status, "processing"),
      isNotNull(schema.threadInteractions.resumedAt),
    ))
    .limit(1)
    .for("update");
  if (!interaction) return false;
  const now = new Date();
  const interactionOwned = parseHostedPreparedApprovalInteraction(interaction) !== null;
  let retryable = input.effectStatus === "not_started" && input.retryable;
  if (retryable && interactionOwned && interaction.runtimeApprovalId) {
    const [providerApproval] = await tx
      .select({
        availabilityStatus: schema.appOperationApprovals.availabilityStatus,
        consumedExecutionId: schema.appOperationApprovals.consumedExecutionId,
        expiresAt: schema.appOperationApprovals.expiresAt,
      })
      .from(schema.appOperationApprovals)
      .where(and(
        eq(
          schema.appOperationApprovals.organizationId,
          interaction.organizationId,
        ),
        eq(
          schema.appOperationApprovals.runtimeApprovalId,
          interaction.runtimeApprovalId,
        ),
        eq(schema.appOperationApprovals.lifecycleVersion, "interaction_v2"),
        eq(schema.appOperationApprovals.interactionId, interaction.id),
      ))
      .limit(1)
      .for("update");
    retryable =
      providerApproval?.availabilityStatus === "available" &&
      providerApproval.consumedExecutionId === null &&
      providerApproval.expiresAt.getTime() > now.getTime();
  }
  await tx
    .update(schema.threadInteractions)
    .set({
      status: "failed",
      responseFailureCode: input.failureCode,
      responseFailureMessage: input.failureMessage,
      effectStatus: input.effectStatus,
      responseRetryable: retryable,
      updatedAt: now,
    })
    .where(eq(schema.threadInteractions.id, interaction.id));
  if (interaction.runtimeApprovalId && !retryable) {
    await tx
      .update(schema.appOperationApprovals)
      .set({
        ...(interactionOwned
          ? { availabilityStatus: "expired" as const }
          : { status: "expired" as const }),
        payload: sql`jsonb_build_object('redacted', true, 'operation', ${schema.appOperationApprovals.operationKey})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(
            schema.appOperationApprovals.organizationId,
            interaction.organizationId,
          ),
          eq(
            schema.appOperationApprovals.runtimeApprovalId,
            interaction.runtimeApprovalId,
          ),
          ...(interactionOwned
            ? [
                eq(schema.appOperationApprovals.lifecycleVersion, "interaction_v2"),
                eq(schema.appOperationApprovals.interactionId, interaction.id),
                eq(schema.appOperationApprovals.availabilityStatus, "available"),
              ]
            : [
                eq(schema.appOperationApprovals.lifecycleVersion, "legacy_v1"),
                inArray(schema.appOperationApprovals.status, ["pending", "approved"]),
              ]),
        ),
      );
  }
  await updateInteractionMessagePresentation(tx, interaction, "failed", {
    decision: readApprovalDecision(interaction.responseEnvelope),
    authorizationState: "failed",
    effectState: input.effectStatus,
    failureCode: input.failureCode,
    publicMessage: publicInteractionFailureMessage(input.failureCode),
    retryEligible: retryable,
  });
  await appendTurnEvent(tx, {
    turnId,
    type: "interaction.authorization_failed",
    data: {
      requestId: interaction.requestId,
      failureCode: input.failureCode,
      effectStatus: input.effectStatus,
      retryable,
    },
  });
  return true;
}

export async function failDurableRuntimeInteractionBeforeStart(input: {
  turnId: string;
  failureCode: string;
  failureMessage: string;
  effectStatus: "not_started" | "unknown";
  retryable: boolean;
}) {
  return knowledgeDb.transaction((tx) =>
    failDurableRuntimeInteractionInTransaction(tx, input.turnId, input),
  );
}

export async function retryFailedDurableRuntimeInteraction(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  idempotencyKey: string;
  source: ThreadTurnSource;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    const accessibleThread = await lockAccessibleThread(tx, input);
    const [interaction] = await tx
      .select()
      .from(schema.threadInteractions)
      .where(
        and(
          eq(schema.threadInteractions.requestId, input.requestId),
          eq(schema.threadInteractions.threadId, input.threadId),
          eq(schema.threadInteractions.organizationId, input.organizationId),
          eq(schema.threadInteractions.source, "runtime"),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !interaction?.turnId ||
      (interaction.kind !== "approval" && interaction.kind !== "user_input") ||
      interaction.status !== "failed" ||
      interaction.effectStatus !== "not_started" ||
      interaction.responseRetryable !== true ||
      interaction.resolvedByUserId !== input.userId ||
      !interaction.responseEnvelope ||
      (interaction.kind === "approval" &&
        (!interaction.runtimeApprovalId || !interaction.sourceRuntimeRunId))
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "This authorization cannot be retried safely; request fresh approval.",
      );
    }
    const requestEnvelope = readPlainRecord(interaction.requestEnvelope);
    const approvalEnvelope = readPlainRecord(requestEnvelope?.approval);
    if (isHostedMutationToolName(approvalEnvelope?.toolName)) {
      if (interaction.kind !== "approval") {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval interaction is invalid; request fresh approval.",
        );
      }
      const runtimeApprovalId = interaction.runtimeApprovalId;
      if (!runtimeApprovalId) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval is missing its runtime identity; request fresh approval.",
        );
      }
      if (!accessibleThread.projectId) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval no longer has a Project authority context.",
        );
      }
      const appApproval = await tx.query.appOperationApprovals.findFirst({
        where: and(
          eq(schema.appOperationApprovals.organizationId, input.organizationId),
          eq(schema.appOperationApprovals.threadId, input.threadId),
          eq(schema.appOperationApprovals.actorUserId, input.userId),
          eq(schema.appOperationApprovals.runtimeApprovalId, runtimeApprovalId),
          eq(schema.appOperationApprovals.lifecycleVersion, "interaction_v2"),
          eq(schema.appOperationApprovals.interactionId, interaction.id),
          eq(schema.appOperationApprovals.availabilityStatus, "available"),
          isNull(schema.appOperationApprovals.consumedExecutionId),
          gt(schema.appOperationApprovals.expiresAt, new Date()),
        ),
      });
      if (
        !(appApproval?.externalApprovalBinding && appApproval.authorityRevision)
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval is no longer reusable; request fresh approval.",
        );
      }
      const responseEnvelope = readPlainRecord(interaction.responseEnvelope);
      let runnerBinding;
      try {
        runnerBinding = parseRunnerExternalApprovalBinding(
          appApproval.externalApprovalBinding,
        );
      } catch {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval binding is invalid; request fresh approval.",
        );
      }
      if (
        !isApprovedResponseEnvelope(responseEnvelope) ||
        runnerBinding.approvalId !== interaction.runtimeApprovalId ||
        runnerBinding.threadId !== interaction.threadId ||
        (runnerBinding.version !== RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION &&
          runnerBinding.runId !== interaction.sourceRuntimeRunId) ||
        (runnerBinding.version === RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION &&
          (runnerBinding.preparedInvocationId !==
            approvalEnvelope?.preparedInvocationId ||
            serializeCanonicalApprovalPayload(
              runnerBinding.stableToolIdentity,
            ) !==
              serializeCanonicalApprovalPayload(
                approvalEnvelope?.stableToolIdentity,
              ))) ||
        runnerBinding.actionKey !== approvalEnvelope?.toolName ||
        Date.parse(runnerBinding.expiresAt) <= Date.now()
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App approval evidence changed; request fresh approval.",
        );
      }
      const [access, resource] = await Promise.all([
        resolveEffectiveProjectAppAccess(
          {
            organizationId: input.organizationId,
            projectId: accessibleThread.projectId,
            appKey: appApproval.appKey,
            userId: input.userId,
            includePolicyOnly: true,
            skipResourceReadiness: true,
            skipInitialization: true,
          },
          tx as unknown as typeof knowledgeDb,
        ),
        tx.query.appConnectionResources.findFirst({
          where: and(
            eq(schema.appConnectionResources.id, appApproval.resourceId),
            eq(
              schema.appConnectionResources.connectionId,
              appApproval.connectionId,
            ),
            eq(
              schema.appConnectionResources.resourceType,
              appApproval.resourceType,
            ),
            eq(schema.appConnectionResources.enabled, true),
          ),
          columns: { id: true },
        }),
      ]);
      const capability = access?.capabilities.find(
        (candidate) => candidate.key === appApproval.capabilityKey,
      );
      if (
        !resource ||
        access?.environmentId !== appApproval.environmentId ||
        access.connectionId !== appApproval.connectionId ||
        !capability ||
        capability.approvalMode === "deny"
      ) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App authority changed; request fresh approval.",
        );
      }
      const currentAuthorityRevision = hashAppApprovalAuthority({
        organizationId: input.organizationId,
        projectId: accessibleThread.projectId,
        environmentId: access.environmentId,
        actorUserId: input.userId,
        appKey: access.appKey,
        connectionId: access.connectionId,
        capability: {
          key: capability.key,
          approvalMode: capability.approvalMode,
          loggingMode: capability.loggingMode,
          rateLimitMode: capability.rateLimitMode,
          settings: capability.settings,
        },
        resource: { id: resource.id, type: appApproval.resourceType },
      });
      if (currentAuthorityRevision !== appApproval.authorityRevision) {
        throw new DurableTurnError(
          "TURN_CONFLICT",
          "The hosted App authority changed; request fresh approval.",
        );
      }
    }
    const originalTurn = await tx.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, interaction.turnId),
    });
    if (!originalTurn?.requestedEnvironmentId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The original execution route is unavailable.",
      );
    }
    const now = new Date();
    await tx
      .update(schema.threadInteractions)
      .set({
        status: "processing",
        resumedAt: null,
        responseFailureCode: null,
        responseFailureMessage: null,
        effectStatus: null,
        responseRetryable: false,
        updatedAt: now,
      })
      .where(eq(schema.threadInteractions.id, interaction.id));
    await updateInteractionMessagePresentation(tx, interaction, "processing", {
      decision: readApprovalDecision(interaction.responseEnvelope),
      authorizationState: "pending",
      effectState: "not_started",
      retryEligible: false,
    });
    const durable = await createDurableThreadTurnInTransaction(tx, {
      threadId: input.threadId,
      organizationId: input.organizationId,
      authorUserId: input.userId,
      messageId: null,
      resumeInteractionId: interaction.id,
      idempotencyKey: input.idempotencyKey,
      requestedEnvironmentId: originalTurn.requestedEnvironmentId,
      projectContextRevisionId: originalTurn.projectContextRevisionId,
      requestedModelId: originalTurn.requestedModelId,
      requestedInteractionMode: originalTurn.requestedInteractionMode,
      source: input.source,
    });
    await appendTurnEvent(tx, {
      turnId: durable.turn.id,
      type: "interaction.retry_requested",
      data: {
        requestId: interaction.requestId,
        sourceTurnId: interaction.turnId,
        effectStatus: "not_started",
      },
    });
    return durable;
  });
}

async function updateInteractionMessagePresentation(
  tx: TurnTransaction,
  interaction: typeof schema.threadInteractions.$inferSelect,
  status: "processing" | "resolved" | "failed",
  outcome: Record<string, unknown>,
) {
  if (!interaction.assistantMessageId) return;
  const message = await tx.query.threadMessages.findFirst({
    where: eq(schema.threadMessages.id, interaction.assistantMessageId),
    columns: { parts: true },
  });
  if (!message) return;
  await tx
    .update(schema.threadMessages)
    .set({
      parts: setInteractionPresentationStatus(
        message.parts,
        interaction.requestId,
        status,
        outcome,
      ),
    })
    .where(eq(schema.threadMessages.id, interaction.assistantMessageId));
}

function readApprovalDecision(value: unknown): "approved" | "denied" {
  return isApprovedResponseEnvelope(readPlainRecord(value))
    ? "approved"
    : "denied";
}

function isApprovedResponseEnvelope(
  value: Record<string, unknown> | null,
): boolean {
  return value?.decision === "approve_once" ||
    value?.decision === "remember_approval" ||
    value?.approved === true;
}

function parseHostedPreparedApprovalInteraction(
  interaction: typeof schema.threadInteractions.$inferSelect,
):
  | ReturnType<typeof parseRunnerHostedToolApprovalInteractionV2>
  | ReturnType<typeof parseRunnerHostedToolApprovalInteractionV3>
  | ReturnType<typeof parseRunnerHostedToolApprovalInteractionV4>
  | null {
  if (interaction.kind !== "approval") return null;
  if (readPlainRecord(interaction.requestEnvelope)?.version === "v1") {
    return null;
  }
  try {
    const version = readPlainRecord(interaction.requestEnvelope)?.version;
    const parsed = version === "runner_hosted_tool_approval_interaction_v4"
      ? parseRunnerHostedToolApprovalInteractionV4(
          interaction.requestEnvelope,
          interaction.eventType,
        )
      : version === "runner_hosted_tool_approval_interaction_v3"
        ? parseRunnerHostedToolApprovalInteractionV3(
          interaction.requestEnvelope,
          interaction.eventType,
        )
        : parseRunnerHostedToolApprovalInteractionV2(
          interaction.requestEnvelope,
          interaction.eventType,
        );
    if (parsed.requestId !== interaction.requestId) {
      throw new Error("request identity mismatch");
    }
    return parsed;
  } catch {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "The hosted prepared approval contract is invalid.",
    );
  }
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function appendInteractionPresentationParts(
  value: unknown,
  interactions: Array<{
    requestId: string;
    kind: string;
    eventType: string;
    prompt: string;
    requestEnvelope: Record<string, unknown>;
    source: "mcp";
    status: string;
  }>,
) {
  const parts = Array.isArray(value) ? [...value] : [];
  const existingRequestIds = new Set(
    parts.flatMap((part) => {
      if (!(part && typeof part === "object" && !Array.isArray(part)))
        return [];
      const record = part as Record<string, unknown>;
      const data =
        record.data &&
        typeof record.data === "object" &&
        !Array.isArray(record.data)
          ? (record.data as Record<string, unknown>)
          : null;
      return record.type === "data-kestrel-interaction" &&
        typeof data?.requestId === "string"
        ? [data.requestId]
        : [];
    }),
  );
  for (const interaction of interactions) {
    if (existingRequestIds.has(interaction.requestId)) continue;
    const status =
      interaction.status === "resolved"
        ? "resolved"
        : interaction.status === "cancelled" || interaction.status === "failed"
          ? "cancelled"
          : "pending";
    parts.push({
      type: "data-kestrel-interaction",
      id: `interaction:${interaction.requestId}`,
      data: {
        version: "v1",
        requestId: interaction.requestId,
        kind: interaction.kind,
        eventType: interaction.eventType,
        prompt: interaction.prompt,
        source: interaction.source,
        status,
        ...(interaction.requestEnvelope.inputSchema
          ? { inputSchema: interaction.requestEnvelope.inputSchema }
          : {}),
        ...(interaction.requestEnvelope.metadata
          ? { metadata: interaction.requestEnvelope.metadata }
          : {}),
      },
    });
  }
  return parts;
}

export async function listThreadInteractionsForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, input);
    const interactions = await tx.query.threadInteractions.findMany({
      where: eq(schema.threadInteractions.threadId, input.threadId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const turnIds = [
      ...new Set(
        interactions
          .map((interaction) => interaction.turnId)
          .filter((turnId): turnId is string => Boolean(turnId)),
      ),
    ];
    const resolvedEvents =
      turnIds.length === 0
        ? []
        : await tx
            .select({ data: schema.threadTurnEvents.data })
            .from(schema.threadTurnEvents)
            .where(
              and(
                inArray(schema.threadTurnEvents.turnId, turnIds),
                eq(
                  schema.threadTurnEvents.type,
                  "interaction.decision_recorded",
                ),
              ),
            );
    const responseMessageIds = new Map<string, string>();
    for (const event of resolvedEvents) {
      if (!(event.data && typeof event.data === "object")) continue;
      const data = event.data as Record<string, unknown>;
      if (
        typeof data.requestId === "string" &&
        typeof data.messageId === "string"
      ) {
        responseMessageIds.set(data.requestId, data.messageId);
      }
    }
    return interactions.map((interaction) => {
      const responseEnvelope = interaction.responseEnvelope;
      const envelopeMessageId =
        responseEnvelope && typeof responseEnvelope.messageId === "string"
          ? responseEnvelope.messageId
          : null;
      return projectSafeThreadInteraction(
        interaction,
        envelopeMessageId ??
          responseMessageIds.get(interaction.requestId) ??
          null,
      );
    });
  });
}

async function terminalizeTurnEnvironmentExecution(
  tx: TurnTransaction,
  turn: {
    environmentExecutionId: string | null;
    organizationId: string;
    failureCode?: string | null;
    failureMessage?: string | null;
  },
  status: ThreadTurnTerminalStatus,
  now: Date,
  failure?: { code?: string | null; message?: string | null },
) {
  if (!turn.environmentExecutionId) return;
  const executionStatus =
    status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "cancelled"
        : "failed";
  await tx
    .update(schema.environmentRunExecutions)
    .set({
      status: executionStatus,
      failureCode:
        executionStatus === "failed"
          ? (failure?.code ?? turn.failureCode ?? null)
          : null,
      failureMessage:
        executionStatus === "failed"
          ? (failure?.message ?? turn.failureMessage ?? null)
          : null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.environmentRunExecutions.id, turn.environmentExecutionId),
        eq(schema.environmentRunExecutions.organizationId, turn.organizationId),
        inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
      ),
    );
  await tx
    .update(schema.environmentModelGrants)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.environmentModelGrants.runId, turn.environmentExecutionId),
        eq(schema.environmentModelGrants.organizationId, turn.organizationId),
        eq(schema.environmentModelGrants.status, "active"),
      ),
    );
  await tx
    .update(schema.mcpRunGrants)
    .set({ status: "revoked", revokedAt: now })
    .where(
      and(
        eq(schema.mcpRunGrants.runExecutionId, turn.environmentExecutionId),
        eq(schema.mcpRunGrants.organizationId, turn.organizationId),
        inArray(schema.mcpRunGrants.status, ["issued", "active"]),
      ),
    );
}

async function invalidateTurnGatewayCredentialForAuthFailure(
  tx: TurnTransaction,
  turn: {
    environmentExecutionId: string | null;
    organizationId: string;
  },
  failureCode: string | null | undefined,
  now: Date,
) {
  if (!(turn.environmentExecutionId && failureCode === "MODEL_AUTH_ERROR")) {
    return;
  }
  const [leased] = await tx
    .select({
      gatewayId: schema.environmentModelGrants.gatewayId,
      grantCredentialRevision:
        schema.environmentModelGrants.gatewayCredentialRevision,
      gatewayCredentialRevision: schema.aiGateways.credentialRevision,
    })
    .from(schema.environmentModelGrants)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.environmentModelGrants.gatewayId),
    )
    .where(
      and(
        eq(schema.environmentModelGrants.runId, turn.environmentExecutionId),
        eq(schema.environmentModelGrants.organizationId, turn.organizationId),
        eq(schema.environmentModelGrants.status, "active"),
      ),
    )
    .limit(1);
  if (
    !(
      leased &&
      shouldInvalidateGatewayCredential({
        failureCode,
        grantCredentialRevision: leased.grantCredentialRevision,
        gatewayCredentialRevision: leased.gatewayCredentialRevision,
      })
    )
  ) {
    return;
  }
  const [invalidated] = await tx
    .update(schema.aiGateways)
    .set({
      credentialStatus: "invalid",
      credentialValidatedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.aiGateways.id, leased.gatewayId),
        eq(schema.aiGateways.organizationId, turn.organizationId),
        eq(
          schema.aiGateways.credentialRevision,
          leased.grantCredentialRevision!,
        ),
      ),
    )
    .returning({ id: schema.aiGateways.id });
  if (invalidated) {
    await tx.insert(schema.adminEventLogs).values({
      id: crypto.randomUUID(),
      organizationId: turn.organizationId,
      actorUserId: null,
      level: "warn",
      category: "ai_gateway",
      action: "gateway.credential.invalidated",
      targetType: "ai_gateway",
      targetId: invalidated.id,
      message:
        "Invalidated an AI gateway credential after a model authentication failure.",
      metadata: {
        failureCode: "MODEL_AUTH_ERROR",
        credentialRevision: leased.grantCredentialRevision,
      },
      createdAt: now,
    });
  }
}

export async function completeDurableThreadTurn(input: {
  turnId: string;
  status: ThreadTurnTerminalStatus;
  failureCode?: string | null;
  failureMessage?: string | null;
  messages?: DurableAssistantOutcomeMessage[];
  replayChunks?: readonly DurableReplayChunk[];
  interactionFailure?: DurableInteractionFailureEvidence;
}) {
  let persistedMessages = false;
  const result = await knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!turn) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    if (["completed", "failed", "cancelled"].includes(turn.status)) {
      await terminalizeTurnEnvironmentExecution(
        tx,
        turn,
        turn.status as ThreadTurnTerminalStatus,
        new Date(),
      );
      return { turn, nextTurnId: null };
    }
    assertThreadTurnTransition(turn.status, input.status);
    const outcome = terminalQueueOutcome(input.status);
    const now = new Date();
    if (input.messages && input.messages.length > 0) {
      await persistDurableAssistantMessages(tx, {
        turn,
        messages: input.messages,
        now,
        bindMcpInteractions: true,
      });
      persistedMessages = true;
    }
    const [terminal] = await tx
      .update(schema.threadTurns)
      .set({
        status: input.status,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    if (input.status === "failed") {
      await invalidateTurnGatewayCredentialForAuthFailure(
        tx,
        turn,
        input.failureCode,
        now,
      );
    }
    if (input.interactionFailure) {
      await failDurableRuntimeInteractionInTransaction(
        tx,
        turn.id,
        input.interactionFailure,
      );
    }
    if (input.status === "failed" || input.status === "cancelled") {
      await completePreparedApprovalCleanupInTransaction(tx, turn);
    }
    await terminalizeTurnEnvironmentExecution(tx, turn, input.status, now, {
      code: input.failureCode,
      message: input.failureMessage,
    });
    await appendDurableReplayChunks(tx, turn.id, input.replayChunks ?? []);
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: `turn.${input.status}`,
      data: {
        status: input.status,
        failureCode: input.failureCode ?? null,
      },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: input.status === "completed" ? "finalizing" : "working",
      now,
    });
    const devices = await tx
      .select({ id: schema.mobileDeviceRegistrations.id })
      .from(schema.mobileDeviceRegistrations)
      .where(
        and(
          eq(schema.mobileDeviceRegistrations.userId, turn.authorUserId),
          eq(schema.mobileDeviceRegistrations.enabled, true),
        ),
      );
    if (devices.length > 0) {
      const kind: "completed" | "failed" =
        input.status === "completed" ? "completed" : "failed";
      await tx
        .insert(schema.mobilePushDeliveries)
        .values(
          devices.map((device) => ({
            id: crypto.randomUUID(),
            deviceRegistrationId: device.id,
            organizationId: turn.organizationId,
            threadId: turn.threadId,
            turnId: turn.id,
            kind,
            status: "pending" as const,
          })),
        )
        .onConflictDoNothing({
          target: [
            schema.mobilePushDeliveries.turnId,
            schema.mobilePushDeliveries.deviceRegistrationId,
            schema.mobilePushDeliveries.kind,
          ],
        });
    }
    const next = outcome.dispatchNext
      ? await findNextQueuedTurn(tx, turn.threadId)
      : null;
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        activeTurnId: next?.id ?? null,
        state: outcome.state,
        pauseReason: outcome.pauseReason,
        version: (queueState?.version ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    return { turn: terminal ?? turn, nextTurnId: next?.id ?? null };
  });
  if (persistedMessages && input.messages) {
    await meterDurableAssistantMessages(input.messages);
  }
  return result;
}

export async function listDurableTurnEvents(input: {
  turnId: string;
  afterSequence?: number;
  limit?: number;
}) {
  return knowledgeDb
    .select()
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, input.turnId),
        gt(schema.threadTurnEvents.sequence, input.afterSequence ?? 0),
      ),
    )
    .orderBy(asc(schema.threadTurnEvents.sequence))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
}

/**
 * Returns the last completed UI stream segment for a durable turn. A turn can
 * have multiple stream segments when it waits for an interaction and resumes;
 * reconnecting without a client cursor must start after the prior segment so
 * persisted assistant messages are never appended to the live list again.
 */
export async function getDurableTurnReplayBoundary(turnId: string) {
  const [event] = await knowledgeDb
    .select({ sequence: schema.threadTurnEvents.sequence })
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, turnId),
        eq(schema.threadTurnEvents.type, "ui.message"),
        sql`${schema.threadTurnEvents.data}->>'type' = 'finish'`,
      ),
    )
    .orderBy(desc(schema.threadTurnEvents.sequence))
    .limit(1);
  return event?.sequence ?? 0;
}

export async function getDurableTurnOpenReplayScaffold(turnId: string) {
  const events = await knowledgeDb
    .select({ data: schema.threadTurnEvents.data })
    .from(schema.threadTurnEvents)
    .where(
      and(
        eq(schema.threadTurnEvents.turnId, turnId),
        eq(schema.threadTurnEvents.type, "ui.message"),
        sql`${schema.threadTurnEvents.data}->>'type' IN ('start', 'text-start', 'finish')`,
      ),
    )
    .orderBy(asc(schema.threadTurnEvents.sequence));
  let assistantMessageId: string | null = null;
  let textPartId: string | null = null;
  for (const event of events) {
    if (!(event.data && typeof event.data === "object")) continue;
    const chunk = event.data as Record<string, unknown>;
    if (chunk.type === "finish") {
      assistantMessageId = null;
      textPartId = null;
    } else if (chunk.type === "start" && typeof chunk.messageId === "string") {
      assistantMessageId = chunk.messageId;
    } else if (chunk.type === "text-start" && typeof chunk.id === "string") {
      textPartId = chunk.id;
    }
  }
  return { assistantMessageId, textPartId };
}

export async function appendDurableTurnEvent(input: {
  turnId: string;
  type: string;
  data?: unknown;
}) {
  return knowledgeDb.transaction((tx) => appendTurnEvent(tx, input));
}

export async function bindDurableTurnExecution(input: {
  turnId: string;
  executionId: string;
}) {
  const [turn] = await knowledgeDb
    .update(schema.threadTurns)
    .set({
      environmentExecutionId: input.executionId,
      updatedAt: new Date(),
    })
    .where(eq(schema.threadTurns.id, input.turnId))
    .returning();
  return turn ?? null;
}

export async function isDurableTurnCancellationRequested(turnId: string) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.id, turnId),
    columns: { cancelRequestedAt: true },
  });
  return Boolean(turn?.cancelRequestedAt);
}

export async function listMessagesForDurableTurn(turnId: string) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: eq(schema.threadTurns.id, turnId),
  });
  if (!turn) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
  }
  const priorTurnIds = knowledgeDb
    .select({ id: schema.threadTurns.id })
    .from(schema.threadTurns)
    .where(
      and(
        eq(schema.threadTurns.threadId, turn.threadId),
        sql`${schema.threadTurns.sequence} <= ${turn.sequence}`,
      ),
    );
  return knowledgeDb
    .select()
    .from(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.threadId, turn.threadId),
        or(
          inArray(schema.threadMessages.turnId, priorTurnIds),
          and(
            isNull(schema.threadMessages.turnId),
            lte(schema.threadMessages.createdAt, turn.createdAt),
          ),
        ),
      ),
    )
    .orderBy(
      asc(schema.threadMessages.createdAt),
      asc(schema.threadMessages.id),
    );
}

export async function getDurableTurnForUser(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  const turn = await knowledgeDb.query.threadTurns.findFirst({
    where: and(
      eq(schema.threadTurns.id, input.turnId),
      eq(schema.threadTurns.organizationId, input.organizationId),
    ),
  });
  if (!turn) {
    return null;
  }
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, {
      threadId: turn.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return turn;
  });
}

export async function getDurableTurnRetrySourceForUser(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  const turn = await getDurableTurnForUser(input);
  if (!turn) return null;
  if (
    !["failed", "cancelled"].includes(turn.status) ||
    turn.failureCode === "TURN_REMOVED" ||
    !turn.inputMessageId
  ) {
    throw new DurableTurnError(
      "TURN_CONFLICT",
      "Only a failed or stopped message can be retried.",
    );
  }
  const message = await knowledgeDb.query.threadMessages.findFirst({
    where: and(
      eq(schema.threadMessages.id, turn.inputMessageId),
      eq(schema.threadMessages.threadId, turn.threadId),
      eq(schema.threadMessages.role, "user"),
    ),
  });
  if (!message) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Retry message not found.");
  }
  const sourceMessageId = message.sourceMessageId ?? message.id;
  return { turn, messageParts: message.parts, sourceMessageId };
}

export async function listDurableThreadQueueForUser(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await lockAccessibleThread(tx, input);
    const [turns, queueState] = await Promise.all([
      tx
        .select()
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.threadId, input.threadId))
        .orderBy(asc(schema.threadTurns.sequence)),
      tx.query.threadTurnQueueState.findFirst({
        where: eq(schema.threadTurnQueueState.threadId, input.threadId),
      }),
    ]);
    return {
      turns,
      queue: {
        state: queueState?.state ?? "running",
        pauseReason: queueState?.pauseReason ?? null,
        activeTurnId: queueState?.activeTurnId ?? null,
        version: queueState?.version ?? 0,
      },
    };
  });
}

export async function getDurableTurn(turnId: string) {
  return (
    (await knowledgeDb.query.threadTurns.findFirst({
      where: eq(schema.threadTurns.id, turnId),
    })) ?? null
  );
}

export async function getActiveDurableTurnForThread(threadId: string) {
  const [active] = await knowledgeDb
    .select({ turn: schema.threadTurns })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId),
    )
    .where(eq(schema.threadTurnQueueState.threadId, threadId))
    .limit(1);
  return active?.turn ?? null;
}

export async function requestDurableTurnStop(input: {
  threadId?: string | undefined;
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.id, input.turnId),
          ...(input.threadId
            ? [eq(schema.threadTurns.threadId, input.threadId)]
            : []),
          eq(schema.threadTurns.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    await lockAccessibleThread(tx, {
      threadId: candidate.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (
      !(
        turn && ["queued", "running", "waiting_for_input"].includes(turn.status)
      ) ||
      queueState?.activeTurnId !== turn.id
    ) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only an active turn can be stopped.",
      );
    }
    if (turn.cancelRequestedAt) {
      return turn;
    }
    const cleanupInteraction = await tx.query.threadInteractions.findFirst({
      where: and(
        turn.resumeInteractionId
          ? eq(schema.threadInteractions.id, turn.resumeInteractionId)
          : eq(schema.threadInteractions.turnId, turn.id),
        eq(schema.threadInteractions.organizationId, turn.organizationId),
        eq(schema.threadInteractions.threadId, turn.threadId),
        eq(schema.threadInteractions.turnId, turn.id),
        eq(schema.threadInteractions.source, "runtime"),
        eq(schema.threadInteractions.status, "processing"),
      ),
    });
    const preservesPreparedCleanup =
      cleanupInteraction !== undefined &&
      readPreparedApprovalCleanupFromResponse(
        cleanupInteraction.responseEnvelope,
      ) !== null;
    const now = new Date();
    if (
      !preservesPreparedCleanup &&
      (turn.status === "queued" || turn.status === "waiting_for_input")
    ) {
      assertThreadTurnTransition(turn.status, "cancelled");
      const [cancelled] = await tx
        .update(schema.threadTurns)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          failureCode: "TURN_STOPPED",
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.threadTurns.id, turn.id))
        .returning();
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          activeTurnId: null,
          state: "paused",
          pauseReason: "turn_cancelled",
          version: (queueState?.version ?? 0) + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
      if (turn.status === "waiting_for_input") {
        await tx
          .update(schema.threadInteractions)
          .set({ status: "cancelled", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.threadInteractions.turnId, turn.id),
              eq(schema.threadInteractions.status, "pending"),
            ),
          );
      }
      await appendTurnEvent(tx, {
        turnId: turn.id,
        type: "turn.cancelled",
        data: {
          status: "cancelled",
          requestedByUserId: input.userId,
          interruptMode: "immediate",
        },
      });
      return cancelled ?? turn;
    }
    const [updated] = await tx
      .update(schema.threadTurns)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: "turn.stop_requested",
      data: {
        requestedByUserId: input.userId,
        interruptMode: preservesPreparedCleanup
          ? "prepared_cleanup_after_release"
          : "safe_boundary_deadline",
        ...(preservesPreparedCleanup
          ? {}
          : {
              interruptDeadlineAt: new Date(
                now.getTime() + DURABLE_TURN_STOP_GRACE_MS,
              ).toISOString(),
            }),
      },
    });
    return updated ?? turn;
  });
}

export async function removeQueuedDurableTurn(input: {
  turnId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(
        and(
          eq(schema.threadTurns.id, input.turnId),
          eq(schema.threadTurns.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn not found.");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    await lockAccessibleThread(tx, {
      threadId: candidate.threadId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1)
      .for("update");
    if (!(turn && turn.status === "queued")) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "Only a queued turn can be removed.",
      );
    }
    if (turn.authorUserId !== input.userId) {
      throw new DurableTurnError(
        "TURN_FORBIDDEN",
        "Only the queued turn author can remove it.",
      );
    }
    assertThreadTurnTransition("queued", "cancelled");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId))
      .limit(1)
      .for("update");
    const now = new Date();
    const removedActiveTurn = queueState?.activeTurnId === turn.id;
    await tx
      .delete(schema.threadTurns)
      .where(eq(schema.threadTurns.id, turn.id));
    const next = removedActiveTurn
      ? await findNextQueuedTurn(tx, turn.threadId)
      : null;
    if (queueState) {
      await tx
        .update(schema.threadTurnQueueState)
        .set({
          activeTurnId: removedActiveTurn
            ? (next?.id ?? null)
            : queueState.activeTurnId,
          version: queueState.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    }
    if (turn.inputMessageId) {
      await tx
        .delete(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.id, turn.inputMessageId),
            eq(schema.threadMessages.threadId, turn.threadId),
          ),
        );
    }
    return {
      turn: {
        ...turn,
        status: "cancelled" as const,
        failureCode: "TURN_REMOVED",
        finishedAt: now,
        updatedAt: now,
      },
      nextTurnId: next?.id ?? null,
    };
  });
}

export async function resumeDurableThreadQueue(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(input.threadId)}, 0))`,
    );
    await lockAccessibleThread(tx, input);
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId))
      .limit(1)
      .for("update");
    if (!queueState) {
      throw new DurableTurnError("TURN_NOT_FOUND", "Turn queue not found.");
    }
    if (queueState.activeTurnId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The Thread already has an active turn.",
      );
    }
    const next = await findNextQueuedTurn(tx, input.threadId);
    const now = new Date();
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        activeTurnId: next?.id ?? null,
        state: "running",
        pauseReason: null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, input.threadId));
    return { nextTurnId: next?.id ?? null };
  });
}

export async function syncDurableTurnInteractionState(input: {
  turnId: string;
  waiting: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, input.turnId))
      .limit(1);
    if (!candidate) {
      return null;
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${queueLockKey(candidate.threadId)}, 0))`,
    );
    const [turn] = await tx
      .select()
      .from(schema.threadTurns)
      .where(eq(schema.threadTurns.id, candidate.id))
      .limit(1)
      .for("update");
    const [queueState] = await tx
      .select()
      .from(schema.threadTurnQueueState)
      .where(eq(schema.threadTurnQueueState.threadId, candidate.threadId))
      .limit(1)
      .for("update");
    if (!(turn && queueState?.activeTurnId === turn.id)) {
      return null;
    }
    const targetStatus = input.waiting ? "waiting_for_input" : "running";
    if (turn.status === targetStatus) {
      return turn;
    }
    if (
      (input.waiting && turn.status !== "running") ||
      (!input.waiting && turn.status !== "waiting_for_input")
    ) {
      return null;
    }
    assertThreadTurnTransition(turn.status, targetStatus);
    const now = new Date();
    const [updated] = await tx
      .update(schema.threadTurns)
      .set({ status: targetStatus, updatedAt: now })
      .where(eq(schema.threadTurns.id, turn.id))
      .returning();
    await tx
      .update(schema.threadTurnQueueState)
      .set({
        state: input.waiting ? "paused" : "running",
        pauseReason: input.waiting ? "interaction_required" : null,
        version: queueState.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.threadTurnQueueState.threadId, turn.threadId));
    await appendTurnEvent(tx, {
      turnId: turn.id,
      type: input.waiting ? "interaction.required" : "interaction.resolved",
      data: { status: targetStatus },
    });
    await updateMobileTurnPresentation(tx, {
      turnId: turn.id,
      stage: input.waiting ? "waiting" : "retrying",
      now,
    });
    if (input.waiting) {
      const devices = await tx
        .select({ id: schema.mobileDeviceRegistrations.id })
        .from(schema.mobileDeviceRegistrations)
        .where(
          and(
            eq(schema.mobileDeviceRegistrations.userId, turn.authorUserId),
            eq(schema.mobileDeviceRegistrations.enabled, true),
          ),
        );
      if (devices.length > 0) {
        await tx
          .insert(schema.mobilePushDeliveries)
          .values(
            devices.map((device) => ({
              id: crypto.randomUUID(),
              deviceRegistrationId: device.id,
              organizationId: turn.organizationId,
              threadId: turn.threadId,
              turnId: turn.id,
              kind: "attention" as const,
              status: "pending" as const,
            })),
          )
          .onConflictDoNothing({
            target: [
              schema.mobilePushDeliveries.turnId,
              schema.mobilePushDeliveries.deviceRegistrationId,
              schema.mobilePushDeliveries.kind,
            ],
          });
      }
    }
    return updated ?? turn;
  });
}
