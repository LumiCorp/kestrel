import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type {
  DesktopWorkspaceCheckpointCaptureResult,
  DesktopWorkspaceCheckpointDiffResult,
  DesktopWorkspaceCheckpointCleanupResult,
  DesktopWorkspaceCheckpointInspectResult,
  DesktopWorkspaceCheckpointRestoreResult,
  DesktopWorkspaceLifecycleState,
  DesktopWorkspacePromotionApplyResult,
  DesktopWorkspacePromotionPreviewResult,
  DesktopWorkspacePromotionUndoResult,
  DesktopManagedWorktreeCleanupResult,
  DesktopManagedWorktreeInspectionResult,
  DesktopManagedWorktreeRestoreResult,
} from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;

export async function getDesktopWorkspaceLifecycle(input: {
  adapter: ControlAdapter;
  sessionId: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceLifecycleState> {
  const sessionId = requiredString(input.sessionId, "sessionId");
  const [checkpointEvent, promotionEvent] = await Promise.all([
    input.adapter.sendControl({ type: "workspace.checkpoint.list", sessionId }, input.context),
    input.adapter.sendControl({ type: "workspace.promotion.list", sessionId }, input.context),
  ]);
  const checkpoints = checkpointPayload(checkpointEvent, "list", sessionId).checkpoints;
  const promotions = checkpointPayload(promotionEvent, "promotion.list", sessionId).promotions;
  if (!(Array.isArray(checkpoints) && Array.isArray(promotions))) {
    throw invalidResponse("Workspace lifecycle lists are missing.");
  }
  return { sessionId, checkpoints, promotions };
}

export async function captureDesktopWorkspaceCheckpoint(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceCheckpointCaptureResult> {
  const request = objectInput(input.request, "checkpoint capture");
  const sessionId = requiredString(request.sessionId, "sessionId");
  const label = requiredString(request.label, "label");
  const threadId = optionalString(request.threadId, "threadId");
  const event = await input.adapter.sendControl({
    type: "workspace.checkpoint.capture",
    sessionId,
    label,
    reason: `Desktop checkpoint: ${label}`,
    ...(threadId ? { threadId } : {}),
  }, input.context);
  const payload = checkpointPayload(event, "capture", sessionId);
  if (!payload.checkpoint) {
    throw invalidResponse("Captured checkpoint is missing.");
  }
  return { sessionId, checkpoint: payload.checkpoint };
}

export async function restoreDesktopWorkspaceCheckpoint(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceCheckpointRestoreResult> {
  const request = objectInput(input.request, "checkpoint restore");
  const sessionId = requiredString(request.sessionId, "sessionId");
  const checkpointId = requiredString(request.checkpointId, "checkpointId");
  const reason = requiredString(request.reason, "reason");
  const threadId = optionalString(request.threadId, "threadId");
  const event = await input.adapter.sendControl({
    type: "workspace.checkpoint.restore",
    sessionId,
    checkpointId,
    reason,
    ...(threadId ? { threadId } : {}),
  }, input.context);
  const payload = checkpointPayload(event, "restore", sessionId);
  if (!payload.restore) {
    throw invalidResponse("Checkpoint restore record is missing.");
  }
  return { sessionId, restore: payload.restore };
}

export async function inspectDesktopWorkspaceCheckpoint(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceCheckpointInspectResult> {
  const request = objectInput(input.request, "checkpoint inspection");
  const sessionId = requiredString(request.sessionId, "sessionId");
  const checkpointId = requiredString(request.checkpointId, "checkpointId");
  const event = await input.adapter.sendControl({
    type: "workspace.checkpoint.inspect",
    sessionId,
    checkpointId,
  }, input.context);
  const payload = checkpointPayload(event, "inspect", sessionId);
  if (!payload.checkpoint) {
    throw invalidResponse("Inspected checkpoint is missing.");
  }
  return { sessionId, checkpoint: payload.checkpoint };
}

export async function compareDesktopWorkspaceCheckpoint(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceCheckpointDiffResult> {
  const request = objectInput(input.request, "checkpoint comparison");
  const sessionId = requiredString(request.sessionId, "sessionId");
  const sourceCheckpointId = requiredString(request.sourceCheckpointId, "sourceCheckpointId");
  const targetCheckpointId = optionalString(request.targetCheckpointId, "targetCheckpointId");
  const targetGitRef = optionalString(request.targetGitRef, "targetGitRef");
  if (targetCheckpointId && targetGitRef) throw invalidInput("Select one checkpoint comparison target.");
  const event = await input.adapter.sendControl({
    type: "workspace.checkpoint.diff",
    sessionId,
    source: { checkpointId: sourceCheckpointId },
    target: targetCheckpointId ? { checkpointId: targetCheckpointId } : targetGitRef ? { gitRef: targetGitRef } : { workingTree: true },
    includeHunks: true,
  }, input.context);
  const payload = checkpointPayload(event, "diff", sessionId);
  if (!payload.diff) {
    throw invalidResponse("Checkpoint comparison is missing.");
  }
  return { sessionId, diff: payload.diff };
}

export async function cleanupDesktopWorkspaceCheckpoints(input: { adapter: ControlAdapter; request: unknown; context: WebRunnerRequestContext }): Promise<DesktopWorkspaceCheckpointCleanupResult> {
  const request = objectInput(input.request, "checkpoint cleanup"); const sessionId = requiredString(request.sessionId, "sessionId"); const reason = optionalString(request.reason, "reason");
  const event = await input.adapter.sendControl({ type: "workspace.checkpoint.cleanup", sessionId, ...(reason ? { reason } : {}) }, input.context); const payload = checkpointPayload(event, "cleanup", sessionId);
  if (!(payload.cleanup && payload.deletedCheckpoints ) || payload.remainingCheckpointCount === undefined || payload.remainingBytes === undefined) throw invalidResponse("Checkpoint cleanup result is incomplete.");
  return { cleanup: payload.cleanup, deletedCheckpoints: payload.deletedCheckpoints, remainingCheckpointCount: payload.remainingCheckpointCount, remainingBytes: payload.remainingBytes };
}

export async function previewDesktopWorkspacePromotion(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspacePromotionPreviewResult> {
  const request = promotionRequest(input.request);
  const event = await input.adapter.sendControl({
    type: "workspace.promotion.preview",
    sessionId: request.sessionId,
    promotionId: request.promotionId,
  }, input.context);
  const payload = checkpointPayload(event, "promotion.preview", request.sessionId);
  if (!payload.preview) {
    throw invalidResponse("Promotion preview is missing.");
  }
  return { sessionId: request.sessionId, preview: payload.preview };
}

export async function applyDesktopWorkspacePromotion(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspacePromotionApplyResult> {
  const request = promotionRequest(input.request);
  const candidateFingerprint = requiredString(request.record.candidateFingerprint, "candidateFingerprint");
  const event = await input.adapter.sendControl({
    type: "workspace.promotion.apply",
    sessionId: request.sessionId,
    promotionId: request.promotionId,
    candidateFingerprint,
  }, input.context);
  const payload = checkpointPayload(event, "promotion.apply", request.sessionId);
  if (!payload.promotion) {
    throw invalidResponse("Applied promotion record is missing.");
  }
  return { sessionId: request.sessionId, promotion: payload.promotion };
}

export async function undoLatestDesktopWorkspacePromotion(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspacePromotionUndoResult> {
  const request = objectInput(input.request, "promotion undo");
  const sessionId = requiredString(request.sessionId, "sessionId");
  const reason = optionalString(request.reason, "reason");
  const event = await input.adapter.sendControl({
    type: "workspace.promotion.undo_latest",
    sessionId,
    ...(reason ? { reason } : {}),
  }, input.context);
  const payload = checkpointPayload(event, "promotion.undo_latest", sessionId);
  if (!payload.restore) {
    throw invalidResponse("Promotion restore record is missing.");
  }
  return { sessionId, restore: payload.restore };
}

export async function inspectDesktopManagedWorktree(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopManagedWorktreeInspectionResult> {
  const request = managedWorktreeRequest(input.request);
  const event = await input.adapter.sendControl({
    type: "workspace.managed.inspect",
    sessionId: request.sessionId,
    threadId: request.threadId,
  }, input.context);
  const payload = checkpointPayload(event, "managed.inspect", request.sessionId);
  if (!payload.managedInspection) {
    throw invalidResponse("Managed worktree inspection is missing.");
  }
  return { sessionId: request.sessionId, inspection: payload.managedInspection };
}

export async function cleanupDesktopManagedWorktree(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopManagedWorktreeCleanupResult> {
  const request = managedWorktreeRequest(input.request);
  const reason = requiredString(request.record.reason, "reason");
  const event = await input.adapter.sendControl({
    type: "workspace.managed.cleanup",
    sessionId: request.sessionId,
    threadId: request.threadId,
    reason,
  }, input.context);
  const payload = checkpointPayload(event, "managed.cleanup", request.sessionId);
  if (!(payload.managedCleanup && payload.cleanupCheckpoint)) {
    throw invalidResponse("Managed worktree cleanup evidence is missing.");
  }
  return {
    sessionId: request.sessionId,
    checkpoint: payload.cleanupCheckpoint,
    cleanup: payload.managedCleanup,
  };
}

export async function restoreDesktopManagedWorktree(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopManagedWorktreeRestoreResult> {
  const request = managedWorktreeRequest(input.request);
  const checkpointId = requiredString(request.record.checkpointId, "checkpointId");
  const reason = optionalString(request.record.reason, "reason");
  const event = await input.adapter.sendControl({
    type: "workspace.managed.restore",
    sessionId: request.sessionId,
    threadId: request.threadId,
    checkpointId,
    ...(reason !== undefined ? { reason } : {}),
  }, input.context);
  const payload = checkpointPayload(event, "managed.restore", request.sessionId);
  if (!(payload.managedBinding && payload.restore)) {
    throw invalidResponse("Managed worktree restore evidence is missing.");
  }
  return {
    sessionId: request.sessionId,
    binding: payload.managedBinding,
    restore: payload.restore,
  };
}

export async function retryDesktopManagedWorktreeSetup(input: {
  adapter: ControlAdapter;
  request: unknown;
  context: WebRunnerRequestContext;
}): Promise<DesktopManagedWorktreeInspectionResult> {
  const request = managedWorktreeRequest(input.request);
  const event = await input.adapter.sendControl({
    type: "workspace.managed.setup.retry",
    sessionId: request.sessionId,
    threadId: request.threadId,
  }, input.context);
  const payload = checkpointPayload(event, "managed.setup.retry", request.sessionId);
  if (!payload.managedInspection) {
    throw invalidResponse("Managed worktree setup retry evidence is missing.");
  }
  return { sessionId: request.sessionId, inspection: payload.managedInspection };
}

function checkpointPayload(
  event: Awaited<ReturnType<ControlAdapter["sendControl"]>>,
  operation: string,
  sessionId: string,
) {
  if (event.type !== "workspace.checkpoint") {
    throw invalidResponse(`Runner returned '${event.type}' for ${operation}.`);
  }
  if (event.payload.operation !== operation || event.payload.sessionId !== sessionId) {
    throw invalidResponse(`Runner returned mismatched ${operation} workspace state.`);
  }
  return event.payload;
}

function promotionRequest(value: unknown) {
  const record = objectInput(value, "promotion");
  return {
    record,
    sessionId: requiredString(record.sessionId, "sessionId"),
    promotionId: requiredString(record.promotionId, "promotionId"),
  };
}

function managedWorktreeRequest(value: unknown) {
  const record = objectInput(value, "managed worktree");
  return {
    record,
    sessionId: requiredString(record.sessionId, "sessionId"),
    threadId: requiredString(record.threadId, "threadId"),
  };
}

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(`${label} input must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return ;
  }
  return requiredString(value, field);
}

function invalidInput(message: string) {
  return createDesktopError({ code: "desktop.invalid_workspace_lifecycle_input", message });
}

function invalidResponse(message: string) {
  return createDesktopError({ code: "desktop.workspace_lifecycle_invalid_response", message });
}
