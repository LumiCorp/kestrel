import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { resolveKestrelHomePath } from "../runtime/kestrelHome.js";

const execFileAsync = promisify(execFile);

export interface ManagedTaskWorktreeRequest {
  sessionId: string;
  runId?: string | undefined;
  sourceWorkspaceRoot: string;
  sourceRepoRoot?: string | undefined;
  taskId?: string | undefined;
  taskKey?: string | undefined;
  threadId?: string | undefined;
  isolation?: "scoped" | "session" | undefined;
  triggeringTool: string;
  approvalId?: string | undefined;
}

export type ManagedTaskWorktreeScopeKind = "taskId" | "taskKey" | "threadId" | "sessionId";

export interface ManagedTaskWorktreeScope {
  kind: ManagedTaskWorktreeScopeKind;
  value: string;
}

export interface ManagedTaskWorktreeLease {
  leaseId: string;
  sessionId: string;
  runId: string;
  acquiredAt: string;
  kind: "run" | "process" | "promotion";
}

export interface ManagedTaskWorktreeBinding {
  status: "bound";
  sessionId: string;
  runId?: string | undefined;
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  worktreeRoot: string;
  baseHead: string;
  lastObservedSourceHead: string;
  scope: ManagedTaskWorktreeScope;
  leaseId: string;
  leaseKind: ManagedTaskWorktreeLease["kind"];
  createdBySessionId: string;
  dirtyState: ManagedTaskWorktreeDirtyState;
  taskId?: string | undefined;
  taskKey?: string | undefined;
  threadId?: string | undefined;
  isolation?: "scoped" | "session" | undefined;
  triggeringTool: string;
  approvalId?: string | undefined;
  boundAt: string;
}

export interface ManagedTaskWorktreeProposal {
  sessionId: string;
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  worktreeRoot: string;
  baseHead: string;
  lastObservedSourceHead?: string | undefined;
  scope?: ManagedTaskWorktreeScope | undefined;
  taskId?: string | undefined;
  taskKey?: string | undefined;
  threadId?: string | undefined;
  isolation?: "scoped" | "session" | undefined;
  triggeringTool: string;
}

export interface ManagedTaskWorktreeProvisionResult {
  binding: ManagedTaskWorktreeBinding;
  disposition: "created" | "reused";
  recovery?: "orphan_reclaimed" | "rotated" | undefined;
  previousWorktreeRoot?: string | undefined;
}

export interface ManagedTaskWorktreeLeaseOwnerLookup {
  isLeaseActive(lease: ManagedTaskWorktreeLease): Promise<boolean>;
}

export interface ManagedTaskWorktreeProvisionRequest extends ManagedTaskWorktreeRequest {
  approvedProposal?: ManagedTaskWorktreeProposal | undefined;
  leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup | undefined;
}

interface ManagedTaskWorktreeMetadata {
  version: 1 | 2;
  createdBySessionId: string;
  sessionId?: string | undefined;
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  worktreeRoot: string;
  baseHead: string;
  lastObservedSourceHead?: string | undefined;
  bindingKey: string;
  scope?: ManagedTaskWorktreeScope | undefined;
  currentLease?: ManagedTaskWorktreeLease | undefined;
  activeProcesses?: ManagedTaskWorktreeProcessLease[] | undefined;
  bindings?: ManagedTaskWorktreeSessionBinding[] | undefined;
  dirtyState?: ManagedTaskWorktreeDirtyState | undefined;
  promotionState?: "pending_promotion" | "promotion_blocked" | "promoted" | "abandoned" | undefined;
  latestPromotionId?: string | undefined;
  latestPromotionStatus?: "promoted" | "noop" | "blocked" | "pending_review" | "skipped" | "failed" | undefined;
  promotionLockedAt?: string | undefined;
  taskId?: string | undefined;
  taskKey?: string | undefined;
  threadId?: string | undefined;
  isolation?: "scoped" | "session" | undefined;
  createdAt: string;
}

interface ManagedTaskWorktreeBindingRegistryGeneration {
  generation: number;
  worktreeRoot: string;
  status: "current" | "tombstoned";
  createdAt: string;
  tombstonedAt?: string | undefined;
  tombstoneReason?: string | undefined;
}

interface ManagedTaskWorktreeBindingRegistry {
  version: 1;
  bindingKey: string;
  sourceRepoRoot: string;
  scope: ManagedTaskWorktreeScope;
  currentGeneration: number;
  currentWorktreeRoot: string;
  generations: ManagedTaskWorktreeBindingRegistryGeneration[];
  createdAt: string;
  updatedAt: string;
}

interface ManagedTaskWorktreeSessionBinding {
  sessionId: string;
  firstBoundAt: string;
  lastBoundAt: string;
}

interface ManagedTaskWorktreeProcessLease {
  processId: string;
  sessionId: string;
  runId: string;
  startedAt: string;
}

export interface ManagedTaskWorktreeDirtyState {
  dirty: boolean;
  porcelain: string;
  checkedAt: string;
}

export function deriveManagedWorktreeWorkspaceTaskKey(workspace: unknown): string | undefined {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
    return undefined;
  }
  const record = workspace as Record<string, unknown>;
  const workspaceId = normalizeNonEmptyString(record.workspaceId);
  if (workspaceId !== undefined) {
    return `workspace:${workspaceId}`;
  }
  const workspaceRoot = normalizeNonEmptyString(record.sourceWorkspaceRoot) ?? normalizeNonEmptyString(record.workspaceRoot);
  return workspaceRoot !== undefined ? `workspace:${workspaceRoot}` : undefined;
}

export interface ManagedTaskWorktreeProcessStatusLookup {
  getProcess(processId: string): Promise<{
    processId: string;
    status: string;
    workspaceRoot: string;
  } | null>;
}

export interface ManagedTaskWorktreeRecoveryResult {
  status: "released" | "not_recoverable";
  reason: string;
  worktreeRoot: string;
  scope?: ManagedTaskWorktreeScope | undefined;
  leaseId?: string | undefined;
  leaseKind?: ManagedTaskWorktreeLease["kind"] | undefined;
  activeProcessIds: string[];
  releasedProcessIds: string[];
}

export interface ManagedTaskWorktreeStaleRunLeaseReleaseInput {
  worktreeRoot: string;
  leaseId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
}

export interface ManagedTaskWorktreeFanInCandidate {
  status: "ready" | "empty" | "blocked";
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  worktreeRoot: string;
  baseHead: string;
  currentSourceHead?: string | undefined;
  changedFiles: string[];
  candidateFingerprint?: string | undefined;
  dirtyState: ManagedTaskWorktreeDirtyState;
  scope: ManagedTaskWorktreeScope;
  applyBlockedReason?: "source_path_conflict" | "binding_invalid" | "invalid_path" | undefined;
  conflictPaths?: string[] | undefined;
  invalidPaths?: string[] | undefined;
}

export interface ManagedTaskWorktreeFanInApplyResult {
  status: "applied";
  sourceWorkspaceRoot: string;
  sourceRepoRoot: string;
  worktreeRoot: string;
  changedFiles: string[];
  candidateFingerprint: string;
  appliedAt: string;
  appliedBy: string;
  runId?: string | undefined;
}

export interface ManagedTaskWorktreePromotionMetadataInput {
  worktreeRoot: string;
  promotionState: "pending_promotion" | "promotion_blocked" | "promoted" | "abandoned";
  promotionId: string;
  sessionId: string;
  latestPromotionId?: string | undefined;
  latestPromotionStatus?: "promoted" | "noop" | "blocked" | "pending_review" | "skipped" | "failed" | undefined;
  lockPromotion?: boolean | undefined;
  releaseLease?: boolean | undefined;
}

