import type { RunEventType, TransitionStatus } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { ManagedTaskWorktreeBinding, RuntimeDependencies, Transition } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import { asRuntimeError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import {
  readHighConfidenceApprovalDecision,
  readUserReplyIntent,
} from "../runtime/userReplyIntent.js";
import {
  deriveManagedWorktreeWorkspaceTaskKey,
  type ManagedTaskWorktreeLeaseOwnerLookup,
} from "../workspace/ManagedTaskWorktreeService.js";
import { ManagedWorktreePromotionService } from "../workspace/ManagedWorktreePromotionService.js";
import {
  isAutoProvisionedWorkspaceTool,
  WorkspaceLifecycleService,
  type WorkspaceLifecycleBoundContext,
  type WorkspaceLifecycleSessionAgentPatch,
} from "../workspace/WorkspaceLifecycleService.js";

type RunEventLevel = "INFO" | "WARN" | "ERROR";

export interface WorkspaceLifecycleCoordinatorDependencies {
  runtimeDeps: Pick<
    RuntimeDependencies,
    "managedTaskWorktreeService" | "store" | "toolGateway" | "workspaceCheckpointService"
  >;
  workspaceLifecycleService?: WorkspaceLifecycleService | undefined;
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: RunEventLevel,
    metadata: Record<string, unknown>,
    stepIndex?: number | undefined,
  ) => Promise<void>;
  classifyApprovalIntent: (
    event: RuntimeEvent,
    pendingApproval: Record<string, unknown> | undefined,
  ) => Promise<RuntimeEvent>;
}

export class WorkspaceLifecycleCoordinator {
  private readonly deps: WorkspaceLifecycleCoordinatorDependencies["runtimeDeps"];
  private readonly workspaceLifecycleService: WorkspaceLifecycleService | undefined;
  private readonly appendRunEvent: WorkspaceLifecycleCoordinatorDependencies["appendRunEvent"];
  private readonly classifyApprovalIntent: WorkspaceLifecycleCoordinatorDependencies["classifyApprovalIntent"];

  constructor(deps: WorkspaceLifecycleCoordinatorDependencies) {
    this.deps = deps.runtimeDeps;
    this.workspaceLifecycleService = deps.workspaceLifecycleService;
    this.appendRunEvent = deps.appendRunEvent;
    this.classifyApprovalIntent = deps.classifyApprovalIntent;
  }

