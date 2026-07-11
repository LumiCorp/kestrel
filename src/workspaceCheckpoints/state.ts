import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupRecord,
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointState,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "./contracts.js";
import type {
  ProductWorkspaceCheckpointActivity,
  ProductWorkspaceCheckpointSummary,
} from "../project/contracts.js";

export function createEmptyWorkspaceCheckpointState(): WorkspaceCheckpointState {
  return {
    version: 1,
    checkpoints: [],
    restores: [],
    promotions: [],
    cleanupPolicy: createDefaultWorkspaceCheckpointCleanupPolicy(),
    cleanups: [],
  };
}

export function normalizeWorkspaceCheckpointState(value: unknown): WorkspaceCheckpointState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyWorkspaceCheckpointState();
  }
  const record = value as Record<string, unknown>;
  const checkpoints = Array.isArray(record.checkpoints)
    ? record.checkpoints.map(normalizeCheckpointRecord).filter((entry): entry is WorkspaceCheckpointRecord => entry !== undefined)
    : [];
  const restores = Array.isArray(record.restores)
    ? record.restores.map(normalizeRestoreRecord).filter((entry): entry is WorkspaceRestoreRecord => entry !== undefined)
    : [];
  const promotions = Array.isArray(record.promotions)
    ? record.promotions.map(normalizePromotionRecord).filter((entry): entry is WorkspacePromotionRecord => entry !== undefined)
    : [];
  const cleanups = Array.isArray(record.cleanups)
    ? record.cleanups.map(normalizeCleanupRecord).filter((entry): entry is WorkspaceCheckpointCleanupRecord => entry !== undefined)
    : [];
  return {
    version: 1,
    checkpoints,
    restores,
    promotions,
    cleanupPolicy: normalizeCleanupPolicy(record.cleanupPolicy),
    cleanups,
  };
}

export function createDefaultWorkspaceCheckpointCleanupPolicy(): WorkspaceCheckpointCleanupPolicy {
  return {
    maxCheckpointCount: 25,
    maxRetainedBytes: 1_073_741_824,
    maxAgeDaysByClass: {
      manual: 30,
      pre_mutation: 14,
      recovery_anchor: 30,
      source_pre_promotion: 30,
      source_post_promotion: 30,
    },
    protectLabeled: true,
    protectLatestPerThread: true,
    protectLatestPerRun: true,
    protectLatestPerTask: true,
  };
}

export function readWorkspaceCheckpointState(
  state: Record<string, unknown>,
): WorkspaceCheckpointState {
  const product = asRecord(state.product);
  return normalizeWorkspaceCheckpointState(product?.workspaceCheckpointState);
}

export function buildWorkspaceCheckpointStatePatch(
  state: Record<string, unknown>,
  checkpointState: WorkspaceCheckpointState,
): Record<string, unknown> {
  const product = asRecord(state.product) ?? {};
  const projectSnapshot = asRecord(product.projectSnapshot) ?? {};
  return {
    product: {
      ...product,
      workspaceCheckpointState: normalizeWorkspaceCheckpointState(checkpointState),
      projectSnapshot: {
        ...projectSnapshot,
        workspaceCheckpoints: buildWorkspaceCheckpointSummary(checkpointState),
      },
    },
  };
}

export function buildWorkspaceCheckpointSummary(
  checkpointState: WorkspaceCheckpointState,
): ProductWorkspaceCheckpointSummary {
  const latestCheckpoint = [...checkpointState.checkpoints]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestRestore = [...checkpointState.restores]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestPromotion = [...checkpointState.promotions]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestCleanup = [...checkpointState.cleanups]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  const recentActivity: ProductWorkspaceCheckpointActivity[] = [
    ...checkpointState.checkpoints.map((checkpoint) => ({
      id: `checkpoint:${checkpoint.checkpointId}`,
      kind: "capture" as const,
      checkpointId: checkpoint.checkpointId,
      label: checkpoint.label,
      status: checkpoint.captureStatus,
      timestamp: checkpoint.createdAt,
    })),
    ...checkpointState.restores.map((restore) => ({
      id: `restore:${restore.restoreId}`,
      kind: "restore" as const,
      checkpointId: restore.checkpointId,
      restoreId: restore.restoreId,
      label: restore.reason,
      status: restore.status,
      timestamp: restore.createdAt,
    })),
    ...checkpointState.promotions.map((promotion) => ({
      id: `promotion:${promotion.promotionId}`,
      kind: "promotion" as const,
      promotionId: promotion.promotionId,
      label: promotion.blockedReason !== undefined
        ? `Promotion ${promotion.blockedReason}`
        : "Managed worktree promotion",
      status: promotion.status,
      timestamp: promotion.completedAt ?? promotion.createdAt,
    })),
    ...checkpointState.cleanups.map((cleanup) => ({
      id: `cleanup:${cleanup.cleanupId}`,
      kind: "cleanup" as const,
      label: cleanup.reason,
      status: cleanup.trigger,
      timestamp: cleanup.createdAt,
    })),
  ]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 8);

  return {
    ...(latestCheckpoint !== undefined ? { latestCheckpointId: latestCheckpoint.checkpointId } : {}),
    ...(latestRestore !== undefined ? { latestRestoreId: latestRestore.restoreId, latestRestoreStatus: latestRestore.status } : {}),
    ...(latestPromotion !== undefined ? { latestPromotionId: latestPromotion.promotionId, latestPromotionStatus: latestPromotion.status } : {}),
    ...(latestCleanup !== undefined
      ? {
          latestCleanupId: latestCleanup.cleanupId,
          latestCleanupAt: latestCleanup.createdAt,
          latestCleanupDeletedCheckpointCount: latestCleanup.deletedCheckpointIds.length,
          retainedCheckpointCount: latestCleanup.retainedCheckpointCount,
          retainedBytes: latestCleanup.retainedBytes,
        }
      : {}),
    recentActivity,
  };
}