export async function releaseManagedWorktreeProcessLease(input: {
  worktreeRoot: string;
  processId: string;
}): Promise<void> {
  const metadataPath = `${input.worktreeRoot}.binding.json`;
  let raw: string;
  try {
    raw = await readFile(metadataPath, "utf8");
  } catch {
    return;
  }
  const metadata = parseMetadata(raw);
  if (metadata === undefined) {
    return;
  }
  const previousProcesses = metadata.activeProcesses ?? [];
  const activeProcesses = previousProcesses.filter((process) => process.processId !== input.processId);
  if (activeProcesses.length === previousProcesses.length) {
    return;
  }
  const nextLease =
    activeProcesses.length === 0 && metadata.currentLease?.kind === "process"
      ? undefined
      : metadata.currentLease;
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      ...metadata,
      activeProcesses,
      currentLease: nextLease,
      dirtyState: await readDirtyState(input.worktreeRoot),
    }, null, 2)}\n`,
    "utf8",
  );
}

type ExistingWorktreeInspection =
  | { status: "missing" }
  | { status: "valid"; metadata: ManagedTaskWorktreeMetadata }
  | { status: "recoverable"; action: "reclaim" | "rotate"; reason: "path_collision" | "metadata_mismatch" }
  | { status: "invalid"; reason: "path_collision" | "metadata_mismatch" | "active_lease"; activeLease?: ManagedTaskWorktreeLease | undefined };

export type ManagedTaskWorktreeValidationResult =
  | { status: "valid" }
  | { status: "invalid"; reason: "missing" | "path_collision" | "metadata_mismatch" };

export class ManagedTaskWorktreeService {
  private readonly homeDir: string;

  constructor(options: { homeDir?: string | undefined } = {}) {
    this.homeDir = options.homeDir ?? resolveKestrelHome();
  }

  async prepare(input: ManagedTaskWorktreeRequest): Promise<ManagedTaskWorktreeProposal> {
    const sourceWorkspaceRoot = await resolveRealDirectory(input.sourceWorkspaceRoot, "sourceWorkspaceRoot");
    const sourceRepoRoot = await this.resolveSourceRepoRoot(sourceWorkspaceRoot, input.sourceRepoRoot);
    const baseHead = await this.ensureSourceHead(sourceRepoRoot);
    const scope = resolveWorktreeScope(input);
    const worktreeRoot = await this.resolveCurrentWorktreeRoot({
      sourceRepoRoot,
      scope,
    });

    return {
      sessionId: input.sessionId,
      sourceWorkspaceRoot,
      sourceRepoRoot,
      worktreeRoot,
      baseHead,
      lastObservedSourceHead: baseHead,
      scope,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.triggeringTool,
    };
  }

  async provision(input: ManagedTaskWorktreeProvisionRequest): Promise<ManagedTaskWorktreeProvisionResult> {
    const proposal = input.approvedProposal === undefined
      ? await this.prepare(input)
      : await this.normalizeApprovedProposal(input, input.approvedProposal);
    const existing = await this.inspectExistingWorktree(proposal, input.leaseOwnerLookup);
    if (existing.status === "valid") {
      const metadata = await this.acquireLease(proposal, existing.metadata, input);
      await this.updateBindingRegistryCurrent(proposal, {
        currentWorktreeRoot: proposal.worktreeRoot,
        tombstonePrevious: false,
      });
      return {
        disposition: "reused",
        binding: await this.toBinding(proposal, input, metadata),
      };
    }
    if (existing.status === "recoverable") {
      if (existing.action === "reclaim") {
        await this.reclaimWorktreeRoot(proposal.worktreeRoot);
        await mkdir(path.dirname(proposal.worktreeRoot), { recursive: true });
        await git(proposal.sourceRepoRoot, ["worktree", "add", "--detach", proposal.worktreeRoot, proposal.baseHead]);
        const metadata = await this.writeMetadata(proposal, input);
        await this.updateBindingRegistryCurrent(proposal, {
          currentWorktreeRoot: proposal.worktreeRoot,
          tombstonePrevious: false,
        });
        return {
          disposition: "created",
          recovery: "orphan_reclaimed",
          binding: await this.toBinding(proposal, input, metadata),
        };
      }

      const rotatedProposal = await this.rotateProposal(proposal);
      await mkdir(path.dirname(rotatedProposal.worktreeRoot), { recursive: true });
      await git(rotatedProposal.sourceRepoRoot, ["worktree", "add", "--detach", rotatedProposal.worktreeRoot, rotatedProposal.baseHead]);
      const metadata = await this.writeMetadata(rotatedProposal, input);
      await this.updateBindingRegistryCurrent(rotatedProposal, {
        currentWorktreeRoot: rotatedProposal.worktreeRoot,
        tombstonePrevious: true,
        previousWorktreeRoot: proposal.worktreeRoot,
        tombstoneReason: existing.reason,
      });
      return {
        disposition: "created",
        recovery: "rotated",
        previousWorktreeRoot: proposal.worktreeRoot,
        binding: await this.toBinding(rotatedProposal, input, metadata),
      };
    }
    if (existing.status === "invalid") {
      if (existing.reason === "active_lease") {
        throw createRuntimeFailure(
          "MANAGED_WORKTREE_LEASE_BLOCKED",
          `Managed Kestrel worktree is already leased: ${proposal.worktreeRoot}`,
          {
            subsystem: "workspace",
            classification: "runtime",
            recoverable: true,
            blockedReason: "active_lease",
            worktreeRoot: proposal.worktreeRoot,
            sourceRepoRoot: proposal.sourceRepoRoot,
            scope: proposal.scope,
            ...(existing.activeLease !== undefined ? { activeLease: existing.activeLease } : {}),
          },
        );
      }
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_PATH_COLLISION",
        `Managed Kestrel worktree path is already occupied: ${proposal.worktreeRoot}`,
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: existing.reason,
          worktreeRoot: proposal.worktreeRoot,
          sourceRepoRoot: proposal.sourceRepoRoot,
          scope: proposal.scope,
        },
      );
    }

    await mkdir(path.dirname(proposal.worktreeRoot), { recursive: true });
    await git(proposal.sourceRepoRoot, ["worktree", "add", "--detach", proposal.worktreeRoot, proposal.baseHead]);
    const metadata = await this.writeMetadata(proposal, input);
    await this.updateBindingRegistryCurrent(proposal, {
      currentWorktreeRoot: proposal.worktreeRoot,
      tombstonePrevious: false,
    });
    return {
      disposition: "created",
      binding: await this.toBinding(proposal, input, metadata),
    };
  }

  async releaseLease(
    binding: ManagedTaskWorktreeBinding,
    input: { runId?: string | undefined; leaseId?: string | undefined } = {},
  ): Promise<ManagedTaskWorktreeBinding> {
    const proposal = proposalFromBinding(binding);
    const metadata = await this.readMetadata(proposal);
    if (metadata === undefined) {
      return binding;
    }
    const lease = metadata.currentLease;
    const runId = input.runId ?? binding.runId;
    const leaseId = input.leaseId ?? binding.leaseId;
    if (
      lease !== undefined &&
      lease.runId === runId &&
      lease.leaseId === leaseId &&
      (lease.kind === "run" || ((lease.kind === "process" || lease.kind === "promotion") && (metadata.activeProcesses ?? []).length === 0))
    ) {
      const next = {
        ...metadata,
        currentLease: undefined,
        dirtyState: await readDirtyState(binding.worktreeRoot),
      };
      await this.writeRawMetadata(binding.worktreeRoot, next);
    }
    return binding;
  }

  async attachProcess(
    binding: ManagedTaskWorktreeBinding,
    input: { processId: string; runId?: string | undefined; sessionId?: string | undefined },
  ): Promise<void> {
    const proposal = proposalFromBinding(binding);
    const metadata = await this.readMetadata(proposal);
    if (metadata === undefined) {
      return;
    }
    const runId = input.runId ?? binding.runId;
    const sessionId = input.sessionId ?? binding.sessionId;
    if (runId === undefined) {
      return;
    }
    const now = new Date().toISOString();
    const activeProcesses = [
      ...(metadata.activeProcesses ?? []).filter((process) => process.processId !== input.processId),
      {
        processId: input.processId,
        sessionId,
        runId,
        startedAt: now,
      },
    ];
    await this.writeRawMetadata(binding.worktreeRoot, {
      ...metadata,
      activeProcesses,
      currentLease: {
        leaseId: metadata.currentLease?.leaseId ?? binding.leaseId,
        sessionId,
        runId,
        acquiredAt: metadata.currentLease?.acquiredAt ?? now,
        kind: "process",
      },
      dirtyState: await readDirtyState(binding.worktreeRoot),
    });
  }

  async releaseProcess(input: { worktreeRoot: string; processId: string }): Promise<void> {
    await releaseManagedWorktreeProcessLease(input);
  }

  async updatePromotionMetadata(input: ManagedTaskWorktreePromotionMetadataInput): Promise<void> {
    const metadata = await this.readMetadata({ worktreeRoot: input.worktreeRoot });
    if (metadata === undefined) {
      return;
    }
    const now = new Date().toISOString();
    const currentLease = input.releaseLease === true
      ? undefined
      : input.lockPromotion === true
        ? {
            leaseId: input.promotionId,
            sessionId: input.sessionId,
            runId: input.promotionId,
            acquiredAt: now,
            kind: "promotion" as const,
          }
        : metadata.currentLease;
    await this.writeRawMetadata(input.worktreeRoot, {
      ...metadata,
      currentLease,
      promotionState: input.promotionState,
      ...(input.latestPromotionId !== undefined ? { latestPromotionId: input.latestPromotionId } : {}),
      ...(input.latestPromotionStatus !== undefined ? { latestPromotionStatus: input.latestPromotionStatus } : {}),
      ...(input.lockPromotion === true ? { promotionLockedAt: now } : {}),
      ...(input.lockPromotion !== true ? { promotionLockedAt: undefined } : {}),
      dirtyState: await readDirtyState(input.worktreeRoot),
    });
  }

  async inspectFanInCandidate(binding: ManagedTaskWorktreeBinding): Promise<ManagedTaskWorktreeFanInCandidate> {
    const validation = await this.validateBinding(binding);
    const changedPaths = validation.status === "valid"
      ? await this.readFanInChangedPaths(binding)
      : { changedFiles: [], invalidPaths: [] };
    const { changedFiles, invalidPaths } = changedPaths;
    const dirtyState = validation.status === "valid"
      ? await readDirtyState(binding.worktreeRoot)
      : binding.dirtyState;
    const currentSourceHead = await git(binding.sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
    const conflictPaths = validation.status === "valid"
      ? await this.readFanInConflictPaths(binding, changedFiles)
      : [];
    const candidateFingerprint =
      validation.status === "valid" && invalidPaths.length === 0 && changedFiles.length > 0
        ? await this.buildFanInCandidateFingerprint(binding, changedFiles)
        : undefined;
    const applyBlockedReason =
      validation.status !== "valid"
        ? "binding_invalid"
        : invalidPaths.length > 0
          ? "invalid_path"
        : conflictPaths.length > 0
          ? "source_path_conflict"
          : undefined;
    const status =
      changedFiles.length === 0
        ? "empty"
        : applyBlockedReason === undefined
          ? "ready"
          : "blocked";
    return {
      status,
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      worktreeRoot: binding.worktreeRoot,
      baseHead: binding.baseHead,
      ...(currentSourceHead !== undefined ? { currentSourceHead } : {}),
      changedFiles,
      ...(candidateFingerprint !== undefined ? { candidateFingerprint } : {}),
      dirtyState,
      scope: binding.scope,
      ...(applyBlockedReason !== undefined ? { applyBlockedReason } : {}),
      ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
      ...(invalidPaths.length > 0 ? { invalidPaths } : {}),
    };
  }

  async applyFanInCandidate(
    binding: ManagedTaskWorktreeBinding,
    input: {
      runId?: string | undefined;
      appliedBy?: string | undefined;
      candidateFingerprint?: string | undefined;
      allowActiveRunLease?: boolean | undefined;
      allowActivePromotionLease?: boolean | undefined;
      expectedPromotionId?: string | undefined;
    } = {},
  ): Promise<ManagedTaskWorktreeFanInApplyResult> {
    const metadata = await this.readMetadata({ worktreeRoot: binding.worktreeRoot });
    const activeLease = metadata?.currentLease;
    const requestedRunId = input.runId ?? binding.runId;
    const sameRunLease =
      activeLease !== undefined &&
      activeLease.kind === "run" &&
      requestedRunId !== undefined &&
      activeLease.runId === requestedRunId &&
      activeLease.sessionId === binding.sessionId &&
      activeLease.leaseId === binding.leaseId;
    const samePromotionLease =
      activeLease !== undefined &&
      activeLease.kind === "promotion" &&
      activeLease.sessionId === binding.sessionId &&
      input.expectedPromotionId !== undefined &&
      activeLease.runId === input.expectedPromotionId;
    if (
      activeLease !== undefined &&
      (input.allowActiveRunLease !== true || sameRunLease === false) &&
      (input.allowActivePromotionLease !== true || samePromotionLease === false)
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED",
        "Managed Kestrel worktree changes cannot be applied while the worktree is leased.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "active_lease",
          sourceRepoRoot: binding.sourceRepoRoot,
          worktreeRoot: binding.worktreeRoot,
          activeLease,
          scope: binding.scope,
        },
      );
    }
    const candidate = await this.inspectFanInCandidate(binding);
    if (candidate.status !== "ready") {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED",
        "Managed Kestrel worktree changes cannot be applied to the source workspace.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: candidate.applyBlockedReason ?? (candidate.changedFiles.length === 0 ? "no_changes" : "fan_in_not_ready"),
          sourceRepoRoot: binding.sourceRepoRoot,
          worktreeRoot: binding.worktreeRoot,
          expectedHead: binding.baseHead,
          currentSourceHead: candidate.currentSourceHead,
          changedFiles: candidate.changedFiles,
          conflictPaths: candidate.conflictPaths ?? [],
          scope: binding.scope,
        },
      );
    }
    if (candidate.candidateFingerprint === undefined) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED",
        "Managed Kestrel worktree changes cannot be applied without a candidate fingerprint.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "candidate_fingerprint_missing",
          sourceRepoRoot: binding.sourceRepoRoot,
          worktreeRoot: binding.worktreeRoot,
          changedFiles: candidate.changedFiles,
          scope: binding.scope,
        },
      );
    }
    if (
      input.candidateFingerprint !== undefined &&
      input.candidateFingerprint !== candidate.candidateFingerprint
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED",
        "Managed Kestrel worktree changes changed after the fan-in candidate was recorded.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "candidate_changed",
          sourceRepoRoot: binding.sourceRepoRoot,
          worktreeRoot: binding.worktreeRoot,
          expectedCandidateFingerprint: input.candidateFingerprint,
          currentCandidateFingerprint: candidate.candidateFingerprint,
          changedFiles: candidate.changedFiles,
          scope: binding.scope,
        },
      );
    }

    for (const relativePath of candidate.changedFiles) {
      await this.assertFanInFilePreconditions(binding, relativePath);
    }
    for (const relativePath of candidate.changedFiles) {
      await this.applyFanInFile(binding, relativePath);
    }

    return {
      status: "applied",
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      worktreeRoot: binding.worktreeRoot,
      changedFiles: candidate.changedFiles,
      candidateFingerprint: candidate.candidateFingerprint,
      appliedAt: new Date().toISOString(),
      appliedBy: input.appliedBy?.trim().length ? input.appliedBy.trim() : "operator",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
  }

  async readBindingForWorktreeRoot(worktreeRoot: string, input: { runId?: string | undefined } = {}): Promise<ManagedTaskWorktreeBinding | undefined> {
    const metadata = await this.readMetadata({ worktreeRoot });
    if (metadata === undefined) {
      return undefined;
    }
    const latestSessionBinding = [...(metadata.bindings ?? [])]
      .sort((left, right) => right.lastBoundAt.localeCompare(left.lastBoundAt))[0];
    const sessionId = latestSessionBinding?.sessionId ?? metadata.createdBySessionId;
    return {
      status: "bound",
      sessionId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sourceWorkspaceRoot: metadata.sourceWorkspaceRoot,
      sourceRepoRoot: metadata.sourceRepoRoot,
      worktreeRoot: metadata.worktreeRoot,
      baseHead: metadata.baseHead,
      lastObservedSourceHead: metadata.lastObservedSourceHead ?? metadata.baseHead,
      scope: metadata.scope ?? { kind: "sessionId", value: metadata.createdBySessionId },
      leaseId: metadata.currentLease?.leaseId ?? "released-lease",
      leaseKind: metadata.currentLease?.kind ?? "run",
      createdBySessionId: metadata.createdBySessionId,
      dirtyState: metadata.dirtyState ?? await readDirtyState(metadata.worktreeRoot),
      ...(metadata.taskId !== undefined ? { taskId: metadata.taskId } : {}),
      ...(metadata.taskKey !== undefined ? { taskKey: metadata.taskKey } : {}),
      ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {}),
      ...(metadata.isolation !== undefined ? { isolation: metadata.isolation } : {}),
      triggeringTool: "managed_worktree.fan_in",
      boundAt: latestSessionBinding?.lastBoundAt ?? metadata.createdAt,
    };
  }

  async releaseStaleProcessLease(input: {
    worktreeRoot: string;
    processLookup: ManagedTaskWorktreeProcessStatusLookup;
  }): Promise<ManagedTaskWorktreeRecoveryResult> {
    const metadata = await this.readMetadata({ worktreeRoot: input.worktreeRoot });
    if (metadata === undefined) {
      return {
        status: "not_recoverable",
        reason: "metadata_missing",
        worktreeRoot: input.worktreeRoot,
        activeProcessIds: [],
        releasedProcessIds: [],
      };
    }
    const activeProcesses = metadata.activeProcesses ?? [];
    const activeProcessIds = activeProcesses.map((process) => process.processId);
    const base = {
      worktreeRoot: metadata.worktreeRoot,
      scope: metadata.scope,
      leaseId: metadata.currentLease?.leaseId,
      leaseKind: metadata.currentLease?.kind,
      activeProcessIds,
      releasedProcessIds: [],
    };
    if (metadata.scope === undefined) {
      return { status: "not_recoverable", reason: "scope_missing", ...base };
    }
    if (metadata.currentLease?.kind !== "process") {
      return { status: "not_recoverable", reason: "lease_not_process_held", ...base };
    }
    if (activeProcesses.length === 0) {
      return { status: "not_recoverable", reason: "no_active_process_lease", ...base };
    }

    const processRecords = await Promise.all(
      activeProcesses.map(async (process) => ({
        process,
        record: await input.processLookup.getProcess(process.processId),
      })),
    );
    const stillRunning = processRecords.find(
      ({ record }) => record?.status === "RUNNING" && record.workspaceRoot === metadata.worktreeRoot,
    );
    if (stillRunning !== undefined) {
      return { status: "not_recoverable", reason: "process_still_running", ...base };
    }

    for (const { process } of processRecords) {
      await releaseManagedWorktreeProcessLease({
        worktreeRoot: metadata.worktreeRoot,
        processId: process.processId,
      });
    }
    return {
      status: "released",
      reason: "stale_process_lease_released",
      ...base,
      releasedProcessIds: activeProcessIds,
    };
  }

  async releaseStaleRunLease(input: ManagedTaskWorktreeStaleRunLeaseReleaseInput): Promise<ManagedTaskWorktreeRecoveryResult> {
    const metadata = await this.readMetadata({ worktreeRoot: input.worktreeRoot });
    if (metadata === undefined) {
      return {
        status: "not_recoverable",
        reason: "metadata_missing",
        worktreeRoot: input.worktreeRoot,
        activeProcessIds: [],
        releasedProcessIds: [],
      };
    }
    const activeProcesses = metadata.activeProcesses ?? [];
    const activeProcessIds = activeProcesses.map((process) => process.processId);
    const base = {
      worktreeRoot: metadata.worktreeRoot,
      scope: metadata.scope,
      leaseId: metadata.currentLease?.leaseId,
      leaseKind: metadata.currentLease?.kind,
      activeProcessIds,
      releasedProcessIds: [],
    };
    const lease = metadata.currentLease;
    if (metadata.scope === undefined) {
      return { status: "not_recoverable", reason: "scope_missing", ...base };
    }
    if (lease?.kind !== "run") {
      return { status: "not_recoverable", reason: "lease_not_run_held", ...base };
    }
    if (activeProcesses.length > 0) {
      return { status: "not_recoverable", reason: "active_process_lease_present", ...base };
    }
    if (input.leaseId !== undefined && input.leaseId !== lease.leaseId) {
      return { status: "not_recoverable", reason: "lease_id_mismatch", ...base };
    }
    if (input.runId !== undefined && input.runId !== lease.runId) {
      return { status: "not_recoverable", reason: "run_id_mismatch", ...base };
    }
    if (input.sessionId !== undefined && input.sessionId !== lease.sessionId) {
      return { status: "not_recoverable", reason: "session_id_mismatch", ...base };
    }

    await this.writeRawMetadata(metadata.worktreeRoot, {
      ...metadata,
      currentLease: undefined,
      dirtyState: await readDirtyState(metadata.worktreeRoot),
    });
    return {
      status: "released",
      reason: "stale_run_lease_released",
      ...base,
    };
  }

  async validateBinding(binding: ManagedTaskWorktreeBinding): Promise<ManagedTaskWorktreeValidationResult> {
    const inspection = await this.inspectExistingWorktree({
      sessionId: binding.sessionId,
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      worktreeRoot: binding.worktreeRoot,
      baseHead: binding.baseHead,
      lastObservedSourceHead: binding.lastObservedSourceHead,
      scope: binding.scope,
      ...(binding.taskId !== undefined ? { taskId: binding.taskId } : {}),
      ...(binding.taskKey !== undefined ? { taskKey: binding.taskKey } : {}),
      ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
      triggeringTool: binding.triggeringTool,
    });
    if (inspection.status === "valid") {
      return { status: "valid" };
    }
    if (inspection.status === "missing") {
      return { status: "invalid", reason: "missing" };
    }
    if (inspection.status === "invalid" && inspection.reason === "active_lease") {
      return { status: "invalid", reason: "path_collision" };
    }
    if (inspection.status === "invalid") {
      return { status: "invalid", reason: inspection.reason === "active_lease" ? "path_collision" : inspection.reason };
    }
    return { status: "invalid", reason: inspection.reason };
  }

  toRuntimeWorkspace(binding: ManagedTaskWorktreeBinding): Record<string, unknown> {
    return {
      workspaceRoot: binding.worktreeRoot,
      repoRoot: binding.worktreeRoot,
      managedWorktree: true,
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      baseHead: binding.baseHead,
      lastObservedSourceHead: binding.lastObservedSourceHead,
      sessionId: binding.sessionId,
      runId: binding.runId,
      scope: binding.scope,
      leaseId: binding.leaseId,
      leaseKind: binding.leaseKind,
      createdBySessionId: binding.createdBySessionId,
      dirtyState: binding.dirtyState,
      ...(binding.taskId !== undefined ? { taskId: binding.taskId } : {}),
      ...(binding.taskKey !== undefined ? { taskKey: binding.taskKey } : {}),
      ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
      ...(binding.isolation !== undefined ? { isolation: binding.isolation } : {}),
      worktreeBinding: {
        status: binding.status,
        sessionId: binding.sessionId,
        worktreeRoot: binding.worktreeRoot,
        sourceRepoRoot: binding.sourceRepoRoot,
        baseHead: binding.baseHead,
        lastObservedSourceHead: binding.lastObservedSourceHead,
        scope: binding.scope,
        leaseId: binding.leaseId,
        leaseKind: binding.leaseKind,
        createdBySessionId: binding.createdBySessionId,
        boundAt: binding.boundAt,
        ...(binding.approvalId !== undefined ? { approvalId: binding.approvalId } : {}),
        ...(binding.isolation !== undefined ? { isolation: binding.isolation } : {}),
      },
    };
  }

  private async normalizeApprovedProposal(
    input: ManagedTaskWorktreeRequest,
    approved: ManagedTaskWorktreeProposal,
  ): Promise<ManagedTaskWorktreeProposal> {
    const sourceWorkspaceRoot = await resolveRealDirectory(input.sourceWorkspaceRoot, "sourceWorkspaceRoot");
    const sourceRepoRoot = await this.resolveSourceRepoRoot(sourceWorkspaceRoot, input.sourceRepoRoot);
    const scope = resolveWorktreeScope(input);
    const expectedWorktreeRoot = await this.resolveCurrentWorktreeRoot({
      sourceRepoRoot,
      scope,
    });
    const worktreeRoot = approved.worktreeRoot.trim();
    const baseHead = approved.baseHead.trim();
    const proposal: ManagedTaskWorktreeProposal = {
      sessionId: input.sessionId,
      sourceWorkspaceRoot,
      sourceRepoRoot,
      worktreeRoot,
      baseHead,
      lastObservedSourceHead: approved.lastObservedSourceHead?.trim() ?? baseHead,
      scope,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.triggeringTool,
    };
    if (
      approved.sessionId !== proposal.sessionId ||
      approved.sourceWorkspaceRoot !== proposal.sourceWorkspaceRoot ||
      approved.sourceRepoRoot !== proposal.sourceRepoRoot ||
      approved.worktreeRoot !== proposal.worktreeRoot ||
      proposal.worktreeRoot !== expectedWorktreeRoot ||
      proposal.worktreeRoot.length === 0 ||
      approved.baseHead !== proposal.baseHead ||
      proposal.baseHead.length === 0 ||
      (approved.lastObservedSourceHead ?? baseHead) !== proposal.lastObservedSourceHead ||
      proposal.lastObservedSourceHead === undefined ||
      proposal.lastObservedSourceHead.length === 0 ||
      (approved.scope !== undefined && scopesEqual(approved.scope, proposal.scope) === false) ||
      (approved.taskId ?? "") !== (proposal.taskId ?? "") ||
      (approved.taskKey ?? "") !== (proposal.taskKey ?? "") ||
      (approved.threadId ?? "") !== (proposal.threadId ?? "") ||
      (approved.isolation ?? "") !== (proposal.isolation ?? "") ||
      approved.triggeringTool !== proposal.triggeringTool
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_APPROVED_PROPOSAL_MISMATCH",
        "Managed Kestrel worktree approval no longer matches the pending provisioning request.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "metadata_mismatch",
          sourceRepoRoot: proposal.sourceRepoRoot,
          worktreeRoot: proposal.worktreeRoot,
        },
      );
    }
    return proposal;
  }

  private async resolveSourceRepoRoot(sourceWorkspaceRoot: string, requestedRepoRoot: string | undefined): Promise<string> {
    let gitRoot = await git(sourceWorkspaceRoot, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    if (gitRoot === undefined) {
      await git(sourceWorkspaceRoot, ["init"]);
      gitRoot = await git(sourceWorkspaceRoot, ["rev-parse", "--show-toplevel"]).catch((error) => {
        throw createRuntimeFailure(
          "MANAGED_WORKTREE_GIT_INIT_FAILED",
          "Managed Kestrel worktrees could not initialize a Git repository.",
          {
            subsystem: "workspace",
            classification: "configuration",
            recoverable: true,
            sourceWorkspaceRoot,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }
    const resolvedGitRoot = await realpath(gitRoot);
    if (requestedRepoRoot === undefined || requestedRepoRoot.trim().length === 0) {
      return resolvedGitRoot;
    }
    const requested = await resolveRealDirectory(requestedRepoRoot, "sourceRepoRoot");
    if (requested !== resolvedGitRoot) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_REPO_ROOT_MISMATCH",
        "Managed Kestrel worktree sourceRepoRoot must match the Git repository root.",
        {
          subsystem: "workspace",
          classification: "configuration",
          recoverable: true,
          requestedRepoRoot: requested,
          gitRepoRoot: resolvedGitRoot,
        },
      );
    }
    return requested;
  }

  private async ensureSourceHead(sourceRepoRoot: string): Promise<string> {
    const existingHead = await git(sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
    if (existingHead !== undefined && existingHead.length > 0) {
      return existingHead;
    }

    await git(sourceRepoRoot, ["add", "-A", "--", "."]);
    const staged = await git(sourceRepoRoot, ["diff", "--cached", "--quiet"])
      .then(() => false)
      .catch(() => true);
    const commitArgs = staged
      ? ["commit", "-m", "Kestrel workspace baseline"]
      : ["commit", "--allow-empty", "-m", "Kestrel workspace baseline"];
    await git(sourceRepoRoot, commitArgs, baselineCommitEnv());
    return git(sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]);
  }

  private deriveWorktreeRoot(input: { sourceRepoRoot: string; scope: ManagedTaskWorktreeScope }): string {
    return this.deriveBaseWorktreeRoot(input);
  }

  private deriveBaseWorktreeRoot(input: { sourceRepoRoot: string; scope: ManagedTaskWorktreeScope }): string {
    const repoHash = shortHash(input.sourceRepoRoot, 12);
    const bindingSeed = `${input.scope.kind}:${input.scope.value}`;
    const bindingHash = shortHash(bindingSeed, 16);
    return path.join(this.homeDir, "worktrees", repoHash, bindingHash);
  }

  private deriveWorktreeRootForGeneration(baseWorktreeRoot: string, generation: number): string {
    return generation <= 1 ? baseWorktreeRoot : `${baseWorktreeRoot}-g${generation}`;
  }

  private async resolveCurrentWorktreeRoot(input: { sourceRepoRoot: string; scope: ManagedTaskWorktreeScope }): Promise<string> {
    const registry = await this.readBindingRegistry(input);
    if (registry?.currentWorktreeRoot !== undefined && registry.currentWorktreeRoot.trim().length > 0) {
      return registry.currentWorktreeRoot;
    }
    return this.deriveBaseWorktreeRoot(input);
  }

  private async inspectExistingWorktree(
    proposal: ManagedTaskWorktreeProposal,
    leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup,
  ): Promise<ExistingWorktreeInspection> {
    const exists = await stat(proposal.worktreeRoot).then(() => true, () => false);
    if (exists === false) {
      return { status: "missing" };
    }
    const metadata = await this.readMetadata(proposal);
    const target = await realpath(proposal.worktreeRoot).catch(() => proposal.worktreeRoot);
    const topLevel = await git(proposal.worktreeRoot, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    const resolvedTopLevel = topLevel === undefined ? undefined : await realpath(topLevel).catch(() => topLevel);
    if (resolvedTopLevel !== target) {
      return this.inspectPathCollision(proposal, metadata, leaseOwnerLookup);
    }
    const sourceCommonDir = await git(proposal.sourceRepoRoot, ["rev-parse", "--git-common-dir"]).then(resolveGitPath(proposal.sourceRepoRoot));
    const targetCommonDir = await git(proposal.worktreeRoot, ["rev-parse", "--git-common-dir"]).then(resolveGitPath(proposal.worktreeRoot));
    if (sourceCommonDir !== targetCommonDir) {
      return this.inspectPathCollision(proposal, metadata, leaseOwnerLookup);
    }
    if (metadata === undefined || metadataIdentityMatchesProposal(metadata, proposal) === false) {
      return { status: "invalid", reason: "metadata_mismatch" };
    }
    const targetHead = await git(proposal.worktreeRoot, ["rev-parse", "HEAD"]).catch(() => undefined);
    if (targetHead !== metadata.baseHead) {
      return { status: "recoverable", action: "rotate", reason: "metadata_mismatch" };
    }
    return { status: "valid", metadata };
  }

  private async inspectPathCollision(
    proposal: ManagedTaskWorktreeProposal,
    metadata: ManagedTaskWorktreeMetadata | undefined,
    leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup,
  ): Promise<ExistingWorktreeInspection> {
    if (await this.isReclaimableOrphanedWorktree(proposal, metadata, leaseOwnerLookup)) {
      return { status: "recoverable", action: "reclaim", reason: "path_collision" };
    }
    if (
      metadata !== undefined &&
      metadataIdentityMatchesProposal(metadata, proposal) &&
      await this.hasActiveRunLeaseOwner(metadata, leaseOwnerLookup)
    ) {
      return {
        status: "invalid",
        reason: "active_lease",
        activeLease: metadata.currentLease,
      };
    }
    if (metadata !== undefined && metadataIdentityMatchesProposal(metadata, proposal)) {
      return { status: "recoverable", action: "rotate", reason: "path_collision" };
    }
    return { status: "invalid", reason: "path_collision" };
  }

  private async isReclaimableOrphanedWorktree(
    proposal: ManagedTaskWorktreeProposal,
    metadata: ManagedTaskWorktreeMetadata | undefined,
    leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup,
  ): Promise<boolean> {
    if (metadata === undefined || metadataIdentityMatchesProposal(metadata, proposal) === false) {
      return false;
    }
    if ((metadata.activeProcesses ?? []).length > 0) {
      return false;
    }
    if (metadata.currentLease?.kind === "process" || metadata.currentLease?.kind === "promotion") {
      return false;
    }
    if (await this.hasActiveRunLeaseOwner(metadata, leaseOwnerLookup)) {
      return false;
    }
    const gitDirPointer = await readFile(path.join(proposal.worktreeRoot, ".git"), "utf8").catch(() => undefined);
    if (gitDirPointer === undefined) {
      return false;
    }
    const relativeGitDir = gitDirPointer.replace(/^gitdir:\s*/u, "").trim();
    if (relativeGitDir.length === 0) {
      return false;
    }
    const gitDir = path.resolve(proposal.worktreeRoot, relativeGitDir);
    const gitDirExists = await stat(gitDir).then(() => true, () => false);
    if (gitDirExists) {
      return false;
    }
    return (await this.sourceRepoHasRegisteredWorktree(proposal.sourceRepoRoot, proposal.worktreeRoot)) === false;
  }

  private async hasActiveRunLeaseOwner(
    metadata: ManagedTaskWorktreeMetadata,
    leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup,
  ): Promise<boolean> {
    if (metadata.currentLease?.kind !== "run" || leaseOwnerLookup === undefined) {
      return false;
    }
    return leaseOwnerLookup.isLeaseActive(metadata.currentLease);
  }

  private async sourceRepoHasRegisteredWorktree(sourceRepoRoot: string, worktreeRoot: string): Promise<boolean> {
    const listed = await git(sourceRepoRoot, ["worktree", "list", "--porcelain"]).catch(() => "");
    const normalizedTarget = await realpath(worktreeRoot).catch(() => worktreeRoot);
    for (const line of listed.split("\n")) {
      if (line.startsWith("worktree ") === false) {
        continue;
      }
      const candidate = line.slice("worktree ".length).trim();
      const normalizedCandidate = await realpath(candidate).catch(() => candidate);
      if (normalizedCandidate === normalizedTarget) {
        return true;
      }
    }
    return false;
  }

  private async acquireLease(
    proposal: ManagedTaskWorktreeProposal,
    metadata: ManagedTaskWorktreeMetadata,
    input: ManagedTaskWorktreeProvisionRequest,
  ): Promise<ManagedTaskWorktreeMetadata> {
    const runId = input.runId ?? `manual:${input.sessionId}`;
    const existingLease = metadata.currentLease;
    if (
      existingLease !== undefined &&
      (
        existingLease.kind === "promotion" ||
        existingLease.sessionId !== input.sessionId ||
        (existingLease.runId !== runId && existingLease.kind === "process")
      )
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_LEASE_BLOCKED",
        `Managed Kestrel worktree is already leased: ${proposal.worktreeRoot}`,
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "active_lease",
          worktreeRoot: proposal.worktreeRoot,
          sourceRepoRoot: proposal.sourceRepoRoot,
          scope: proposal.scope,
          activeLease: existingLease,
        },
      );
    }
    const now = new Date().toISOString();
    const lease: ManagedTaskWorktreeLease = existingLease?.runId === runId ? existingLease : {
      leaseId: shortHash(`${proposal.worktreeRoot}\0${input.sessionId}\0${runId}\0${now}`, 24),
      sessionId: input.sessionId,
      runId,
      acquiredAt: now,
      kind: "run",
    };
    const next = {
      ...metadata,
      version: 2 as const,
      lastObservedSourceHead: proposal.lastObservedSourceHead,
      scope: proposal.scope,
      currentLease: lease,
      dirtyState: await readDirtyState(proposal.worktreeRoot),
      bindings: upsertSessionBinding(metadata.bindings, input.sessionId, now),
    };
    await this.writeRawMetadata(proposal.worktreeRoot, next);
    return next;
  }

  private async toBinding(
    proposal: ManagedTaskWorktreeProposal,
    input: ManagedTaskWorktreeProvisionRequest,
    metadata: ManagedTaskWorktreeMetadata,
  ): Promise<ManagedTaskWorktreeBinding> {
    const lease = metadata.currentLease;
    if (lease === undefined) {
      throw createRuntimeFailure("MANAGED_WORKTREE_LEASE_MISSING", "Managed worktree provisioning did not acquire a lease.", {
        subsystem: "workspace",
        classification: "runtime",
        recoverable: true,
        worktreeRoot: proposal.worktreeRoot,
        scope: proposal.scope,
      });
    }
    return {
      status: "bound",
      sessionId: proposal.sessionId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sourceWorkspaceRoot: proposal.sourceWorkspaceRoot,
      sourceRepoRoot: proposal.sourceRepoRoot,
      worktreeRoot: proposal.worktreeRoot,
      baseHead: proposal.baseHead,
      lastObservedSourceHead: metadata.lastObservedSourceHead ?? proposal.lastObservedSourceHead ?? proposal.baseHead,
      scope: proposal.scope ?? resolveWorktreeScope(proposal),
      leaseId: lease.leaseId,
      leaseKind: lease.kind,
      createdBySessionId: metadata.createdBySessionId,
      dirtyState: metadata.dirtyState ?? await readDirtyState(proposal.worktreeRoot),
      ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
      ...(proposal.taskKey !== undefined ? { taskKey: proposal.taskKey } : {}),
      ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
      ...(proposal.isolation !== undefined ? { isolation: proposal.isolation } : {}),
      triggeringTool: proposal.triggeringTool,
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      boundAt: new Date().toISOString(),
    };
  }

  private metadataPath(proposal: Pick<ManagedTaskWorktreeProposal, "worktreeRoot">): string {
    return `${proposal.worktreeRoot}.binding.json`;
  }

  private async readMetadata(proposal: Pick<ManagedTaskWorktreeProposal, "worktreeRoot">): Promise<ManagedTaskWorktreeMetadata | undefined> {
    const raw = await readFile(this.metadataPath(proposal), "utf8").catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    return parseMetadata(raw);
  }

  private async writeMetadata(
    proposal: ManagedTaskWorktreeProposal,
    input: ManagedTaskWorktreeProvisionRequest,
  ): Promise<ManagedTaskWorktreeMetadata> {
    const now = new Date().toISOString();
    const runId = input.runId ?? `manual:${input.sessionId}`;
    const dirtyState = await readDirtyState(proposal.worktreeRoot);
    const metadata: ManagedTaskWorktreeMetadata = {
      version: 2,
      createdBySessionId: proposal.sessionId,
      sourceWorkspaceRoot: proposal.sourceWorkspaceRoot,
      sourceRepoRoot: proposal.sourceRepoRoot,
      worktreeRoot: proposal.worktreeRoot,
      baseHead: proposal.baseHead,
      lastObservedSourceHead: proposal.lastObservedSourceHead,
      bindingKey: bindingKeyForProposal(proposal),
      scope: proposal.scope,
      currentLease: {
        leaseId: shortHash(`${proposal.worktreeRoot}\0${proposal.sessionId}\0${runId}\0${now}`, 24),
        sessionId: proposal.sessionId,
        runId,
        acquiredAt: now,
        kind: "run",
      },
      activeProcesses: [],
      bindings: [{
        sessionId: proposal.sessionId,
        firstBoundAt: now,
        lastBoundAt: now,
      }],
      dirtyState,
      ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
      ...(proposal.taskKey !== undefined ? { taskKey: proposal.taskKey } : {}),
      ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
      ...(proposal.isolation !== undefined ? { isolation: proposal.isolation } : {}),
      createdAt: now,
    };
    await this.writeRawMetadata(proposal.worktreeRoot, metadata);
    return metadata;
  }

  private async writeRawMetadata(worktreeRoot: string, metadata: ManagedTaskWorktreeMetadata): Promise<void> {
    await writeFile(`${worktreeRoot}.binding.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  private async reclaimWorktreeRoot(worktreeRoot: string): Promise<void> {
    await rm(worktreeRoot, { recursive: true, force: true });
    await rm(`${worktreeRoot}.binding.json`, { force: true });
  }

  private async rotateProposal(proposal: ManagedTaskWorktreeProposal): Promise<ManagedTaskWorktreeProposal> {
    const locator = this.bindingLocator({
      sourceRepoRoot: proposal.sourceRepoRoot,
      scope: proposal.scope ?? resolveWorktreeScope(proposal),
    });
    const registry = await this.readBindingRegistry({
      sourceRepoRoot: proposal.sourceRepoRoot,
      scope: proposal.scope ?? resolveWorktreeScope(proposal),
    });
    let generation = Math.max(2, (registry?.currentGeneration ?? inferGenerationFromWorktreeRoot(locator.baseWorktreeRoot, proposal.worktreeRoot)) + 1);
    let worktreeRoot = this.deriveWorktreeRootForGeneration(locator.baseWorktreeRoot, generation);
    while (await stat(worktreeRoot).then(() => true, () => false)) {
      generation += 1;
      worktreeRoot = this.deriveWorktreeRootForGeneration(locator.baseWorktreeRoot, generation);
    }
    return {
      ...proposal,
      worktreeRoot,
    };
  }

  private bindingLocator(input: { sourceRepoRoot: string; scope: ManagedTaskWorktreeScope }): {
    repoHash: string;
    bindingHash: string;
    bindingKey: string;
    baseWorktreeRoot: string;
    registryPath: string;
  } {
    const repoHash = shortHash(input.sourceRepoRoot, 12);
    const bindingSeed = `${input.scope.kind}:${input.scope.value}`;
    const bindingHash = shortHash(bindingSeed, 16);
    const baseWorktreeRoot = path.join(this.homeDir, "worktrees", repoHash, bindingHash);
    return {
      repoHash,
      bindingHash,
      bindingKey: shortHash([input.sourceRepoRoot, input.scope.kind, input.scope.value].join("\0"), 24),
      baseWorktreeRoot,
      registryPath: path.join(this.homeDir, "worktrees", repoHash, "bindings", `${bindingHash}.json`),
    };
  }

  private async readBindingRegistry(input: {
    sourceRepoRoot: string;
    scope: ManagedTaskWorktreeScope;
  }): Promise<ManagedTaskWorktreeBindingRegistry | undefined> {
    const locator = this.bindingLocator(input);
    const raw = await readFile(locator.registryPath, "utf8").catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    return parseBindingRegistry(raw, locator.bindingKey, input.sourceRepoRoot, input.scope);
  }

  private async updateBindingRegistryCurrent(
    proposal: ManagedTaskWorktreeProposal,
    input: {
      currentWorktreeRoot: string;
      tombstonePrevious: boolean;
      previousWorktreeRoot?: string | undefined;
      tombstoneReason?: string | undefined;
    },
  ): Promise<void> {
    const scope = proposal.scope ?? resolveWorktreeScope(proposal);
    const locator = this.bindingLocator({
      sourceRepoRoot: proposal.sourceRepoRoot,
      scope,
    });
    const now = new Date().toISOString();
    const previous = await this.readBindingRegistry({
      sourceRepoRoot: proposal.sourceRepoRoot,
      scope,
    });
    const currentGeneration = inferGenerationFromWorktreeRoot(locator.baseWorktreeRoot, input.currentWorktreeRoot);
    const generations = (previous?.generations ?? [])
      .filter((entry) => entry.worktreeRoot !== input.currentWorktreeRoot)
      .map((entry) => {
        if (
          input.tombstonePrevious === true &&
          input.previousWorktreeRoot !== undefined &&
          entry.worktreeRoot === input.previousWorktreeRoot
        ) {
          return {
            ...entry,
            status: "tombstoned" as const,
            tombstonedAt: now,
            tombstoneReason: input.tombstoneReason ?? "rotated",
          };
        }
        return entry;
      });
    if (input.tombstonePrevious === true && input.previousWorktreeRoot !== undefined && generations.some((entry) => entry.worktreeRoot === input.previousWorktreeRoot) === false) {
      generations.push({
        generation: inferGenerationFromWorktreeRoot(locator.baseWorktreeRoot, input.previousWorktreeRoot),
        worktreeRoot: input.previousWorktreeRoot,
        status: "tombstoned",
        createdAt: previous?.createdAt ?? now,
        tombstonedAt: now,
        tombstoneReason: input.tombstoneReason ?? "rotated",
      });
    }
    generations.push({
      generation: currentGeneration,
      worktreeRoot: input.currentWorktreeRoot,
      status: "current",
      createdAt: now,
    });
    const registry: ManagedTaskWorktreeBindingRegistry = {
      version: 1,
      bindingKey: locator.bindingKey,
      sourceRepoRoot: proposal.sourceRepoRoot,
      scope,
      currentGeneration,
      currentWorktreeRoot: input.currentWorktreeRoot,
      generations: dedupeRegistryGenerations(generations, input.currentWorktreeRoot),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await mkdir(path.dirname(locator.registryPath), { recursive: true });
    await writeFile(locator.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  private async readFanInChangedPaths(binding: ManagedTaskWorktreeBinding): Promise<{
    changedFiles: string[];
    invalidPaths: string[];
  }> {
    const tracked = parseGitPathList(await gitRaw(binding.worktreeRoot, ["diff", "--name-only", "-z", "HEAD", "--"]));
    const untracked = parseGitPathList(await gitRaw(binding.worktreeRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const paths = [...new Set([...tracked, ...untracked])]
      .sort((left, right) => left.localeCompare(right));
    const changedFiles: string[] = [];
    const invalidPaths: string[] = [];
    for (const relativePath of paths) {
      if (isSafeRelativeGitPath(relativePath) === false || await this.isSupportedFanInPath(binding, relativePath) === false) {
        invalidPaths.push(relativePath);
        continue;
      }
      changedFiles.push(relativePath);
    }
    return {
      changedFiles,
      invalidPaths,
    };
  }

  private async isSupportedFanInPath(binding: ManagedTaskWorktreeBinding, relativePath: string): Promise<boolean> {
    const safePath = requireSafeRelativeGitPath(relativePath);
    const modeOutput = await git(binding.worktreeRoot, ["ls-files", "-s", "--", safePath]).catch(() => "");
    if (modeOutput.split("\n").some((line) => line.startsWith("160000 "))) {
      return false;
    }
    const worktreePath = path.resolve(binding.worktreeRoot, safePath);
    const fileStat = await lstat(worktreePath).catch(() => undefined);
    return fileStat === undefined || fileStat.isFile() || fileStat.isSymbolicLink();
  }

  private async readFanInConflictPaths(
    binding: ManagedTaskWorktreeBinding,
    changedFiles: string[],
  ): Promise<string[]> {
    const conflicts: string[] = [];
    for (const relativePath of changedFiles) {
      if (await this.sourcePathConflictsWithBase(binding, relativePath)) {
        conflicts.push(relativePath);
      }
    }
    return conflicts;
  }

  private async sourcePathConflictsWithBase(
    binding: ManagedTaskWorktreeBinding,
    relativePath: string,
  ): Promise<boolean> {
    const safePath = requireSafeRelativeGitPath(relativePath);
    const baseHasPath = await git(binding.sourceRepoRoot, ["cat-file", "-e", `${binding.baseHead}:${safePath}`])
      .then(() => true, () => false);
    const sourcePath = path.resolve(binding.sourceRepoRoot, safePath);
    if (baseHasPath === false && await pathExists(sourcePath)) {
      return true;
    }
    const worktreeDiff = await gitExitCode(binding.sourceRepoRoot, ["diff", "--quiet", binding.baseHead, "--", safePath]);
    if (worktreeDiff === 1) {
      return true;
    }
    if (worktreeDiff !== 0) {
      return true;
    }
    const indexDiff = await gitExitCode(binding.sourceRepoRoot, ["diff", "--cached", "--quiet", binding.baseHead, "--", safePath]);
    return indexDiff !== 0;
  }

  private async buildFanInCandidateFingerprint(
    binding: ManagedTaskWorktreeBinding,
    changedFiles: string[],
  ): Promise<string> {
    const hash = createHash("sha256");
    hash.update("kestrel-managed-worktree-fan-in-v1\0");
    hash.update(binding.sourceRepoRoot);
    hash.update("\0");
    hash.update(binding.worktreeRoot);
    hash.update("\0");
    hash.update(binding.baseHead);
    for (const relativePath of changedFiles) {
      const safePath = requireSafeRelativeGitPath(relativePath);
      const worktreePath = path.resolve(binding.worktreeRoot, safePath);
      const fileStat = await lstat(worktreePath).catch(() => undefined);
      hash.update("\0path\0");
      hash.update(safePath);
      if (fileStat === undefined) {
        hash.update("\0deleted");
        continue;
      }
      if (fileStat.isSymbolicLink()) {
        hash.update("\0symlink\0");
        hash.update(await readlink(worktreePath));
        continue;
      }
      if (fileStat.isFile()) {
        hash.update("\0file\0");
        hash.update(String(fileStat.mode & 0o777));
        hash.update("\0");
        hash.update(await readFile(worktreePath));
        continue;
      }
      hash.update("\0unsupported\0");
      hash.update(fileStat.isDirectory() ? "directory" : "special");
    }
    return hash.digest("hex");
  }

  private async applyFanInFile(binding: ManagedTaskWorktreeBinding, relativePath: string): Promise<void> {
    const safePath = requireSafeRelativeGitPath(relativePath);
    const sourcePath = path.resolve(binding.sourceRepoRoot, safePath);
    const worktreePath = path.resolve(binding.worktreeRoot, safePath);
    const fileStat = await lstat(worktreePath).catch(() => undefined);
    await assertSourceParentInsideRepo(binding.sourceRepoRoot, sourcePath);
    if (fileStat === undefined) {
      await rm(sourcePath, { force: true });
      return;
    }
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await removeExistingSourceLeaf(sourcePath);
    if (fileStat.isSymbolicLink()) {
      await symlink(await readlink(worktreePath), sourcePath);
      return;
    }
    if (fileStat.isFile() === false) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_PATH_UNSUPPORTED",
        "Managed worktree fan-in only supports files, symlinks, and deletions.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          path: safePath,
        },
      );
    }
    await copyFile(worktreePath, sourcePath);
    await chmod(sourcePath, fileStat.mode & 0o777);
  }

  private async assertFanInFilePreconditions(binding: ManagedTaskWorktreeBinding, relativePath: string): Promise<void> {
    const safePath = requireSafeRelativeGitPath(relativePath);
    const sourcePath = path.resolve(binding.sourceRepoRoot, safePath);
    await assertSourceParentInsideRepo(binding.sourceRepoRoot, sourcePath);
    const sourceStat = await lstat(sourcePath).catch(() => undefined);
    if (sourceStat?.isDirectory()) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_PATH_INVALID",
        "Managed worktree fan-in cannot replace an existing source directory with a file.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          blockedReason: "invalid_path",
          path: safePath,
          invalidPaths: [safePath],
        },
      );
    }
  }
}