  async prepareManagedWorktreeRunContext(
    runId: string,
    event: RuntimeEvent,
    session: SessionRecord,
  ): Promise<{ event: RuntimeEvent; session: SessionRecord }> {
    const service = this.deps.managedTaskWorktreeService;
    if (service === undefined) {
      return { event, session };
    }
    const lifecycleService = this.workspaceLifecycleService ?? new WorkspaceLifecycleService(service);

    const existingBinding = this.readManagedWorktreeBindingFromSession(session);
    if (existingBinding !== undefined) {
      const validation = await service.validateBinding(existingBinding);
      if (validation.status === "valid") {
        const rebound = await service.provision({
          sessionId: session.sessionId,
          runId,
          sourceWorkspaceRoot: existingBinding.sourceWorkspaceRoot,
          sourceRepoRoot: existingBinding.sourceRepoRoot,
          ...(existingBinding.taskId !== undefined ? { taskId: existingBinding.taskId } : {}),
          ...(existingBinding.taskKey !== undefined ? { taskKey: existingBinding.taskKey } : {}),
          ...(existingBinding.threadId !== undefined ? { threadId: existingBinding.threadId } : {}),
          triggeringTool: existingBinding.triggeringTool,
          ...(existingBinding.approvalId !== undefined ? { approvalId: existingBinding.approvalId } : {}),
        });
        const reboundBinding = rebound.binding;
        const nextAgent = applyWorkspaceLifecycleAgentPatch(
          asRecord(session.state.agent) ?? {},
          {
            exec: {
              managedWorktreeBinding: reboundBinding,
            },
          },
        );
        if (this.deps.store.patchSessionState !== undefined) {
          session = await this.deps.store.patchSessionState({
            sessionId: session.sessionId,
            expectedVersion: session.version,
            reason: "managed_worktree_lease_acquired",
            statePatch: {
              agent: nextAgent,
            },
          });
        } else {
          session = {
            ...session,
            state: {
              ...session.state,
              agent: nextAgent,
            },
          };
        }
        return {
          event: withManagedWorktreePayload(event, reboundBinding, lifecycleService.toRuntimeWorkspace(reboundBinding)),
          session,
        };
      }
      await this.appendRunEvent(runId, session.sessionId, "managed_worktree.blocked", "ERROR", toManagedWorktreeEventPayload(existingBinding, {
        reason: validation.reason,
      }));
      session = await this.clearManagedWorktreeBinding(session);
    }

    const pendingApproval = asRecord(asRecord(asRecord(session.state.agent)?.exec)?.pendingApproval);
    if (pendingApproval?.purpose !== "managed_worktree") {
      return { event, session };
    }
    event = await this.classifyApprovalIntent(event, pendingApproval);
    if (event.type !== "user.approval" || parseApprovalDecisionFromPayload(event.payload) !== "approve") {
      return { event, session };
    }
    const request = asRecord(pendingApproval.request);
    const sourceWorkspaceRoot = asString(request?.sourceWorkspaceRoot);
    const triggeringTool = asString(request?.triggeringTool);
    const approvalId = asString(pendingApproval.approvalId);
    const isolation = asManagedWorktreeIsolation(request?.isolation);
    if (sourceWorkspaceRoot === undefined || triggeringTool === undefined) {
      await this.appendRunEvent(runId, session.sessionId, "managed_worktree.blocked", "ERROR", {
        reason: "pending_approval_request_invalid",
        approvalId,
        invalidStatePath: sourceWorkspaceRoot === undefined
          ? "state.agent.exec.pendingApproval.request.sourceWorkspaceRoot"
          : "state.agent.exec.pendingApproval.request.triggeringTool",
      });
      throw createRuntimeFailure(
        "RUNTIME_RESUME_STATE_INVALID",
        "Managed worktree approval resume has an invalid pending approval request.",
        {
          sessionId: session.sessionId,
          runId,
          approvalId,
          invalidStatePath: sourceWorkspaceRoot === undefined
            ? "state.agent.exec.pendingApproval.request.sourceWorkspaceRoot"
            : "state.agent.exec.pendingApproval.request.triggeringTool",
        },
      );
    }

    let lifecycleResult: WorkspaceLifecycleBoundContext;
    try {
      lifecycleResult = await lifecycleService.provisionApprovedWorktree({
        sessionId: session.sessionId,
        runId,
        sourceWorkspaceRoot,
        ...(asString(request?.sourceRepoRoot) !== undefined ? { sourceRepoRoot: asString(request?.sourceRepoRoot) } : {}),
        ...(asString(request?.taskId) !== undefined ? { taskId: asString(request?.taskId) } : {}),
        ...(asString(request?.taskKey) !== undefined ? { taskKey: asString(request?.taskKey) } : {}),
        ...(asString(request?.threadId) !== undefined ? { threadId: asString(request?.threadId) } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        triggeringTool,
        ...(approvalId !== undefined ? { approvalId } : {}),
        leaseOwnerLookup: this.buildManagedWorktreeLeaseOwnerLookup(),
        approvedProposal: {
          sessionId: session.sessionId,
          sourceWorkspaceRoot,
          sourceRepoRoot: asString(request?.sourceRepoRoot) ?? sourceWorkspaceRoot,
          worktreeRoot: asString(request?.worktreeRoot) ?? "",
          baseHead: asString(request?.baseHead) ?? "",
          ...(asString(request?.taskId) !== undefined ? { taskId: asString(request?.taskId) } : {}),
          ...(asString(request?.taskKey) !== undefined ? { taskKey: asString(request?.taskKey) } : {}),
          ...(asString(request?.threadId) !== undefined ? { threadId: asString(request?.threadId) } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
          triggeringTool,
        },
      });
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      const blockedReason = asString(runtimeError.details?.blockedReason) ?? managedWorktreeBlockedReason(runtimeError.code);
      const activeLease = asRecord(runtimeError.details?.activeLease);
      const blockedScope = asRecord(runtimeError.details?.scope);
      await this.appendRunEvent(runId, session.sessionId, blockedReason === "active_lease" ? "managed_worktree.lease_blocked" : "managed_worktree.blocked", "ERROR", {
        reason: blockedReason,
        approvalId,
        triggeringTool,
        sourceWorkspaceRoot,
        sourceRepoRoot: asString(request?.sourceRepoRoot) ?? asString(runtimeError.details?.sourceRepoRoot),
        worktreeRoot: asString(runtimeError.details?.worktreeRoot),
        ...(blockedScope !== undefined ? { scope: blockedScope } : {}),
        message: runtimeError.message,
        ...(activeLease !== undefined ? { activeLease } : {}),
      });
      throw error;
    }
    const binding = lifecycleResult.binding;
    const nextReact = applyWorkspaceLifecycleAgentPatch(
      asRecord(session.state.agent) ?? {},
      lifecycleResult.sessionAgentPatch,
    );
    const patched =
      this.deps.store.patchSessionState === undefined
        ? {
            ...session,
            state: {
              ...session.state,
              agent: nextReact,
            },
          }
        : await this.deps.store.patchSessionState({
            sessionId: session.sessionId,
            expectedVersion: session.version,
            reason: "managed_worktree_bound",
            statePatch: {
              agent: nextReact,
            },
          });

    await this.appendRunEvent(
      runId,
      session.sessionId,
      lifecycleResult.eventKind === "created" ? "managed_worktree.created" : "managed_worktree.reused",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
    );
    await this.appendManagedWorktreeRecoveryEvents(
      runId,
      session.sessionId,
      binding,
      lifecycleResult.eventPayloadMetadata,
    );
    await this.appendRunEvent(
      runId,
      session.sessionId,
      "managed_worktree.bound",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
    );
    await this.appendRunEvent(
      runId,
      session.sessionId,
      "managed_worktree.leased",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
    );

    return {
      event: withManagedWorktreePayload(event, binding, lifecycleResult.runtimeWorkspace),
      session: patched,
    };
  }

  async prepareAutoManagedWorktreeForSelectedDevTool(input: {
    runId: string;
    event: RuntimeEvent;
    session: SessionRecord;
    stepName: string;
    stepIndex: number;
  }): Promise<{ event: RuntimeEvent; session: SessionRecord }> {
    if (input.stepName !== "agent.exec.dispatch" && input.stepName !== "react.exec.dispatch") {
      return { event: input.event, session: input.session };
    }

    const toolName = readAutoProvisionDevToolNameFromState(input.session.state);
    if (toolName === undefined) {
      return { event: input.event, session: input.session };
    }

    const service = this.deps.managedTaskWorktreeService;
    const lifecycleService = this.workspaceLifecycleService;
    const existingBinding = this.readManagedWorktreeBindingFromSession(input.session);
    if (existingBinding !== undefined) {
      if (service === undefined || lifecycleService === undefined) {
        throwManagedWorktreeProviderRequired(input.stepName, toolName);
      }
      const validation = await service.validateBinding(existingBinding);
      if (validation.status !== "valid") {
        await this.appendRunEvent(input.runId, input.session.sessionId, "managed_worktree.blocked", "ERROR", toManagedWorktreeEventPayload(existingBinding, {
          reason: validation.reason,
        }), input.stepIndex);
        input.session = await this.clearManagedWorktreeBinding(input.session);
      } else {
        return {
          event: withManagedWorktreePayload(
            input.event,
            existingBinding,
            lifecycleService.toRuntimeWorkspace(existingBinding),
          ),
          session: input.session,
        };
      }
    }

    const workspace = asRecord(input.event.payload.workspace);
    const managedWorktreeRequired = workspace?.managedWorktreeRequired === true;
    if (managedWorktreeRequired === false) {
      return {
        event: input.event,
        session: input.session,
      };
    }

    const sourceWorkspaceRoot = asString(workspace?.sourceWorkspaceRoot) ?? asString(workspace?.workspaceRoot);
    if (sourceWorkspaceRoot === undefined) {
      return { event: input.event, session: input.session };
    }
    if (lifecycleService === undefined) {
      throwManagedWorktreeProviderRequired(input.stepName, toolName);
    }

    const agent = asRecord(input.session.state.agent) ?? {};
    const sourceRepoRoot = asString(workspace?.sourceRepoRoot) ?? asString(workspace?.repoRoot);
    const isolation = asManagedWorktreeIsolation(workspace?.managedWorktreeIsolation);
    const taskId =
      asString(asRecord(input.event.payload.orchestration)?.taskId) ??
      asString(asRecord(input.event.payload.metadata)?.taskId);
    const taskKey =
      isolation === "session"
        ? undefined
        : asString(asRecord(input.event.payload.orchestration)?.taskKey) ??
          asString(asRecord(input.event.payload.metadata)?.taskKey) ??
          deriveManagedWorktreeWorkspaceTaskKey(workspace);
    const threadId = asString(asRecord(input.event.payload.orchestration)?.threadId);

    await this.appendRunEvent(input.runId, input.session.sessionId, "managed_worktree.auto_requested", "INFO", {
      triggeringTool: toolName,
      sourceWorkspaceRoot,
      ...(sourceRepoRoot !== undefined ? { sourceRepoRoot } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskKey !== undefined ? { taskKey } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    }, input.stepIndex);

    let lifecycleResult: WorkspaceLifecycleBoundContext | undefined;
    try {
      lifecycleResult = await lifecycleService.provisionAutoDevTool({
        sessionId: input.session.sessionId,
        runId: input.runId,
        sourceWorkspaceRoot,
        ...(sourceRepoRoot !== undefined ? { sourceRepoRoot } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(taskKey !== undefined ? { taskKey } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        triggeringTool: toolName,
        toolName,
        leaseOwnerLookup: this.buildManagedWorktreeLeaseOwnerLookup(),
      });
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      const blockedReason = asString(runtimeError.details?.blockedReason) ?? managedWorktreeBlockedReason(runtimeError.code);
      const activeLease = asRecord(runtimeError.details?.activeLease);
      const blockedScope = asRecord(runtimeError.details?.scope);
      await this.appendRunEvent(input.runId, input.session.sessionId, blockedReason === "active_lease" ? "managed_worktree.lease_blocked" : "managed_worktree.blocked", "ERROR", {
        reason: blockedReason,
        triggeringTool: toolName,
        sourceWorkspaceRoot,
        ...((sourceRepoRoot ?? asString(runtimeError.details?.sourceRepoRoot)) !== undefined
          ? { sourceRepoRoot: sourceRepoRoot ?? asString(runtimeError.details?.sourceRepoRoot) }
          : {}),
        worktreeRoot: asString(runtimeError.details?.worktreeRoot),
        ...(blockedScope !== undefined ? { scope: blockedScope } : {}),
        message: runtimeError.message,
        ...(activeLease !== undefined ? { activeLease } : {}),
      }, input.stepIndex);
      throw error;
    }
    if (lifecycleResult === undefined) {
      return { event: input.event, session: input.session };
    }

    const binding = lifecycleResult.binding;
    const nextAgent = applyWorkspaceLifecycleAgentPatch(agent, lifecycleResult.sessionAgentPatch);
    const patched =
      this.deps.store.patchSessionState === undefined
        ? {
            ...input.session,
            state: {
              ...input.session.state,
              agent: nextAgent,
            },
          }
        : await this.deps.store.patchSessionState({
            sessionId: input.session.sessionId,
            expectedVersion: input.session.version,
            reason: "managed_worktree_auto_bound",
            statePatch: {
              agent: nextAgent,
            },
          });
    const event = withManagedWorktreePayload(input.event, binding, lifecycleResult.runtimeWorkspace);
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      lifecycleResult.eventKind === "created" ? "managed_worktree.created" : "managed_worktree.reused",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
      input.stepIndex,
    );
    await this.appendManagedWorktreeRecoveryEvents(
      input.runId,
      input.session.sessionId,
      binding,
      lifecycleResult.eventPayloadMetadata,
      input.stepIndex,
    );
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "managed_worktree.bound",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
      input.stepIndex,
    );
    await this.appendRunEvent(
      input.runId,
      input.session.sessionId,
      "managed_worktree.leased",
      "INFO",
      toManagedWorktreeEventPayload(binding, lifecycleResult.eventPayloadMetadata),
      input.stepIndex,
    );

    if (this.deps.toolGateway.preRun !== undefined) {
      await this.deps.toolGateway.preRun({
        runId: input.runId,
        event,
        session: patched,
      });
    }

    return { event, session: patched };
  }

  async releaseManagedWorktreeLeaseForRun(
    runId: string,
    session: SessionRecord,
    terminalStatus: TransitionStatus = "FAILED",
  ): Promise<void> {
    const service = this.deps.managedTaskWorktreeService;
    if (service === undefined) {
      return;
    }
    const binding = this.readManagedWorktreeBindingFromSession(session);
    if (binding === undefined) {
      return;
    }
    if (this.deps.workspaceCheckpointService !== undefined) {
      try {
        const finalOutput = asRecord(asRecord(session.state.agent)?.finalOutput);
        const promotionService = new ManagedWorktreePromotionService({
          managedWorktreeService: service,
          checkpointService: this.deps.workspaceCheckpointService,
        });
        const result = await promotionService.finalizeTerminalRun({
          sessionId: session.sessionId,
          runId,
          terminalStatus,
          finalOutput,
          binding,
          appliedBy: "runtime",
        });
        if (result.candidate !== undefined && result.candidate.changedFiles.length > 0) {
          await this.appendRunEvent(
            runId,
            session.sessionId,
            "managed_worktree.promotion_candidate",
            result.candidate.status === "ready" ? "INFO" : "WARN",
            {
              ...toManagedWorktreeEventPayload(binding),
              promotionId: result.promotion.promotionId,
              promotionStatus: result.promotion.status,
              changedFiles: result.candidate.changedFiles,
              candidateFingerprint: result.candidate.candidateFingerprint,
              currentSourceHead: result.candidate.currentSourceHead,
              ...(result.candidate.applyBlockedReason !== undefined ? { promotionBlockedReason: result.candidate.applyBlockedReason } : {}),
              ...(result.candidate.conflictPaths !== undefined ? { conflictPaths: result.candidate.conflictPaths } : {}),
              ...(result.candidate.invalidPaths !== undefined ? { invalidPaths: result.candidate.invalidPaths } : {}),
            },
          );
        }
        await this.appendRunEvent(
          runId,
          session.sessionId,
          managedPromotionEventType(result.promotion.status),
          result.promotion.status === "blocked" || result.promotion.status === "failed" ? "WARN" : "INFO",
          {
            ...toManagedWorktreeEventPayload(binding),
            promotionId: result.promotion.promotionId,
            promotionStatus: result.promotion.status,
            changedFiles: result.promotion.changedFiles,
            conflictPaths: result.promotion.conflictPaths,
            invalidPaths: result.promotion.invalidPaths,
            candidateFingerprint: result.promotion.candidateFingerprint,
            sourcePreCheckpointId: result.promotion.sourcePreCheckpointId,
            sourcePostCheckpointId: result.promotion.sourcePostCheckpointId,
            promotionBlockedReason: result.promotion.blockedReason,
          },
        );
        if (result.promotion.status === "promoted" || result.promotion.status === "noop" || result.promotion.status === "skipped") {
          await this.appendRunEvent(runId, session.sessionId, "managed_worktree.released", "INFO", {
            reason: "run_terminal",
            promotionId: result.promotion.promotionId,
            promotionStatus: result.promotion.status,
            ...toManagedWorktreeEventPayload(binding),
          });
        }
        return;
      } catch (error) {
        await this.appendRunEvent(runId, session.sessionId, "managed_worktree.promotion_blocked", "ERROR", {
          ...toManagedWorktreeEventPayload(binding),
          promotionStatus: "blocked",
          promotionBlockedReason: "promotion_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    await this.maybeAppendManagedWorktreeFanInCandidate(runId, session.sessionId, binding);
    await service.releaseLease(binding, { runId });
    await this.appendRunEvent(runId, session.sessionId, "managed_worktree.released", "INFO", {
      reason: "run_terminal",
      ...toManagedWorktreeEventPayload(binding),
    });
  }

  async maybeAppendManagedWorktreeApprovalRequested(
    runId: string,
    sessionId: string,
    transition: Transition,
    stepIndex: number,
  ): Promise<void> {
    const metadata = asRecord(transition.waitFor?.metadata);
    if (transition.status !== "WAITING" || metadata?.purpose !== "managed_worktree") {
      return;
    }
    const request = asRecord(metadata.request);
    await this.appendRunEvent(runId, sessionId, "managed_worktree.approval_requested", "INFO", {
      approvalId: asString(metadata.approvalId),
      triggeringTool: asString(metadata.toolName),
      sourceWorkspaceRoot: asString(request?.sourceWorkspaceRoot),
      sourceRepoRoot: asString(request?.sourceRepoRoot),
      worktreeRoot: asString(request?.worktreeRoot),
      baseHead: asString(request?.baseHead),
      taskId: asString(request?.taskId),
      taskKey: asString(request?.taskKey),
      threadId: asString(request?.threadId),
    }, stepIndex);
  }

  readManagedWorktreeBindingFromSession(session: SessionRecord): ManagedTaskWorktreeBinding | undefined {
    return this.readManagedWorktreeBindingFromState(session.state);
  }

  readManagedWorktreeBindingFromState(state: Record<string, unknown>): ManagedTaskWorktreeBinding | undefined {
    const binding = asRecord(asRecord(asRecord(state.agent)?.exec)?.managedWorktreeBinding);
    if (binding?.status !== "bound") {
      return ;
    }
    const sessionId = asString(binding.sessionId);
    const sourceWorkspaceRoot = asString(binding.sourceWorkspaceRoot);
    const sourceRepoRoot = asString(binding.sourceRepoRoot);
    const worktreeRoot = asString(binding.worktreeRoot);
    const baseHead = asString(binding.baseHead);
    const lastObservedSourceHead = asString(binding.lastObservedSourceHead) ?? baseHead;
    const triggeringTool = asString(binding.triggeringTool) ?? "unknown";
    const boundAt = asString(binding.boundAt) ?? new Date(0).toISOString();
    const taskId = asString(binding.taskId);
    const taskKey = asString(binding.taskKey);
    const threadId = asString(binding.threadId);
    const isolation = asManagedWorktreeIsolation(binding.isolation);
    const scopeRecord = asRecord(binding.scope);
    const scopeKind = asString(scopeRecord?.kind);
    const scopeValue = asString(scopeRecord?.value);
    const scope =
      (scopeKind === "taskId" || scopeKind === "taskKey" || scopeKind === "threadId" || scopeKind === "sessionId") &&
      scopeValue !== undefined
        ? { kind: scopeKind as "taskId" | "taskKey" | "threadId" | "sessionId", value: scopeValue }
        : taskId !== undefined
          ? { kind: "taskId" as const, value: taskId }
          : taskKey !== undefined
            ? { kind: "taskKey" as const, value: taskKey }
            : threadId !== undefined
              ? { kind: "threadId" as const, value: threadId }
              : sessionId !== undefined
                ? { kind: "sessionId" as const, value: sessionId }
                : undefined;
    if (
      sourceWorkspaceRoot === undefined ||
      sessionId === undefined ||
      sourceRepoRoot === undefined ||
      worktreeRoot === undefined ||
      baseHead === undefined ||
      lastObservedSourceHead === undefined ||
      scope === undefined
    ) {
      return ;
    }
    return {
      status: "bound",
      sessionId,
      ...(asString(binding.runId) !== undefined ? { runId: asString(binding.runId) } : {}),
      sourceWorkspaceRoot,
      sourceRepoRoot,
      worktreeRoot,
      baseHead,
      lastObservedSourceHead,
      scope,
      leaseId: asString(binding.leaseId) ?? "legacy-lease",
      leaseKind: asString(binding.leaseKind) === "process" ? "process" : "run",
      createdBySessionId: asString(binding.createdBySessionId) ?? sessionId,
      dirtyState: {
        dirty: asRecord(binding.dirtyState)?.dirty === true,
        porcelain: asString(asRecord(binding.dirtyState)?.porcelain) ?? "",
        checkedAt: asString(asRecord(binding.dirtyState)?.checkedAt) ?? new Date(0).toISOString(),
      },
      triggeringTool,
      boundAt,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskKey !== undefined ? { taskKey } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
      ...(asString(binding.approvalId) !== undefined ? { approvalId: asString(binding.approvalId) } : {}),
    };
  }

  toManagedWorktreeEventPayload(
    binding: ManagedTaskWorktreeBinding,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return toManagedWorktreeEventPayload(binding, extra);
  }

  private async clearManagedWorktreeBinding(session: SessionRecord): Promise<SessionRecord> {
    const react = asRecord(session.state.agent) ?? {};
    const exec = asRecord(react.exec) ?? {};
    const nextReact = {
      ...react,
      exec: {
        ...exec,
        managedWorktreeBinding: undefined,
      },
    };
    if (this.deps.store.patchSessionState === undefined) {
      return {
        ...session,
        state: {
          ...session.state,
          agent: nextReact,
        },
      };
    }
    return this.deps.store.patchSessionState({
      sessionId: session.sessionId,
      expectedVersion: session.version,
      reason: "managed_worktree_binding_invalid",
      statePatch: {
        agent: nextReact,
      },
    });
  }

  private async appendManagedWorktreeRecoveryEvents(
    runId: string,
    sessionId: string,
    binding: ManagedTaskWorktreeBinding,
    eventPayloadMetadata: Record<string, unknown>,
    stepIndex?: number,
  ): Promise<void> {
    if (eventPayloadMetadata.recoveredOrphan === true) {
      const payload = toManagedWorktreeEventPayload(binding, eventPayloadMetadata);
      await this.appendRunEvent(runId, sessionId, "managed_worktree.orphan_detected", "WARN", payload, stepIndex);
      await this.appendRunEvent(runId, sessionId, "managed_worktree.orphan_reclaimed", "INFO", payload, stepIndex);
    }
    const rotatedFromWorktreeRoot = asString(eventPayloadMetadata.rotatedFromWorktreeRoot);
    if (rotatedFromWorktreeRoot !== undefined) {
      await this.appendRunEvent(
        runId,
        sessionId,
        "managed_worktree.rotated",
        "INFO",
        toManagedWorktreeEventPayload(binding, {
          ...eventPayloadMetadata,
          previousWorktreeRoot: rotatedFromWorktreeRoot,
        }),
        stepIndex,
      );
    }
  }

  private async maybeAppendManagedWorktreeFanInCandidate(
    runId: string,
    sessionId: string,
    binding: ManagedTaskWorktreeBinding,
  ): Promise<void> {
    const service = this.deps.managedTaskWorktreeService;
    if (service === undefined) {
      return;
    }
    try {
      const candidate = await service.inspectFanInCandidate(binding);
      if (candidate.changedFiles.length === 0) {
        return;
      }
      await this.appendRunEvent(
        runId,
        sessionId,
        "managed_worktree.fan_in_candidate",
        candidate.status === "ready" ? "INFO" : "WARN",
        {
          ...toManagedWorktreeEventPayload(binding),
          applyStatus: candidate.status,
          changedFiles: candidate.changedFiles,
          candidateFingerprint: candidate.candidateFingerprint,
          currentSourceHead: candidate.currentSourceHead,
          ...(candidate.applyBlockedReason !== undefined ? { applyBlockedReason: candidate.applyBlockedReason } : {}),
          ...(candidate.conflictPaths !== undefined ? { conflictPaths: candidate.conflictPaths } : {}),
          ...(candidate.invalidPaths !== undefined ? { invalidPaths: candidate.invalidPaths } : {}),
        },
      );
    } catch (error) {
      await this.appendRunEvent(runId, sessionId, "managed_worktree.fan_in_candidate", "ERROR", {
        ...toManagedWorktreeEventPayload(binding),
        applyStatus: "blocked",
        applyBlockedReason: "inspection_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildManagedWorktreeLeaseOwnerLookup(): ManagedTaskWorktreeLeaseOwnerLookup {
    return {
      isLeaseActive: async (lease) => {
        if (lease.kind !== "run") {
          return false;
        }
        const run = await this.deps.store.getRun(lease.runId);
        return run?.status === "RUNNING" && run.sessionId === lease.sessionId;
      },
    };
  }
}

function readAutoProvisionDevToolNameFromState(state: Record<string, unknown>): string | undefined {
  const nextAction = asRecord(asRecord(state.agent)?.nextAction);
  if (nextAction?.kind === "tool") {
    const toolName = asString(nextAction.name);
    return toolName !== undefined && isAutoProvisionedWorkspaceTool(toolName) ? toolName : undefined;
  }
  if (nextAction?.kind === "tool_batch" && Array.isArray(nextAction.items)) {
    for (const item of nextAction.items) {
      const toolName = asString(asRecord(item)?.name);
      if (toolName !== undefined && isAutoProvisionedWorkspaceTool(toolName)) {
        return toolName;
      }
    }
  }
  return ;
}

function applyWorkspaceLifecycleAgentPatch(
  agent: Record<string, unknown>,
  patch: WorkspaceLifecycleSessionAgentPatch,
): Record<string, unknown> {
  return {
    ...agent,
    exec: {
      ...asRecord(agent.exec),
      ...patch.exec,
    },
  };
}

function withManagedWorktreePayload(
  event: RuntimeEvent,
  binding: ManagedTaskWorktreeBinding,
  runtimeWorkspace: Record<string, unknown>,
): RuntimeEvent {
  const payload = asRecord(event.payload) ?? {};
  const workspace = asRecord(payload.workspace) ?? {};
  const orchestration = asRecord(payload.orchestration) ?? {};
  return {
    ...event,
    payload: {
      ...payload,
      workspace: {
        ...workspace,
        ...runtimeWorkspace,
      },
      orchestration: {
        ...orchestration,
        managedWorktree: true,
        sessionId: binding.sessionId,
        runId: binding.runId,
        sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
        sourceRepoRoot: binding.sourceRepoRoot,
        worktreeRoot: binding.worktreeRoot,
        baseHead: binding.baseHead,
        lastObservedSourceHead: binding.lastObservedSourceHead,
        scope: binding.scope,
        leaseId: binding.leaseId,
        leaseKind: binding.leaseKind,
        createdBySessionId: binding.createdBySessionId,
        dirtyState: binding.dirtyState,
        ...(binding.taskId !== undefined ? { taskId: binding.taskId } : {}),
        ...(binding.taskKey !== undefined ? { taskKey: binding.taskKey } : {}),
        ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
      },
    },
  };
}

function toManagedWorktreeEventPayload(
  binding: ManagedTaskWorktreeBinding,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
    sourceRepoRoot: binding.sourceRepoRoot,
    worktreeRoot: binding.worktreeRoot,
    baseHead: binding.baseHead,
    lastObservedSourceHead: binding.lastObservedSourceHead,
    scope: binding.scope,
    leaseId: binding.leaseId,
    leaseKind: binding.leaseKind,
    createdBySessionId: binding.createdBySessionId,
    dirtyState: binding.dirtyState,
    sessionId: binding.sessionId,
    runId: binding.runId,
    taskId: binding.taskId,
    taskKey: binding.taskKey,
    threadId: binding.threadId,
    isolation: binding.isolation,
    approvalId: binding.approvalId,
    ...extra,
  };
}

function throwManagedWorktreeProviderRequired(step: string, toolName: string): never {
  throw createRuntimeFailure(
    "MANAGED_WORKTREE_PROPOSAL_PROVIDER_REQUIRED",
    "Managed Kestrel worktree provisioning is required before mutation-capable tools can run.",
    {
      subsystem: "workspace",
      step,
      classification: "runtime",
      recoverable: true,
      toolName,
    },
  );
}

function managedWorktreeBlockedReason(code: string): string {
  if (code === "MANAGED_WORKTREE_ACTIVE_LEASE") {
    return "active_lease";
  }
  if (code === "MANAGED_WORKTREE_SOURCE_DIRTY") {
    return "source_dirty";
  }
  if (code === "MANAGED_WORKTREE_SOURCE_UNAVAILABLE") {
    return "source_unavailable";
  }
  return "provision_failed";
}

function managedPromotionEventType(status: "promoted" | "noop" | "blocked" | "pending_review" | "skipped" | "failed"): RunEventType {
  if (status === "promoted") {
    return "managed_worktree.promoted";
  }
  if (status === "noop" || status === "skipped") {
    return "managed_worktree.promotion_skipped";
  }
  return "managed_worktree.promotion_blocked";
}

function parseApprovalDecisionFromPayload(payload: unknown): "approve" | "deny" | undefined {
  return readHighConfidenceApprovalDecision(readUserReplyIntent(asRecord(payload)?.userReplyIntent));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asManagedWorktreeIsolation(value: unknown): "scoped" | "session" | undefined {
  return value === "scoped" || value === "session" ? value : undefined;
}