function normalizeCheckpointRecord(value: unknown): WorkspaceCheckpointRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.checkpointId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.workspaceRoot !== "string" ||
    typeof record.repoRoot !== "string" ||
    typeof record.label !== "string" ||
    (typeof record.isExplicitLabel !== "boolean" && typeof record.isExplicitLabel !== "undefined") ||
    typeof record.reason !== "string" ||
    typeof record.createdBy !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.gitRef !== "string" ||
    typeof record.manifestHash !== "string" ||
    typeof record.fileCount !== "number" ||
    typeof record.totalBytes !== "number"
  ) {
    return undefined;
  }
  return {
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    workspaceRoot: record.workspaceRoot,
    repoRoot: record.repoRoot,
    label: record.label,
    isExplicitLabel: record.isExplicitLabel === true,
    reason: record.reason,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    gitRef: record.gitRef,
    kind:
      isWorkspaceCheckpointKind(record.kind)
        ? record.kind
        : "manual",
    retentionClass:
      isWorkspaceCheckpointKind(record.retentionClass)
        ? record.retentionClass
        : "manual",
    workspaceRole: record.workspaceRole === "source" ? "source" : "managed_worktree",
    manifestHash: record.manifestHash,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    storageKind: "git_ref_v1",
    captureStatus: record.captureStatus === "FAILED" ? "FAILED" : "CAPTURED",
    ...(typeof record.pinnedAt === "string" ? { pinnedAt: record.pinnedAt } : {}),
    ...(typeof record.pinnedBy === "string" ? { pinnedBy: record.pinnedBy } : {}),
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record.headSha === "string" ? { headSha: record.headSha } : {}),
    ...(typeof record.baseCheckpointId === "string" ? { baseCheckpointId: record.baseCheckpointId } : {}),
    ...(typeof record.promotionId === "string" ? { promotionId: record.promotionId } : {}),
    ...(record.promotionPhase === "pre" || record.promotionPhase === "post" ? { promotionPhase: record.promotionPhase } : {}),
  };
}

function normalizeRestoreRecord(value: unknown): WorkspaceRestoreRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.restoreId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.checkpointId !== "string" ||
    typeof record.workspaceRoot !== "string" ||
    typeof record.repoRoot !== "string" ||
    typeof record.restoredBy !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    restoreId: record.restoreId,
    sessionId: record.sessionId,
    checkpointId: record.checkpointId,
    workspaceRoot: record.workspaceRoot,
    repoRoot: record.repoRoot,
    restoredBy: record.restoredBy,
    reason: record.reason,
    createdAt: record.createdAt,
    validationMessages: Array.isArray(record.validationMessages)
      ? record.validationMessages.filter((entry): entry is string => typeof entry === "string")
      : [],
    status:
      record.status === "FAILED" || record.status === "REJECTED"
        ? record.status
        : "COMPLETED",
    ...(typeof record.recoveryCheckpointId === "string" ? { recoveryCheckpointId: record.recoveryCheckpointId } : {}),
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
    ...(typeof record.promotionId === "string" ? { promotionId: record.promotionId } : {}),
    ...(typeof record.restoredAt === "string" ? { restoredAt: record.restoredAt } : {}),
  };
}