function metadataIdentityMatchesProposal(
  metadata: ManagedTaskWorktreeMetadata,
  proposal: ManagedTaskWorktreeProposal,
): boolean {
  return (
    metadata.sourceWorkspaceRoot === proposal.sourceWorkspaceRoot &&
    metadata.sourceRepoRoot === proposal.sourceRepoRoot &&
    metadata.worktreeRoot === proposal.worktreeRoot &&
    scopesEqual(metadata.scope, proposal.scope) &&
    metadata.bindingKey === bindingKeyForProposal(proposal)
  );
}

function bindingKeyForProposal(proposal: ManagedTaskWorktreeProposal): string {
  const scope = proposal.scope ?? resolveWorktreeScope(proposal);
  return shortHash([
    proposal.sourceRepoRoot,
    scope.kind,
    scope.value,
  ].join("\0"), 24);
}

function resolveWorktreeScope(input: Pick<ManagedTaskWorktreeRequest, "sessionId" | "taskId" | "taskKey" | "threadId" | "isolation">): ManagedTaskWorktreeScope {
  if (input.isolation === "session") {
    return { kind: "sessionId", value: input.sessionId.trim() };
  }
  if (input.taskId !== undefined && input.taskId.trim().length > 0) {
    return { kind: "taskId", value: input.taskId.trim() };
  }
  if (input.taskKey !== undefined && input.taskKey.trim().length > 0) {
    return { kind: "taskKey", value: input.taskKey.trim() };
  }
  if (input.threadId !== undefined && input.threadId.trim().length > 0) {
    return { kind: "threadId", value: input.threadId.trim() };
  }
  return { kind: "sessionId", value: input.sessionId.trim() };
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseGitPathList(output: string): string[] {
  return output
    .split("\u0000")
    .filter((entry) => entry.length > 0);
}

function requireSafeRelativeGitPath(value: string): string {
  if (isSafeRelativeGitPath(value) === false) {
    throw createRuntimeFailure("MANAGED_WORKTREE_FAN_IN_PATH_INVALID", "Managed worktree fan-in path is invalid.", {
      subsystem: "workspace",
      classification: "runtime",
      recoverable: false,
      path: value,
    });
  }
  return value;
}

function isSafeRelativeGitPath(value: string): boolean {
  if (value.length === 0 || path.isAbsolute(value) || value.includes("\u0000")) {
    return false;
  }
  const normalized = path.posix.normalize(value.replaceAll(path.sep, "/"));
  return normalized !== "." && normalized === value.replaceAll(path.sep, "/") && normalized.startsWith("../") === false && normalized !== "..";
}

async function assertSourceParentInsideRepo(sourceRepoRoot: string, sourcePath: string): Promise<void> {
  const repoRoot = await realpath(sourceRepoRoot);
  const relativeParent = path.relative(sourceRepoRoot, path.dirname(sourcePath));
  const parts = relativeParent.split(path.sep).filter((part) => part.length > 0);
  let current = repoRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const currentStat = await lstat(current).catch(() => undefined);
    if (currentStat === undefined) {
      return;
    }
    if (currentStat.isSymbolicLink() || currentStat.isDirectory() === false) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_PATH_INVALID",
        "Managed worktree fan-in source parent path is not a safe repository directory.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: false,
          path: sourcePath,
        },
      );
    }
    const resolved = await realpath(current);
    if (isPathInside(repoRoot, resolved) === false) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_FAN_IN_PATH_INVALID",
        "Managed worktree fan-in source parent path resolves outside the repository.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: false,
          path: sourcePath,
        },
      );
    }
  }
}

