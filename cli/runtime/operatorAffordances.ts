import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  formatUserFacingModeLabel,
  normalizeInteractionMode,
  resolveAllowedToolClasses,
} from "../../src/index.js";
import {
  buildOperatorWaitSummary,
  buildRuntimeOperatorAffordance,
  deriveOperatorBlockReason,
  deriveOperatorRecommendedAction,
  type OperatorAffordancePayload,
} from "../../src/orchestration/OperatorAffordanceProjection.js";
import type {
  SkillPackDefinition,
  TuiProfile,
  TuiSessionMeta,
} from "../contracts.js";

export { buildRuntimeOperatorAffordance };

export function decorateOperatorAffordance(input: {
  base?: OperatorAffordancePayload | undefined;
  runtimeAuthoritative?: boolean | undefined;
  profile: TuiProfile;
  session: TuiSessionMeta;
  skillPack?: SkillPackDefinition | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): OperatorAffordancePayload {
  const base = input.base;
  const runtimeAuthoritative = input.runtimeAuthoritative === true;
  const modeResolution = normalizeInteractionMode({
    interactionMode:
      input.session.interactionMode ?? base?.interactionMode ?? input.profile.defaultInteractionMode,
    actSubmode: input.session.actSubmode ?? base?.actSubmode ?? input.profile.defaultActSubmode,
    defaultInteractionMode: input.profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
    defaultActSubmode: input.profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
  });
  const waitFor = input.session.pendingWaitFor;
  const blockReason = runtimeAuthoritative ? base?.blockReason : deriveOperatorBlockReason(waitFor);
  const wait = runtimeAuthoritative ? base?.wait : buildOperatorWaitSummary(waitFor);
  const baseContext = base?.context;
  const context =
    baseContext !== undefined || input.session.pendingManualCompaction === true
      ? {
          promptBudgetChars: baseContext?.promptBudgetChars ?? 0,
          estimatedChars: baseContext?.estimatedChars ?? 0,
          degradationMode: baseContext?.degradationMode ?? "full",
          droppedSections: baseContext?.droppedSections ?? [],
          ...(baseContext?.compactionState !== undefined ? { compactionState: baseContext.compactionState } : {}),
          ...(baseContext?.compactionReason !== undefined ? { compactionReason: baseContext.compactionReason } : {}),
          ...(baseContext?.manualCompactionApplied === true ? { manualCompactionApplied: true } : {}),
          ...(input.session.pendingManualCompaction === true ? { manualCompactionArmed: true } : {}),
          ...(input.session.pendingManualCompaction === true &&
          baseContext?.compactionState === undefined
            ? { compactionState: "armed" as const }
            : {}),
          ...(input.session.pendingManualCompaction === true &&
          baseContext?.compactionReason === undefined
            ? { compactionReason: "Manual compaction is armed for the next model-bound turn." }
            : {}),
        }
      : undefined;
  const resolvedModel = resolveProfileModel(input.profile, input.env);
  const recommendedAction = runtimeAuthoritative
    ? base?.recommendedAction ?? deriveOperatorRecommendedAction(waitFor, blockReason, context)
    : deriveOperatorRecommendedAction(waitFor, blockReason, context);
  const allowedToolClasses =
    runtimeAuthoritative && base !== undefined
      ? base.allowedToolClasses
      : resolveAllowedToolClasses(modeResolution, input.session.executionPolicy);

  return {
    ...(base ?? {
      interactionMode: modeResolution.interactionMode,
      ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
      allowedToolClasses: [],
    }),
    interactionMode: modeResolution.interactionMode,
    ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
    allowedToolClasses,
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(recommendedAction !== undefined ? { recommendedAction } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(context !== undefined ? { context } : {}),
    provider: {
      id: input.profile.modelProvider ?? "openrouter",
      model: resolvedModel,
    },
    ...(input.skillPack !== undefined
      ? {
          activeSkillPack: {
            id: input.skillPack.id,
            label: input.skillPack.label,
            allowedTools: [...input.skillPack.allowedTools],
          },
        }
      : {}),
    ...(base?.assembly !== undefined ? { assembly: base.assembly } : {}),
    ...(input.session.delegation !== undefined
      ? {
          taskInbox: {
            total: 1,
            active:
              input.session.delegation.status === "PENDING" ||
              input.session.delegation.status === "RUNNING"
                ? 1
                : 0,
            waiting: input.session.delegation.status === "WAITING" ? 1 : 0,
            completed: input.session.delegation.status === "COMPLETED" ? 1 : 0,
            failed: input.session.delegation.status === "FAILED" ? 1 : 0,
          },
        }
      : {}),
  };
}

export function formatOperatorAffordance(payload: OperatorAffordancePayload): string[] {
  const allowedToolClasses = payload.allowedToolClasses ?? [];
  const lines = [
    `Mode: ${formatUserFacingModeLabel({
      interactionMode: payload.interactionMode,
      actSubmode: payload.actSubmode,
    })}`,
    `Allowed tool classes: ${allowedToolClasses.length > 0 ? allowedToolClasses.join(", ") : "(none)"}`,
  ];

  if (payload.provider !== undefined) {
    lines.push(`Provider: ${payload.provider.id}/${payload.provider.model}`);
  }
  if (payload.activeSkillPack !== undefined) {
    lines.push(`Skill pack: ${payload.activeSkillPack.id} (${payload.activeSkillPack.label})`);
  }
  if (payload.assembly !== undefined) {
    lines.push(
      `Assembly: ${payload.assembly.label ?? payload.assembly.bundleId ?? payload.assembly.mode} ` +
      `(thread=${payload.assembly.threadId ?? "n/a"} authority=${payload.assembly.authority ?? "n/a"} cause=${payload.assembly.cause ?? "n/a"})`,
    );
    if (payload.assembly.provider !== undefined) {
      lines.push(
        `Assembly provider: ${payload.assembly.provider.id}/${payload.assembly.provider.model}` +
        `${payload.assembly.provider.promptVariant !== undefined ? ` variant=${payload.assembly.provider.promptVariant}` : ""}` +
        `${payload.assembly.provider.compatibilityProfile !== undefined ? ` profile=${payload.assembly.provider.compatibilityProfile}` : ""}`,
      );
    }
    if (payload.assembly.compatibility !== undefined) {
      lines.push(
        `Assembly compatibility: ${payload.assembly.compatibility.status ?? "not recorded"}` +
        `${payload.assembly.compatibility.decisionSource !== undefined ? ` source=${payload.assembly.compatibility.decisionSource}` : ""}` +
        `${payload.assembly.compatibility.downgradeReason !== undefined ? ` downgrade=${JSON.stringify(payload.assembly.compatibility.downgradeReason)}` : ""}` +
        `${payload.assembly.compatibility.capabilityLossReason !== undefined ? ` capabilityLoss=${JSON.stringify(payload.assembly.compatibility.capabilityLossReason)}` : ""}`,
      );
    }
    if (payload.assembly.toolAllowlist?.length) {
      lines.push(`Assembly tools: ${payload.assembly.toolAllowlist.join(", ")}`);
    }
  }
  if (payload.inbox !== undefined) {
    lines.push(
      `Inbox: total=${payload.inbox.total} actionable=${payload.inbox.actionable} approvals=${payload.inbox.approvals} userInputs=${payload.inbox.userInputs} checkpoints=${payload.inbox.checkpoints} childBlockers=${payload.inbox.childBlockers} stalled=${payload.inbox.stalled} assemblyProposals=${payload.inbox.assemblyProposals} compatibilityAlerts=${payload.inbox.compatibilityAlerts}`,
    );
  }
  if (payload.focusedThreadId !== undefined) {
    lines.push(`Focused thread: ${payload.focusedThreadId}`);
  }
  if (payload.childBlocker !== undefined) {
    lines.push(
      `Child blocker: ${payload.childBlocker.childThreadId} via ${payload.childBlocker.delegationId} (${payload.childBlocker.status})${payload.childBlocker.reason !== undefined ? ` - ${payload.childBlocker.reason}` : ""}`,
    );
  }
  if (payload.childThreads !== undefined && payload.childThreads.length > 0) {
    const summary = summarizeChildThreads(payload.childThreads);
    lines.push(
      `Children: total=${summary.total} active=${summary.active} waiting=${summary.waiting} completed=${summary.completed} failed=${summary.failed} cancelled=${summary.cancelled}`,
    );
    const superseded = payload.childThreads
      .filter((child) => child.superseded === true)
      .map((child) => child.threadId);
    lines.push(
      `Superseded child markers: ${superseded.length > 0 ? superseded.join(", ") : "none"}`,
    );
    for (const child of payload.childThreads) {
      lines.push(
        `Child thread: ${child.threadId} status=${child.status}` +
        `${child.delegationStatus !== undefined ? ` delegation=${child.delegationStatus}` : ""}` +
        `${child.waitEventType !== undefined ? ` wait=${child.waitEventType}` : ""}` +
        `${child.outcomeSummary !== undefined ? ` outcome=${JSON.stringify(child.outcomeSummary)}` : ""}` +
        `${child.errorMessage !== undefined ? ` error=${JSON.stringify(child.errorMessage)}` : ""}`,
      );
    }
  }
  if (payload.supervision !== undefined) {
    lines.push(
      `Supervision: group=${payload.supervision.groupId} status=${payload.supervision.status} children=${payload.supervision.childCount} active=${payload.supervision.activeCount} terminal=${payload.supervision.terminalCount}`,
    );
    if (payload.supervision.nextAction !== undefined) {
      lines.push(`Supervision next action: ${payload.supervision.nextAction}`);
    }
  }
  if (payload.childBlockerChainDetails !== undefined && payload.childBlockerChainDetails.length > 0) {
    lines.push(
      `Blocker chain detail: ${payload.childBlockerChainDetails
        .map((entry) => {
          const detail = [
            entry.status.toLowerCase(),
            entry.waitEventType,
            entry.reason,
          ].filter((value): value is string => value !== undefined);
          return `${entry.threadId}${entry.delegationId !== undefined ? ` via ${entry.delegationId}` : ""}${detail.length > 0 ? ` (${detail.join(" | ")})` : ""}`;
        })
        .join(" -> ")}`,
    );
  }
  if (payload.blockerChain !== undefined && payload.blockerChain.length > 0) {
    lines.push(`Blocker chain: ${payload.blockerChain.join(" -> ")}`);
  }
  if (payload.dominantBlocker !== undefined) {
    lines.push(`Dominant blocker: ${payload.dominantBlocker}`);
  }
  if (payload.latestCheckpoint !== undefined) {
    if (
      payload.latestFanInDisposition?.status === "pending_checkpoint" &&
      payload.latestFanInDisposition.checkpointId === payload.latestCheckpoint.checkpointId
    ) {
      lines.push(
        `Fan-in checkpoint: ${payload.latestCheckpoint.recommendedAction} (${payload.latestCheckpoint.status}) - ${payload.latestCheckpoint.reason}`,
      );
    }
    lines.push(
      `Checkpoint: ${payload.latestCheckpoint.recommendedAction} (${payload.latestCheckpoint.status}) - ${payload.latestCheckpoint.reason}`,
    );
  }
  if (payload.latestCheckpointDisposition !== undefined) {
    lines.push(`Checkpoint disposition: ${payload.latestCheckpointDisposition}`);
  }
  if (payload.latestFanInDisposition !== undefined) {
    lines.push(
      `Fan-in disposition: ${payload.latestFanInDisposition.status}` +
      `${payload.latestFanInDisposition.checkpointId !== undefined ? ` checkpoint=${payload.latestFanInDisposition.checkpointId}` : ""}` +
      `${payload.latestFanInDisposition.summary !== undefined ? ` summary=${JSON.stringify(payload.latestFanInDisposition.summary)}` : ""}`,
    );
  }
  if (payload.latestSteering !== undefined) {
    lines.push(
      `Steering: ${payload.latestSteering.message} @ ${payload.latestSteering.at}`,
    );
  }
  if (payload.latestReasoning !== undefined) {
    lines.push(`Reasoning: ${payload.latestReasoning.message} @ ${payload.latestReasoning.at}`);
  }
  if (payload.runtimePlan !== undefined) {
    const plan = payload.runtimePlan;
    lines.push(
      `Runtime execution: phase=${plan.phase ?? "unknown"} status=${plan.status ?? "unknown"} chunk=${JSON.stringify(plan.currentChunk ?? "unknown")}`,
    );
    if (plan.commandBatchId !== undefined || plan.commandNames !== undefined || plan.executionMode !== undefined) {
      lines.push(
        `Command batch: ${plan.commandBatchId ?? "unknown"} mode=${plan.executionMode ?? "unknown"} commands=${plan.commandNames?.join(", ") ?? "none"}`,
      );
    }
    if (plan.waitReason !== undefined) {
      lines.push(`Wait reason: ${plan.waitReason}`);
    }
    if (plan.expectedNextCommand !== undefined) {
      lines.push(`Expected next command: ${plan.expectedNextCommand}`);
    }
    if (plan.lastCheckpoint !== undefined) {
      lines.push(
        `Checkpoint route: ${plan.lastCheckpoint.currentStepAgent ?? "unknown"} -> ${plan.lastCheckpoint.nextStepAgent ?? "terminal"} (${plan.lastCheckpoint.substate ?? "unknown"})`,
      );
    }
  }
  if (payload.latestAdaptation !== undefined) {
    lines.push(
      `Adaptation: ${payload.latestAdaptation.status} action=${payload.latestAdaptation.recommendedAction ?? "not recorded"} @ ${payload.latestAdaptation.at}`,
    );
    lines.push(`Adaptation reason: ${payload.latestAdaptation.reason}`);
  }
  if (payload.latestEvidenceRecovery !== undefined) {
    lines.push(
      `Evidence recovery: attempts=${payload.latestEvidenceRecovery.attempts} lowSignal=${payload.latestEvidenceRecovery.lowSignalAttempts} consecutiveLowSignal=${payload.latestEvidenceRecovery.consecutiveLowSignal} broadened=${payload.latestEvidenceRecovery.broadenedSearchUsed ? "yes" : "no"} targetedFetch=${payload.latestEvidenceRecovery.targetedFetchUsed ? "yes" : "no"}`,
    );
    if (payload.latestEvidenceRecovery.latestQuality !== undefined) {
      lines.push(`Evidence quality: ${payload.latestEvidenceRecovery.latestQuality}`);
    }
    if (
      payload.latestEvidenceRecovery.latestIssues !== undefined &&
      payload.latestEvidenceRecovery.latestIssues.length > 0
    ) {
      lines.push(`Evidence issues: ${payload.latestEvidenceRecovery.latestIssues.join(", ")}`);
    }
    if (payload.latestEvidenceRecovery.terminalOutcome !== undefined) {
      lines.push(`Evidence terminal outcome: ${payload.latestEvidenceRecovery.terminalOutcome}`);
    }
  }
  if (payload.nextAction !== undefined) {
    lines.push(`Next action: ${payload.nextAction}`);
  }
  if (payload.contextPosture !== undefined) {
    lines.push(`Context posture: ${payload.contextPosture}`);
  }
  if (payload.blockReason !== undefined) {
    lines.push(`Block reason: ${payload.blockReason.code} - ${payload.blockReason.summary}`);
  }
  if (payload.recommendedAction !== undefined) {
    lines.push(`Recommended next action: ${payload.recommendedAction.summary}`);
  }
  if (payload.context !== undefined) {
    const dropped =
      payload.context.droppedSections.length > 0
        ? ` dropped=${payload.context.droppedSections.join(",")}`
        : "";
    const manual = payload.context.manualCompactionArmed === true ? " manual=armed" : "";
    const applied = payload.context.manualCompactionApplied === true ? " manual=applied" : "";
    const auto =
      payload.context.compactionState !== undefined
        ? ` auto=${payload.context.compactionState}`
        : "";
    lines.push(
      `Context: ${payload.context.degradationMode} ${payload.context.estimatedChars}/${payload.context.promptBudgetChars}${dropped}${manual}${applied}${auto}`,
    );
    if (payload.context.compactionReason !== undefined) {
      lines.push(`Compaction: ${payload.context.compactionReason}`);
    }
  }
  if (payload.wait !== undefined) {
    lines.push(
      `Wait: ${payload.wait.eventType}${payload.wait.prompt !== undefined ? ` - ${payload.wait.prompt}` : ""}`,
    );
    if (payload.wait.detail !== undefined) {
      lines.push(`Wait detail: ${payload.wait.detail}`);
    }
  }
  if (payload.taskInbox !== undefined) {
    lines.push(
      `Tasks: total=${payload.taskInbox.total} active=${payload.taskInbox.active} waiting=${payload.taskInbox.waiting} completed=${payload.taskInbox.completed} failed=${payload.taskInbox.failed}`,
    );
  }

  return lines;
}

function summarizeChildThreads(
  children: NonNullable<OperatorAffordancePayload["childThreads"]>,
): {
  total: number;
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  return {
    total: children.length,
    active: children.filter((child) => child.status === "RUNNING" || child.status === "WAITING").length,
    waiting: children.filter((child) => child.status === "WAITING").length,
    completed: children.filter((child) => child.status === "COMPLETED").length,
    failed: children.filter((child) => child.status === "FAILED").length,
    cancelled: children.filter((child) => child.delegationStatus === "CANCELLED").length,
  };
}

function resolveProfileModel(profile: TuiProfile, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof profile.model === "string" && profile.model.trim().length > 0) {
    return profile.model;
  }
  if (profile.modelProvider === "openai") {
    return env.OPENAI_MODEL ?? DEFAULT_MODEL_BY_PROVIDER.openai;
  }
  if (profile.modelProvider === "anthropic") {
    return env.ANTHROPIC_MODEL ?? DEFAULT_MODEL_BY_PROVIDER.anthropic;
  }
  if (profile.modelProvider === "ollama") {
    return env.OLLAMA_MODEL ?? DEFAULT_MODEL_BY_PROVIDER.ollama;
  }
  if (profile.modelProvider === "lmstudio") {
    return env.LMSTUDIO_MODEL ?? DEFAULT_MODEL_BY_PROVIDER.lmstudio;
  }
  return env.OPENROUTER_MODEL ?? DEFAULT_MODEL_BY_PROVIDER.openrouter;
}