function normalizePromotionRecord(value: unknown): WorkspacePromotionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.promotionId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.sourceWorkspaceRoot !== "string" ||
    typeof record.sourceRepoRoot !== "string" ||
    typeof record.managedWorktreeRoot !== "string" ||
    typeof record.baseHead !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    promotionId: record.promotionId,
    sessionId: record.sessionId,
    runId: record.runId,
    sourceWorkspaceRoot: record.sourceWorkspaceRoot,
    sourceRepoRoot: record.sourceRepoRoot,
    managedWorktreeRoot: record.managedWorktreeRoot,
    baseHead: record.baseHead,
    status: normalizePromotionStatus(record.status),
    changedFiles: normalizeStringArray(record.changedFiles),
    conflictPaths: normalizeStringArray(record.conflictPaths),
    invalidPaths: normalizeStringArray(record.invalidPaths),
    createdAt: record.createdAt,
    ...(typeof record.sourcePreCheckpointId === "string" ? { sourcePreCheckpointId: record.sourcePreCheckpointId } : {}),
    ...(typeof record.sourcePostCheckpointId === "string" ? { sourcePostCheckpointId: record.sourcePostCheckpointId } : {}),
    ...(typeof record.candidateFingerprint === "string" ? { candidateFingerprint: record.candidateFingerprint } : {}),
    ...(typeof record.blockedReason === "string" ? { blockedReason: record.blockedReason } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.appliedBy === "string" ? { appliedBy: record.appliedBy } : {}),
    ...(typeof record.undoRestoreId === "string" ? { undoRestoreId: record.undoRestoreId } : {}),
    ...(typeof record.undoneAt === "string" ? { undoneAt: record.undoneAt } : {}),
    ...(typeof record.undoneBy === "string" ? { undoneBy: record.undoneBy } : {}),
  };
}

function normalizeCleanupPolicy(value: unknown): WorkspaceCheckpointCleanupPolicy {
  const record = asRecord(value) ?? {};
  const defaults = createDefaultWorkspaceCheckpointCleanupPolicy();
  const maxAgeRecord = asRecord(record.maxAgeDaysByClass) ?? {};
  return {
    maxCheckpointCount:
      Number.isInteger(record.maxCheckpointCount) && Number(record.maxCheckpointCount) > 0
        ? Number(record.maxCheckpointCount)
        : defaults.maxCheckpointCount,
    maxRetainedBytes:
      Number.isInteger(record.maxRetainedBytes) && Number(record.maxRetainedBytes) > 0
        ? Number(record.maxRetainedBytes)
        : defaults.maxRetainedBytes,
    maxAgeDaysByClass: {
      manual: Number.isInteger(maxAgeRecord.manual) && Number(maxAgeRecord.manual) >= 0
        ? Number(maxAgeRecord.manual)
        : defaults.maxAgeDaysByClass?.manual,
      pre_mutation: Number.isInteger(maxAgeRecord.pre_mutation) && Number(maxAgeRecord.pre_mutation) >= 0
        ? Number(maxAgeRecord.pre_mutation)
        : defaults.maxAgeDaysByClass?.pre_mutation,
      recovery_anchor: Number.isInteger(maxAgeRecord.recovery_anchor) && Number(maxAgeRecord.recovery_anchor) >= 0
        ? Number(maxAgeRecord.recovery_anchor)
        : defaults.maxAgeDaysByClass?.recovery_anchor,
      source_pre_promotion: Number.isInteger(maxAgeRecord.source_pre_promotion) && Number(maxAgeRecord.source_pre_promotion) >= 0
        ? Number(maxAgeRecord.source_pre_promotion)
        : defaults.maxAgeDaysByClass?.source_pre_promotion,
      source_post_promotion: Number.isInteger(maxAgeRecord.source_post_promotion) && Number(maxAgeRecord.source_post_promotion) >= 0
        ? Number(maxAgeRecord.source_post_promotion)
        : defaults.maxAgeDaysByClass?.source_post_promotion,
    },
    protectLabeled: record.protectLabeled !== false,
    protectLatestPerThread: record.protectLatestPerThread !== false,
    protectLatestPerRun: record.protectLatestPerRun !== false,
    protectLatestPerTask: record.protectLatestPerTask !== false,
  };
}

function isWorkspaceCheckpointKind(value: unknown): value is WorkspaceCheckpointRecord["kind"] {
  return value === "manual" ||
    value === "pre_mutation" ||
    value === "recovery_anchor" ||
    value === "source_pre_promotion" ||
    value === "source_post_promotion";
}

function normalizePromotionStatus(value: unknown): WorkspacePromotionRecord["status"] {
  return value === "promoted" ||
    value === "noop" ||
    value === "blocked" ||
    value === "pending_review" ||
    value === "skipped" ||
    value === "failed"
    ? value
    : "failed";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeCleanupRecord(value: unknown): WorkspaceCheckpointCleanupRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.cleanupId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.deletedBytes !== "number" ||
    typeof record.retainedCheckpointCount !== "number" ||
    typeof record.retainedBytes !== "number"
  ) {
    return undefined;
  }
  return {
    cleanupId: record.cleanupId,
    sessionId: record.sessionId,
    trigger: record.trigger === "manual" ? "manual" : "automatic",
    reason: record.reason,
    createdAt: record.createdAt,
    policy: normalizeCleanupPolicy(record.policy),
    deletedCheckpointIds: Array.isArray(record.deletedCheckpointIds)
      ? record.deletedCheckpointIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    deletedBytes: record.deletedBytes,
    retainedCheckpointCount: record.retainedCheckpointCount,
    retainedBytes: record.retainedBytes,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