async function removeExistingSourceLeaf(sourcePath: string): Promise<void> {
  const sourceStat = await lstat(sourcePath).catch(() => undefined);
  if (sourceStat === undefined) {
    return;
  }
  if (sourceStat.isDirectory()) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_FAN_IN_PATH_INVALID",
      "Managed worktree fan-in cannot replace an existing source directory with a file.",
      {
        subsystem: "workspace",
        classification: "runtime",
        recoverable: true,
        path: sourcePath,
      },
    );
  }
  await rm(sourcePath, { force: true });
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative.startsWith("..") === false && path.isAbsolute(relative) === false);
}

function normalizeScope(value: unknown): ManagedTaskWorktreeScope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const scopeValue = typeof record.value === "string" ? record.value.trim() : "";
  if (
    (kind === "taskId" || kind === "taskKey" || kind === "threadId" || kind === "sessionId") &&
    scopeValue.length > 0
  ) {
    return { kind, value: scopeValue };
  }
  return undefined;
}

function scopesEqual(left: ManagedTaskWorktreeScope | undefined, right: ManagedTaskWorktreeScope | undefined): boolean {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function parseMetadata(raw: string): ManagedTaskWorktreeMetadata | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ManagedTaskWorktreeMetadata>;
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      typeof parsed.sourceWorkspaceRoot !== "string" ||
      typeof parsed.sourceRepoRoot !== "string" ||
      typeof parsed.worktreeRoot !== "string" ||
      typeof parsed.baseHead !== "string" ||
      typeof parsed.bindingKey !== "string"
    ) {
      return undefined;
    }
    const legacySessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const createdBySessionId =
      typeof parsed.createdBySessionId === "string"
        ? parsed.createdBySessionId
        : legacySessionId;
    if (createdBySessionId === undefined) {
      return undefined;
    }
    const scope = normalizeScope(parsed.scope) ?? {
      kind: "sessionId" as const,
      value: createdBySessionId,
    };
    return {
      ...(parsed as ManagedTaskWorktreeMetadata),
      createdBySessionId,
      scope,
      lastObservedSourceHead:
        typeof parsed.lastObservedSourceHead === "string"
          ? parsed.lastObservedSourceHead
          : parsed.baseHead,
      bindings:
        Array.isArray(parsed.bindings) && parsed.bindings.every(isSessionBinding)
          ? parsed.bindings
          : [{
              sessionId: createdBySessionId,
              firstBoundAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
              lastBoundAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
            }],
      activeProcesses:
        Array.isArray(parsed.activeProcesses) && parsed.activeProcesses.every(isProcessLease)
          ? parsed.activeProcesses
          : [],
      dirtyState: isDirtyState(parsed.dirtyState) ? parsed.dirtyState : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseBindingRegistry(
  raw: string,
  expectedBindingKey: string,
  expectedSourceRepoRoot: string,
  expectedScope: ManagedTaskWorktreeScope,
): ManagedTaskWorktreeBindingRegistry | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ManagedTaskWorktreeBindingRegistry>;
    if (
      parsed.version !== 1 ||
      parsed.bindingKey !== expectedBindingKey ||
      parsed.sourceRepoRoot !== expectedSourceRepoRoot ||
      typeof parsed.currentGeneration !== "number" ||
      typeof parsed.currentWorktreeRoot !== "string"
    ) {
      return undefined;
    }
    const scope = normalizeScope(parsed.scope);
    if (scopesEqual(scope, expectedScope) === false) {
      return undefined;
    }
    const generations = Array.isArray(parsed.generations)
      ? parsed.generations.filter(isBindingRegistryGeneration)
      : [];
    return {
      version: 1,
      bindingKey: parsed.bindingKey,
      sourceRepoRoot: parsed.sourceRepoRoot,
      scope: expectedScope,
      currentGeneration: parsed.currentGeneration,
      currentWorktreeRoot: parsed.currentWorktreeRoot,
      generations,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

function upsertSessionBinding(
  bindings: ManagedTaskWorktreeSessionBinding[] | undefined,
  sessionId: string,
  now: string,
): ManagedTaskWorktreeSessionBinding[] {
  const existing = bindings ?? [];
  let found = false;
  const next = existing.map((binding) => {
    if (binding.sessionId !== sessionId) {
      return binding;
    }
    found = true;
    return {
      ...binding,
      lastBoundAt: now,
    };
  });
  if (found) {
    return next;
  }
  return [
    ...next,
    {
      sessionId,
      firstBoundAt: now,
      lastBoundAt: now,
    },
  ];
}

function proposalFromBinding(binding: ManagedTaskWorktreeBinding): ManagedTaskWorktreeProposal {
  return {
    sessionId: binding.sessionId,
    sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
    sourceRepoRoot: binding.sourceRepoRoot,
    worktreeRoot: binding.worktreeRoot,
    baseHead: binding.baseHead,
    lastObservedSourceHead: binding.lastObservedSourceHead,
    scope: binding.scope,
    ...(binding.taskId !== undefined ? { taskId: binding.taskId } : {}),
    ...(binding.taskKey !== undefined ? { taskKey: binding.taskKey } : {}),
    ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
    ...(binding.isolation !== undefined ? { isolation: binding.isolation } : {}),
    triggeringTool: binding.triggeringTool,
  };
}

async function readDirtyState(worktreeRoot: string): Promise<ManagedTaskWorktreeDirtyState> {
  const porcelain = await git(worktreeRoot, ["status", "--porcelain"]).catch(() => "");
  return {
    dirty: porcelain.length > 0,
    porcelain,
    checkedAt: new Date().toISOString(),
  };
}

function isSessionBinding(value: unknown): value is ManagedTaskWorktreeSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.firstBoundAt === "string" &&
    typeof record.lastBoundAt === "string"
  );
}

