import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";

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
  baseRef?: string | undefined;
  setup?: ManagedTaskWorktreeSetupSpec | undefined;
}

export interface ManagedTaskWorktreeSetupSpec {
  approvedIgnoredFiles: string[];
  steps: ManagedTaskWorktreeSetupStep[];
}

export interface ManagedTaskWorktreeSetupStep {
  id: string;
  label: string;
  executable: string;
  args: string[];
}

export interface ManagedTaskWorktreeSetupState {
  status: "not_configured" | "pending" | "running" | "completed" | "failed";
  fingerprint?: string | undefined;
  attempts: number;
  approvedIgnoredFiles: string[];
  completedStepIds: string[];
  activeStepId?: string | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  failedAt?: string | undefined;
  failureStepId?: string | undefined;
  failureMessage?: string | undefined;
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
  baseRefName?: string | undefined;
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
  baseRefName?: string | undefined;
  lastObservedSourceHead?: string | undefined;
  scope?: ManagedTaskWorktreeScope | undefined;
  taskId?: string | undefined;
  taskKey?: string | undefined;
  threadId?: string | undefined;
  isolation?: "scoped" | "session" | undefined;
  triggeringTool: string;
  setup?: ManagedTaskWorktreeSetupSpec | undefined;
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
  baseRefName?: string | undefined;
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
  setup?: ManagedTaskWorktreeSetupState | undefined;
  setupSpec?: ManagedTaskWorktreeSetupSpec | undefined;
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

export interface ManagedTaskWorktreeProcessLease {
  processId: string;
  sessionId: string;
  runId: string;
  startedAt: string;
}

export interface ManagedTaskWorktreeLifecycleInspection {
  status: "valid" | "invalid";
  binding: ManagedTaskWorktreeBinding;
  validationReason?: "missing" | "path_collision" | "metadata_mismatch" | undefined;
  currentLease?: ManagedTaskWorktreeLease | undefined;
  activeProcesses: ManagedTaskWorktreeProcessLease[];
  dirtyState: ManagedTaskWorktreeDirtyState;
  storageBytes: number;
  storageScanTruncated: boolean;
  headSha?: string | undefined;
  currentSourceHead?: string | undefined;
  aheadCommitCount: number;
  staleBase: boolean;
  promotionState?: "pending_promotion" | "promotion_blocked" | "promoted" | "abandoned" | undefined;
  latestPromotionId?: string | undefined;
  latestPromotionStatus?: "promoted" | "noop" | "blocked" | "pending_review" | "skipped" | "failed" | undefined;
  setup: ManagedTaskWorktreeSetupState;
  retention: ManagedTaskWorktreeRetentionState;
}

export interface ManagedTaskWorktreeRetentionState {
  policy: "retain_until_explicit_cleanup";
  disposition: "blocked" | "retain_with_snapshot" | "clean_disposable";
  reasons: Array<
    | "binding_invalid"
    | "active_lease"
    | "active_processes"
    | "setup_incomplete"
    | "uncommitted_changes"
    | "unpromoted_commits"
    | "clean_and_no_commits"
  >;
  lastBoundAt?: string | undefined;
}

export interface ManagedTaskWorktreeCleanupResult {
  status: "cleaned";
  worktreeRoot: string;
  sourceRepoRoot: string;
  snapshotCheckpointId: string;
  removedBytes: number;
  cleanedAt: string;
  cleanedBy: string;
}

export interface ManagedTaskWorktreeDirtyState {
  dirty: boolean;
  porcelain: string;
  checkedAt: string;
}

export function deriveManagedWorktreeWorkspaceTaskKey(workspace: unknown): string | undefined {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
    return ;
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
    await this.ensureSourceHead(sourceRepoRoot);
    const baseRefName = normalizeNonEmptyString(input.baseRef)
      ?? await git(sourceRepoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD");
    const baseHead = await git(sourceRepoRoot, ["rev-parse", "--verify", `${baseRefName}^{commit}`]).catch(() => {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_BASE_REF_INVALID",
        `Managed worktree base ref '${baseRefName}' does not resolve to a commit.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, sourceRepoRoot, baseRefName },
      );
    });
    const scope = resolveWorktreeScope(input);
    const setup = normalizeManagedWorktreeSetupSpec(input.setup);
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
      baseRefName,
      lastObservedSourceHead: baseHead,
      scope,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.triggeringTool,
      ...(setup !== undefined ? { setup } : {}),
    };
  }

  async provision(input: ManagedTaskWorktreeProvisionRequest): Promise<ManagedTaskWorktreeProvisionResult> {
    const proposal = input.approvedProposal === undefined
      ? await this.prepare(input)
      : await this.normalizeApprovedProposal(input, input.approvedProposal);
    const existing = await this.inspectExistingWorktree(proposal, input.leaseOwnerLookup);
    if (existing.status === "valid") {
      const metadata = await this.runProvisioningSetup(
        proposal,
        await this.acquireLease(proposal, existing.metadata, input),
      );
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
        const metadata = await this.runProvisioningSetup(proposal, await this.writeMetadata(proposal, input));
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
      const metadata = await this.runProvisioningSetup(rotatedProposal, await this.writeMetadata(rotatedProposal, input));
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
    const metadata = await this.runProvisioningSetup(proposal, await this.writeMetadata(proposal, input));
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

  async retrySetup(input: ManagedTaskWorktreeRequest): Promise<ManagedTaskWorktreeProvisionResult> {
    const locator = await this.prepare({ ...input, setup: undefined });
    const metadata = await this.readMetadata(locator);
    if (metadata?.setupSpec === undefined || metadata.setup?.status !== "failed") {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_RETRY_UNAVAILABLE",
        "No failed managed worktree setup is available to retry.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          worktreeRoot: locator.worktreeRoot,
        },
      );
    }
    const approvedProposal: ManagedTaskWorktreeProposal = {
      sessionId: input.sessionId,
      sourceWorkspaceRoot: metadata.sourceWorkspaceRoot,
      sourceRepoRoot: metadata.sourceRepoRoot,
      worktreeRoot: metadata.worktreeRoot,
      baseHead: metadata.baseHead,
      baseRefName: metadata.baseRefName ?? metadata.baseHead,
      lastObservedSourceHead: metadata.lastObservedSourceHead ?? metadata.baseHead,
      scope: metadata.scope,
      ...(metadata.taskId !== undefined ? { taskId: metadata.taskId } : {}),
      ...(metadata.taskKey !== undefined ? { taskKey: metadata.taskKey } : {}),
      ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {}),
      ...(metadata.isolation !== undefined ? { isolation: metadata.isolation } : {}),
      triggeringTool: input.triggeringTool,
      setup: metadata.setupSpec,
    };
    return this.provision({
      ...input,
      sourceWorkspaceRoot: metadata.sourceWorkspaceRoot,
      sourceRepoRoot: metadata.sourceRepoRoot,
      baseRef: approvedProposal.baseRefName,
      setup: metadata.setupSpec,
      approvedProposal,
    });
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
    const currentSourceHead = await git(binding.sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => {});
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
      return ;
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

  async inspectLifecycle(binding: ManagedTaskWorktreeBinding): Promise<ManagedTaskWorktreeLifecycleInspection> {
    const validation = await this.validateBinding(binding);
    const metadata = await this.readMetadata({ worktreeRoot: binding.worktreeRoot });
    const dirtyState = validation.status === "valid"
      ? await readDirtyState(binding.worktreeRoot)
      : binding.dirtyState;
    const [headSha, currentSourceHead, aheadCommitText, storage] = await Promise.all([
      validation.status === "valid"
        ? git(binding.worktreeRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined)
        : Promise.resolve(undefined),
      git(binding.sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined),
      validation.status === "valid"
        ? git(binding.worktreeRoot, ["rev-list", "--count", `${binding.baseHead}..HEAD`]).catch(() => "0")
        : Promise.resolve("0"),
      validation.status === "valid"
        ? directoryStorageBytes(binding.worktreeRoot)
        : Promise.resolve({ bytes: 0, truncated: false }),
    ]);
    const aheadCommitCount = Number.parseInt(aheadCommitText.trim(), 10);
    const normalizedAheadCommitCount = Number.isFinite(aheadCommitCount) ? aheadCommitCount : 0;
    const activeProcesses = metadata?.activeProcesses ?? [];
    const setup = metadata?.setup ?? initialSetupState(undefined);
    return {
      status: validation.status,
      binding,
      ...(validation.status === "invalid" ? { validationReason: validation.reason } : {}),
      ...(metadata?.currentLease !== undefined ? { currentLease: metadata.currentLease } : {}),
      activeProcesses,
      dirtyState,
      storageBytes: storage.bytes,
      storageScanTruncated: storage.truncated,
      ...(headSha !== undefined ? { headSha } : {}),
      ...(currentSourceHead !== undefined ? { currentSourceHead } : {}),
      aheadCommitCount: normalizedAheadCommitCount,
      staleBase: currentSourceHead !== undefined && currentSourceHead !== binding.lastObservedSourceHead,
      ...(metadata?.promotionState !== undefined ? { promotionState: metadata.promotionState } : {}),
      ...(metadata?.latestPromotionId !== undefined ? { latestPromotionId: metadata.latestPromotionId } : {}),
      ...(metadata?.latestPromotionStatus !== undefined ? { latestPromotionStatus: metadata.latestPromotionStatus } : {}),
      setup,
      retention: managedWorktreeRetentionState({
        valid: validation.status === "valid",
        hasActiveLease: metadata?.currentLease !== undefined,
        activeProcessCount: activeProcesses.length,
        setup,
        dirty: dirtyState.dirty,
        aheadCommitCount: normalizedAheadCommitCount,
        lastBoundAt: latestSessionBindingAt(metadata?.bindings),
      }),
    };
  }

  async cleanupManagedWorktree(
    binding: ManagedTaskWorktreeBinding,
    input: {
      snapshotCheckpointId: string;
      cleanedBy?: string | undefined;
    },
  ): Promise<ManagedTaskWorktreeCleanupResult> {
    const snapshotCheckpointId = input.snapshotCheckpointId.trim();
    if (snapshotCheckpointId.length === 0) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_CLEANUP_SNAPSHOT_REQUIRED",
        "Managed worktree cleanup requires a recovery snapshot.",
        { worktreeRoot: binding.worktreeRoot, sourceRepoRoot: binding.sourceRepoRoot },
      );
    }
    const inspection = await this.inspectLifecycle(binding);
    if (inspection.status !== "valid") {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_CLEANUP_BLOCKED",
        "Managed worktree cleanup requires a valid binding.",
        {
          blockedReason: inspection.validationReason ?? "binding_invalid",
          worktreeRoot: binding.worktreeRoot,
          sourceRepoRoot: binding.sourceRepoRoot,
        },
      );
    }
    if (inspection.currentLease !== undefined || inspection.activeProcesses.length > 0) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_CLEANUP_BLOCKED",
        "Managed worktree cleanup is blocked while the workspace is leased or has active processes.",
        {
          blockedReason: inspection.activeProcesses.length > 0 ? "active_processes" : "active_lease",
          worktreeRoot: binding.worktreeRoot,
          sourceRepoRoot: binding.sourceRepoRoot,
          ...(inspection.currentLease !== undefined ? { activeLease: inspection.currentLease } : {}),
          activeProcessIds: inspection.activeProcesses.map((process) => process.processId),
        },
      );
    }
    await git(binding.sourceRepoRoot, ["worktree", "remove", "--force", binding.worktreeRoot]);
    await rm(this.metadataPath({ worktreeRoot: binding.worktreeRoot }), { force: true });
    return {
      status: "cleaned",
      worktreeRoot: binding.worktreeRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      snapshotCheckpointId,
      removedBytes: inspection.storageBytes,
      cleanedAt: new Date().toISOString(),
      cleanedBy: input.cleanedBy?.trim().length ? input.cleanedBy.trim() : "operator",
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
      ...(binding.baseRefName !== undefined ? { baseRefName: binding.baseRefName } : {}),
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
        ...(binding.baseRefName !== undefined ? { baseRefName: binding.baseRefName } : {}),
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
    const setup = normalizeManagedWorktreeSetupSpec(input.setup);
    const proposal: ManagedTaskWorktreeProposal = {
      sessionId: input.sessionId,
      sourceWorkspaceRoot,
      sourceRepoRoot,
      worktreeRoot,
      baseHead,
      baseRefName: approved.baseRefName ?? normalizeNonEmptyString(input.baseRef) ?? "HEAD",
      lastObservedSourceHead: approved.lastObservedSourceHead?.trim() ?? baseHead,
      scope,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.triggeringTool,
      ...(setup !== undefined ? { setup } : {}),
    };
    if (
      approved.sessionId !== proposal.sessionId ||
      approved.sourceWorkspaceRoot !== proposal.sourceWorkspaceRoot ||
      approved.sourceRepoRoot !== proposal.sourceRepoRoot ||
      approved.worktreeRoot !== proposal.worktreeRoot ||
      proposal.worktreeRoot !== expectedWorktreeRoot ||
      proposal.worktreeRoot.length === 0 ||
      approved.baseHead !== proposal.baseHead ||
      (approved.baseRefName ?? normalizeNonEmptyString(input.baseRef) ?? "HEAD") !== proposal.baseRefName ||
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
      || setupFingerprint(approved.setup) !== setupFingerprint(proposal.setup)
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
    let gitRoot = await git(sourceWorkspaceRoot, ["rev-parse", "--show-toplevel"]).catch(() => {});
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
    const existingHead = await git(sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => {});
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
    const topLevel = await git(proposal.worktreeRoot, ["rev-parse", "--show-toplevel"]).catch(() => {});
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
    const targetHead = await git(proposal.worktreeRoot, ["rev-parse", "HEAD"]).catch(() => {});
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
    const gitDirPointer = await readFile(path.join(proposal.worktreeRoot, ".git"), "utf8").catch(() => {});
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

  private async runProvisioningSetup(
    proposal: ManagedTaskWorktreeProposal,
    metadata: ManagedTaskWorktreeMetadata,
  ): Promise<ManagedTaskWorktreeMetadata> {
    const spec = proposal.setup;
    if (spec === undefined) {
      return metadata;
    }
    const fingerprint = setupFingerprint(spec);
    const previous = metadata.setup;
    if (previous?.status === "completed" && previous.fingerprint === fingerprint) {
      return metadata;
    }
    const completedStepIds = previous !== undefined && previous.fingerprint === fingerprint
      ? previous.completedStepIds.filter((id) => spec.steps.some((step) => step.id === id))
      : [];
    const startedAt = new Date().toISOString();
    let next: ManagedTaskWorktreeMetadata = {
      ...metadata,
      setup: {
        status: "running",
        fingerprint,
        attempts: (previous?.attempts ?? 0) + 1,
        approvedIgnoredFiles: [...spec.approvedIgnoredFiles],
        completedStepIds,
        startedAt,
      },
    };
    await this.writeRawMetadata(proposal.worktreeRoot, next);
    try {
      for (const relativePath of spec.approvedIgnoredFiles) {
        await this.copyApprovedIgnoredSetupFile(proposal, relativePath);
      }
      for (const step of spec.steps) {
        if (completedStepIds.includes(step.id)) {
          continue;
        }
        next = {
          ...next,
          setup: { ...next.setup!, activeStepId: step.id },
        };
        await this.writeRawMetadata(proposal.worktreeRoot, next);
        await execFileAsync(step.executable, step.args, {
          cwd: proposal.worktreeRoot,
          maxBuffer: 1024 * 1024,
        });
        completedStepIds.push(step.id);
        next = {
          ...next,
          setup: { ...next.setup!, completedStepIds: [...completedStepIds], activeStepId: undefined },
        };
        await this.writeRawMetadata(proposal.worktreeRoot, next);
      }
      next = {
        ...next,
        dirtyState: await readDirtyState(proposal.worktreeRoot),
        setup: {
          ...next.setup!,
          status: "completed",
          activeStepId: undefined,
          completedAt: new Date().toISOString(),
        },
      };
      await this.writeRawMetadata(proposal.worktreeRoot, next);
      return next;
    } catch (error) {
      const failed: ManagedTaskWorktreeMetadata = {
        ...next,
        currentLease: undefined,
        dirtyState: await readDirtyState(proposal.worktreeRoot),
        setup: {
          ...next.setup!,
          status: "failed",
          activeStepId: undefined,
          failedAt: new Date().toISOString(),
          ...(next.setup?.activeStepId !== undefined ? { failureStepId: next.setup.activeStepId } : {}),
          failureMessage: boundedSetupFailureMessage(error),
        },
      };
      await this.writeRawMetadata(proposal.worktreeRoot, failed);
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FAILED",
        "Managed worktree environment setup failed. The worktree was retained and can be retried.",
        {
          subsystem: "workspace",
          classification: "runtime",
          recoverable: true,
          worktreeRoot: proposal.worktreeRoot,
          setup: failed.setup,
        },
      );
    }
  }

  private async copyApprovedIgnoredSetupFile(
    proposal: ManagedTaskWorktreeProposal,
    relativePath: string,
  ): Promise<void> {
    const safePath = requireSafeRelativeGitPath(relativePath);
    const ignored = await gitExitCode(proposal.sourceRepoRoot, ["check-ignore", "--quiet", "--", safePath]);
    if (ignored !== 0) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FILE_NOT_IGNORED",
        `Approved setup file '${safePath}' is not ignored by Git.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, path: safePath },
      );
    }
    const tracked = await gitExitCode(proposal.worktreeRoot, ["ls-files", "--error-unmatch", "--", safePath]);
    if (tracked === 0) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FILE_TRACKED",
        `Approved setup file '${safePath}' would overwrite a tracked worktree file.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, path: safePath },
      );
    }
    const sourcePath = path.resolve(proposal.sourceRepoRoot, safePath);
    const sourceRealPath = await realpath(sourcePath).catch(() => undefined);
    if (sourceRealPath === undefined || isPathInside(proposal.sourceRepoRoot, sourceRealPath) === false) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FILE_INVALID",
        `Approved setup file '${safePath}' is missing or escapes the source repository.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, path: safePath },
      );
    }
    const sourceStat = await stat(sourceRealPath);
    if (sourceStat.isFile() === false || sourceStat.size > 64 * 1024 * 1024) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FILE_UNSUPPORTED",
        `Approved setup file '${safePath}' must be a regular file no larger than 64 MiB.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, path: safePath, size: sourceStat.size },
      );
    }
    const targetPath = path.resolve(proposal.worktreeRoot, safePath);
    await assertSourceParentInsideRepo(proposal.worktreeRoot, targetPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const targetStat = await lstat(targetPath).catch(() => undefined);
    if (targetStat?.isDirectory() === true || targetStat?.isSymbolicLink() === true) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_FILE_INVALID",
        `Approved setup file '${safePath}' has an unsafe worktree target.`,
        { subsystem: "workspace", classification: "configuration", recoverable: true, path: safePath },
      );
    }
    await copyFile(sourceRealPath, targetPath);
    await chmod(targetPath, sourceStat.mode & 0o777);
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
      baseRefName: proposal.baseRefName,
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
    const raw = await readFile(this.metadataPath(proposal), "utf8").catch(() => {});
    if (raw === undefined) {
      return ;
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
      baseRefName: proposal.baseRefName,
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
      setup: initialSetupState(proposal.setup),
      ...(proposal.setup !== undefined ? { setupSpec: proposal.setup } : {}),
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
    const raw = await readFile(locator.registryPath, "utf8").catch(() => {});
    if (raw === undefined) {
      return ;
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
    const fileStat = await lstat(worktreePath).catch(() => {});
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
      const fileStat = await lstat(worktreePath).catch(() => {});
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
    const fileStat = await lstat(worktreePath).catch(() => {});
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
    const sourceStat = await lstat(sourcePath).catch(() => {});
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
    metadata.baseHead === proposal.baseHead &&
    (metadata.baseRefName === undefined || proposal.baseRefName === undefined || metadata.baseRefName === proposal.baseRefName) &&
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
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseManagedTaskWorktreeSetupSpec(
  value: unknown,
): ManagedTaskWorktreeSetupSpec | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_SETUP_INVALID",
      "Managed worktree setup must be an object.",
      { subsystem: "workspace", classification: "configuration", recoverable: true },
    );
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.approvedIgnoredFiles) || !Array.isArray(record.steps)) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_SETUP_INVALID",
      "Managed worktree setup must provide approvedIgnoredFiles and steps arrays.",
      { subsystem: "workspace", classification: "configuration", recoverable: true },
    );
  }
  const approvedIgnoredFiles = [...new Set(record.approvedIgnoredFiles.map((entry) => {
    if (typeof entry !== "string") {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_INVALID",
        "Approved ignored setup paths must be strings.",
        { subsystem: "workspace", classification: "configuration", recoverable: true },
      );
    }
    return requireSafeRelativeGitPath(entry);
  }))];
  if (approvedIgnoredFiles.length > 64) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_SETUP_INVALID",
      "Managed worktree setup supports at most 64 approved ignored files.",
      { subsystem: "workspace", classification: "configuration", recoverable: true },
    );
  }
  if (record.steps.length > 16) {
    throw createRuntimeFailure(
      "MANAGED_WORKTREE_SETUP_INVALID",
      "Managed worktree setup supports at most 16 ordered steps.",
      { subsystem: "workspace", classification: "configuration", recoverable: true },
    );
  }
  const ids = new Set<string>();
  const steps = record.steps.map((valueStep) => {
    if (typeof valueStep !== "object" || valueStep === null || Array.isArray(valueStep)) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_INVALID",
        "Managed worktree setup steps must be objects.",
        { subsystem: "workspace", classification: "configuration", recoverable: true },
      );
    }
    const step = valueStep as Record<string, unknown>;
    const id = normalizeNonEmptyString(step.id);
    const label = normalizeNonEmptyString(step.label);
    const executable = normalizeNonEmptyString(step.executable);
    if (
      id === undefined || label === undefined || executable === undefined ||
      id.length > 80 || label.length > 160 || executable.length > 512 || executable.includes("\u0000") ||
      !Array.isArray(step.args) || step.args.length > 128 ||
      step.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\u0000")) ||
      ids.has(id)
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_SETUP_INVALID",
        "Managed worktree setup contains an invalid or duplicate step.",
        { subsystem: "workspace", classification: "configuration", recoverable: true, stepId: id },
      );
    }
    ids.add(id);
    return { id, label, executable, args: [...step.args] as string[] };
  });
  if (approvedIgnoredFiles.length === 0 && steps.length === 0) {
    return;
  }
  return { approvedIgnoredFiles, steps };
}

const normalizeManagedWorktreeSetupSpec = parseManagedTaskWorktreeSetupSpec;

function latestSessionBindingAt(
  bindings: ManagedTaskWorktreeSessionBinding[] | undefined,
): string | undefined {
  return bindings?.reduce<string | undefined>(
    (latest, binding) => latest === undefined || binding.lastBoundAt > latest ? binding.lastBoundAt : latest,
    undefined,
  );
}

function managedWorktreeRetentionState(input: {
  valid: boolean;
  hasActiveLease: boolean;
  activeProcessCount: number;
  setup: ManagedTaskWorktreeSetupState;
  dirty: boolean;
  aheadCommitCount: number;
  lastBoundAt?: string | undefined;
}): ManagedTaskWorktreeRetentionState {
  const reasons: ManagedTaskWorktreeRetentionState["reasons"] = [];
  if (input.valid === false) {
    reasons.push("binding_invalid");
  }
  if (input.hasActiveLease) {
    reasons.push("active_lease");
  }
  if (input.activeProcessCount > 0) {
    reasons.push("active_processes");
  }
  if (input.setup.status === "pending" || input.setup.status === "running" || input.setup.status === "failed") {
    reasons.push("setup_incomplete");
  }
  if (input.dirty) {
    reasons.push("uncommitted_changes");
  }
  if (input.aheadCommitCount > 0) {
    reasons.push("unpromoted_commits");
  }

  const blocked = reasons.some((reason) =>
    reason === "binding_invalid" || reason === "active_lease" || reason === "active_processes" || reason === "setup_incomplete"
  );
  const disposition = blocked
    ? "blocked"
    : reasons.length > 0
      ? "retain_with_snapshot"
      : "clean_disposable";
  if (reasons.length === 0) {
    reasons.push("clean_and_no_commits");
  }
  return {
    policy: "retain_until_explicit_cleanup",
    disposition,
    reasons,
    ...(input.lastBoundAt !== undefined ? { lastBoundAt: input.lastBoundAt } : {}),
  };
}

function setupFingerprint(spec: ManagedTaskWorktreeSetupSpec | undefined): string | undefined {
  return spec === undefined
    ? undefined
    : createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function initialSetupState(spec: ManagedTaskWorktreeSetupSpec | undefined): ManagedTaskWorktreeSetupState {
  return spec === undefined
    ? { status: "not_configured", attempts: 0, approvedIgnoredFiles: [], completedStepIds: [] }
    : {
        status: "pending",
        fingerprint: setupFingerprint(spec),
        attempts: 0,
        approvedIgnoredFiles: [...spec.approvedIgnoredFiles],
        completedStepIds: [],
      };
}

function boundedSetupFailureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; signal?: unknown };
    if (typeof record.code === "number") {
      return `Setup process exited with code ${record.code}.`;
    }
    if (typeof record.signal === "string" && record.signal.length > 0) {
      return `Setup process was terminated by signal ${record.signal}.`;
    }
    if (typeof record.code === "string" && record.code.length > 0) {
      return `Setup failed with code ${record.code}.`;
    }
  }
  return "Setup failed without exposing command output. Review the step directly in the managed workspace.";
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
    const currentStat = await lstat(current).catch(() => {});
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
  const sourceStat = await lstat(sourcePath).catch(() => {});
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
    return ;
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
  return ;
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
      return ;
    }
    const legacySessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    const createdBySessionId =
      typeof parsed.createdBySessionId === "string"
        ? parsed.createdBySessionId
        : legacySessionId;
    if (createdBySessionId === undefined) {
      return ;
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
    return ;
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
      return ;
    }
    const scope = normalizeScope(parsed.scope);
    if (scopesEqual(scope, expectedScope) === false) {
      return ;
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
    return ;
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
    ...(binding.baseRefName !== undefined ? { baseRefName: binding.baseRefName } : {}),
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

async function directoryStorageBytes(rootPath: string): Promise<{ bytes: number; truncated: boolean }> {
  const maxEntries = 250_000;
  let total = 0;
  let inspectedEntries = 0;
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > maxEntries) {
        return { bytes: total, truncated: true };
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        total += (await lstat(entryPath)).size;
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }
  }
  return { bytes: total, truncated: false };
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
  const entry = await stat(resolved).catch(() => {});
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