function isProcessLease(value: unknown): value is ManagedTaskWorktreeProcessLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.processId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.runId === "string" &&
    typeof record.startedAt === "string"
  );
}

function isBindingRegistryGeneration(value: unknown): value is ManagedTaskWorktreeBindingRegistryGeneration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.generation === "number" &&
    typeof record.worktreeRoot === "string" &&
    (record.status === "current" || record.status === "tombstoned") &&
    typeof record.createdAt === "string"
  );
}

function isDirtyState(value: unknown): value is ManagedTaskWorktreeDirtyState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.dirty === "boolean" &&
    typeof record.porcelain === "string" &&
    typeof record.checkedAt === "string"
  );
}

async function resolveRealDirectory(value: string, field: string): Promise<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createRuntimeFailure("MANAGED_WORKTREE_INPUT_INVALID", `${field} is required.`, {
      subsystem: "workspace",
      classification: "schema",
      recoverable: true,
      field,
    });
  }
  const resolved = path.resolve(trimmed);
  const entry = await stat(resolved).catch(() => undefined);
  if (entry === undefined || entry.isDirectory() === false) {
    throw createRuntimeFailure("MANAGED_WORKTREE_INPUT_INVALID", `${field} must be an existing directory.`, {
      subsystem: "workspace",
      classification: "schema",
      recoverable: true,
      field,
      path: resolved,
    });
  }
  return realpath(resolved);
}

function resolveKestrelHome(): string {
  return resolveKestrelHomePath();
}

async function git(cwd: string, args: string[], env?: Record<string, string | undefined>): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    env: env === undefined ? process.env : { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

async function gitExitCode(cwd: string, args: string[]): Promise<number> {
  try {
    await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : 1;
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  return stat(absolutePath).then(() => true, () => false);
}

function baselineCommitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "Kestrel",
    GIT_AUTHOR_EMAIL: "kestrel@example.invalid",
    GIT_COMMITTER_NAME: "Kestrel",
    GIT_COMMITTER_EMAIL: "kestrel@example.invalid",
  };
}

function resolveGitPath(cwd: string): (value: string) => Promise<string> {
  return async (value: string) => {
    const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    return realpath(resolved);
  };
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function inferGenerationFromWorktreeRoot(baseWorktreeRoot: string, worktreeRoot: string): number {
  if (worktreeRoot === baseWorktreeRoot) {
    return 1;
  }
  const match = /^(.+)-g(\d+)$/.exec(worktreeRoot);
  if (match?.[1] === baseWorktreeRoot) {
    const parsed = Number.parseInt(match[2] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
  }
  return 1;
}

function dedupeRegistryGenerations(
  generations: ManagedTaskWorktreeBindingRegistryGeneration[],
  currentWorktreeRoot: string,
): ManagedTaskWorktreeBindingRegistryGeneration[] {
  const byRoot = new Map<string, ManagedTaskWorktreeBindingRegistryGeneration>();
  for (const generation of generations) {
    const existing = byRoot.get(generation.worktreeRoot);
    if (
      existing === undefined ||
      (existing.status !== "current" && generation.status === "current") ||
      generation.generation > existing.generation
    ) {
      byRoot.set(generation.worktreeRoot, generation.worktreeRoot === currentWorktreeRoot
        ? { ...generation, status: "current", tombstonedAt: undefined, tombstoneReason: undefined }
        : generation);
    }
  }
  return [...byRoot.values()].sort((left, right) => left.generation - right.generation);
}
