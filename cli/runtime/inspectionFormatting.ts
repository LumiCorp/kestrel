import type { ReplayDoctorReport, ReplayResult } from "../../src/replay/RunReplayService.js";

export function formatReplayInspection(replay: ReplayResult): string[] {
  const lines: string[] = [];
  const focus = [
    replay.lineage.focusThread?.threadId !== undefined
      ? `thread=${replay.lineage.focusThread.threadId}`
      : undefined,
    replay.lineage.focusDelegation?.delegationId !== undefined
      ? `delegation=${replay.lineage.focusDelegation.delegationId}`
      : undefined,
    replay.summary.runId !== undefined ? `run=${replay.summary.runId}` : undefined,
    replay.summary.sessionId !== undefined ? `session=${replay.summary.sessionId}` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (focus.length > 0) {
    lines.push(focus.join(" "));
  }
  if (replay.waits.active !== undefined) {
    lines.push(
      `activeWait kind=${replay.waits.active.kind} requestId=${replay.waits.active.requestId ?? "n/a"} grantId=${replay.waits.active.grantId ?? "n/a"}${replay.waits.active.detail !== undefined ? ` detail=${JSON.stringify(replay.waits.active.detail)}` : ""}`,
    );
  }
  const lineageChildren = Array.isArray(replay.lineage.childThreads) ? replay.lineage.childThreads : [];
  if (lineageChildren.length > 0) {
    const activeChildren = lineageChildren.filter(
      (child) => child.status === "RUNNING" || child.status === "WAITING",
    ).length;
    const waitingChildren = lineageChildren.filter((child) => child.status === "WAITING").length;
    const completedChildren = lineageChildren.filter((child) => child.status === "COMPLETED").length;
    const failedChildren = lineageChildren.filter((child) => child.status === "FAILED").length;
    const supersededChildren = replay.delegations
      .filter((entry) => entry.delegation.status === "CANCELLED")
      .map((entry) => entry.delegation.childThreadId);
    lines.push(
      `children total=${lineageChildren.length} active=${activeChildren} waiting=${waitingChildren} completed=${completedChildren} failed=${failedChildren} superseded=${supersededChildren.length}`,
    );
    if (supersededChildren.length > 0) {
      lines.push(`supersededChildren ${supersededChildren.join(",")}`);
    }
    const delegationByChild = new Map(replay.delegations.map((entry) => [entry.delegation.childThreadId, entry.delegation]));
    for (const child of lineageChildren) {
      const delegation = delegationByChild.get(child.threadId);
      lines.push(
        `child thread=${child.threadId} status=${child.status}` +
        `${child.waitFor?.eventType !== undefined ? ` wait=${child.waitFor.eventType}` : ""}` +
        `${delegation?.status !== undefined ? ` delegation=${delegation.status}` : ""}` +
        `${delegation?.resultSummary !== undefined ? ` outcome=${JSON.stringify(delegation.resultSummary)}` : ""}` +
        `${delegation?.errorMessage !== undefined ? ` error=${JSON.stringify(delegation.errorMessage)}` : ""}`,
      );
    }
  }
  if ((replay.supervision?.groups?.length ?? 0) > 0) {
    for (const group of replay.supervision.groups) {
      lines.push(
        `supervision group=${group.groupId} children=${group.childOutcomes.length} fanInDecisions=${group.fanInDecisions.length}` +
        `${group.dominantBlocker !== undefined ? ` dominantBlocker=${group.dominantBlocker.childThreadId}` : ""}`,
      );
      for (const outcome of group.childOutcomes) {
        const outcomeState = (outcome as { state?: string; resultState?: string }).state ??
          (outcome as { state?: string; resultState?: string }).resultState ??
          "unknown";
        lines.push(
          `supervisionChild group=${group.groupId} delegationId=${outcome.delegationId} childThread=${outcome.childThreadId} result=${outcomeState}` +
          `${outcome.summary !== undefined ? ` summary=${JSON.stringify(outcome.summary)}` : ""}` +
          `${outcome.reason !== undefined ? ` reason=${JSON.stringify(outcome.reason)}` : ""}`,
        );
      }
      for (const decision of group.fanInDecisions) {
        lines.push(
          `fanIn group=${group.groupId} decision=${decision.decision} at=${decision.at}` +
          `${decision.delegationId !== undefined ? ` delegationId=${decision.delegationId}` : ""}` +
          `${decision.childThreadId !== undefined ? ` childThreadId=${decision.childThreadId}` : ""}` +
          `${decision.reason !== undefined ? ` reason=${JSON.stringify(decision.reason)}` : ""}`,
        );
      }
    }
  }
  if (replay.assembly.active !== undefined) {
    lines.push(
      `assembly bundle=${replay.assembly.active.record.bundleId} label=${JSON.stringify(replay.assembly.active.bundle?.label ?? "not recorded")} authority=${replay.assembly.active.record.authority} cause=${replay.assembly.active.record.cause}`,
    );
  } else if (replay.assembly.mode === "implicit_legacy") {
    lines.push("assembly bundle=implicit/legacy label=\"not recorded\" authority=n/a cause=n/a");
  }
  if (replay.assembly.decisions.length > 0) {
    const latestDecision = replay.assembly.decisions[0];
    lines.push(
      `assemblyDecision proposalId=${latestDecision?.proposalId ?? "n/a"} result=${latestDecision?.result ?? "n/a"} decidedBy=${latestDecision?.decidedBy ?? "n/a"}`,
    );
  }
  if (replay.compatibility !== undefined) {
    lines.push(
      `compatibility provider=${replay.compatibility.provider ?? "n/a"} model=${replay.compatibility.model ?? "n/a"}${replay.compatibility.promptVariant !== undefined ? ` variant=${JSON.stringify(replay.compatibility.promptVariant)}` : ""}${replay.compatibility.profile !== undefined ? ` profile=${JSON.stringify(replay.compatibility.profile)}` : ""} status=${replay.compatibility.status ?? "not_recorded"} source=${replay.compatibility.decisionSource ?? "n/a"}${replay.compatibility.downgradeReason !== undefined ? ` downgrade=${JSON.stringify(replay.compatibility.downgradeReason)}` : ""}${replay.compatibility.capabilityLossReason !== undefined ? ` capabilityLoss=${JSON.stringify(replay.compatibility.capabilityLossReason)}` : ""}`,
    );
  }
  if (replay.adaptation !== undefined) {
    lines.push(
      `adaptation status=${replay.adaptation.status} action=${replay.adaptation.recommendedAction ?? "not_recorded"} reason=${JSON.stringify(replay.adaptation.reason)} at=${replay.adaptation.at}${replay.adaptation.checkpointId !== undefined ? ` checkpointId=${replay.adaptation.checkpointId}` : ""}${replay.adaptation.eventId !== undefined ? ` eventId=${replay.adaptation.eventId}` : ""}${replay.adaptation.summaryArtifactId !== undefined ? ` summaryArtifactId=${replay.adaptation.summaryArtifactId}` : ""}`,
    );
  }
  if (replay.evidenceRecovery !== undefined) {
    lines.push(
      `evidenceRecovery attempts=${replay.evidenceRecovery.attempts} lowSignal=${replay.evidenceRecovery.lowSignalAttempts} consecutiveLowSignal=${replay.evidenceRecovery.consecutiveLowSignal} broadened=${replay.evidenceRecovery.broadenedSearchUsed ? "yes" : "no"} targetedFetch=${replay.evidenceRecovery.targetedFetchUsed ? "yes" : "no"}${replay.evidenceRecovery.latestQuality !== undefined ? ` quality=${JSON.stringify(replay.evidenceRecovery.latestQuality)}` : ""}${replay.evidenceRecovery.latestIssues !== undefined && replay.evidenceRecovery.latestIssues.length > 0 ? ` issues=${JSON.stringify(replay.evidenceRecovery.latestIssues)}` : ""}${replay.evidenceRecovery.terminalOutcome !== undefined ? ` terminal=${JSON.stringify(replay.evidenceRecovery.terminalOutcome)}` : ""}`,
    );
  }
  if (replay.runtimePlan !== undefined) {
    lines.push(formatRuntimePlan("runtimeExecution", replay.runtimePlan));
    if (replay.runtimePlan.latestNarration !== undefined) {
      lines.push(formatRuntimeNarration("runtimeNarration", replay.runtimePlan.latestNarration));
    }
  }
  for (const approval of replay.approvals) {
    lines.push(
      `approval requestId=${approval.request.requestId} status=${approval.status} actionable=${approval.actionable ? "yes" : "no"} latestGrant=${approval.latestGrant?.grantId ?? "n/a"}`,
    );
  }
  for (const delegation of replay.delegations) {
    lines.push(
      `delegation id=${delegation.delegation.delegationId} status=${delegation.delegation.status} childThread=${delegation.childThread?.threadId ?? "n/a"} milestones=${delegation.milestones.length}`,
    );
  }
  if (replay.compaction.authoritativeSummary !== undefined || replay.compaction.latestEvent !== undefined) {
    lines.push(
      `contextCompaction summary=${replay.compaction.authoritativeSummary?.artifactId ?? "n/a"} action=${replay.compaction.latestEvent?.action ?? "n/a"} events=${replay.compaction.events.length}`,
    );
  }
  for (const entry of replay.groups) {
    lines.push(
      `${entry.seq}. ${entry.at} [${entry.kind}] ${entry.label}${entry.detail !== undefined ? ` :: ${entry.detail}` : ""}`,
    );
  }
  return lines;
}

export function formatDoctorInspection(report: ReplayDoctorReport): string[] {
  const lines: string[] = [];

  lines.push(`status=${report.status}${report.finalStep !== undefined ? ` finalStep=${report.finalStep}` : ""}`);
  if (report.focus.threadId !== undefined || report.focus.delegationId !== undefined) {
    lines.push(
      [
        report.focus.threadId !== undefined ? `thread=${report.focus.threadId}` : undefined,
        report.focus.delegationId !== undefined ? `delegation=${report.focus.delegationId}` : undefined,
        report.focus.runId !== undefined ? `run=${report.focus.runId}` : undefined,
        report.focus.sessionId !== undefined ? `session=${report.focus.sessionId}` : undefined,
      ].filter((value): value is string => value !== undefined).join(" "),
    );
  }
  lines.push(`actionable=${report.actionable ? "yes" : "no"}`);
  if (report.terminalReasonCode !== undefined) {
    lines.push(`terminalReason=${report.terminalReasonCode}`);
  }
  if (report.blockingResource !== undefined) {
    lines.push(
      `blocking kind=${report.blockingResource.kind} requestId=${report.blockingResource.requestId ?? "n/a"} grantId=${report.blockingResource.grantId ?? "n/a"} delegationId=${report.blockingResource.delegationId ?? "n/a"}${report.blockingResource.detail !== undefined ? ` detail=${JSON.stringify(report.blockingResource.detail)}` : ""}`,
    );
  }
  if (report.dominantFailure !== undefined) {
    lines.push(
      `classification=${report.dominantFailure.classification} message=${JSON.stringify(report.dominantFailure.message)}`,
    );
  }
  if (report.activeAssembly !== undefined) {
    lines.push(
      `assembly mode=${report.activeAssembly.mode} bundle=${report.activeAssembly.bundleId ?? "implicit/legacy"} label=${JSON.stringify(report.activeAssembly.label ?? "not recorded")} authority=${report.activeAssembly.authority ?? "n/a"} cause=${report.activeAssembly.cause ?? "n/a"} tools=${report.activeAssembly.toolAllowlist.length}`,
    );
    if (report.activeAssembly.provider !== undefined) {
      lines.push(
        `assemblyProvider provider=${report.activeAssembly.provider.id} model=${report.activeAssembly.provider.model}${report.activeAssembly.provider.promptVariant !== undefined ? ` variant=${JSON.stringify(report.activeAssembly.provider.promptVariant)}` : ""}${report.activeAssembly.provider.compatibilityProfile !== undefined ? ` profile=${JSON.stringify(report.activeAssembly.provider.compatibilityProfile)}` : ""}`,
      );
    }
    if (report.activeAssembly.compatibility !== undefined) {
      lines.push(
        `assemblyCompatibility status=${report.activeAssembly.compatibility.status ?? "not_recorded"} source=${report.activeAssembly.compatibility.decisionSource ?? "n/a"}${report.activeAssembly.compatibility.downgradeReason !== undefined ? ` downgrade=${JSON.stringify(report.activeAssembly.compatibility.downgradeReason)}` : ""}${report.activeAssembly.compatibility.capabilityLossReason !== undefined ? ` capabilityLoss=${JSON.stringify(report.activeAssembly.compatibility.capabilityLossReason)}` : ""}`,
      );
    }
  }
  if (report.compatibility !== undefined) {
    lines.push(
      `compatibility provider=${report.compatibility.provider ?? "n/a"} model=${report.compatibility.model ?? "n/a"}${report.compatibility.promptVariant !== undefined ? ` variant=${JSON.stringify(report.compatibility.promptVariant)}` : ""}${report.compatibility.profile !== undefined ? ` profile=${JSON.stringify(report.compatibility.profile)}` : ""} status=${report.compatibility.status ?? "not_recorded"} source=${report.compatibility.decisionSource ?? "n/a"}${report.compatibility.downgradeReason !== undefined ? ` downgrade=${JSON.stringify(report.compatibility.downgradeReason)}` : ""}${report.compatibility.capabilityLossReason !== undefined ? ` capabilityLoss=${JSON.stringify(report.compatibility.capabilityLossReason)}` : ""}`,
    );
  }
  if (report.latestReasoning !== undefined) {
    lines.push(
      `latestReasoning at=${report.latestReasoning.at} message=${JSON.stringify(report.latestReasoning.message)}`,
    );
  }
  if (report.latestAdaptation !== undefined) {
    lines.push(
      `latestAdaptation status=${report.latestAdaptation.status} action=${report.latestAdaptation.recommendedAction ?? "not_recorded"} reason=${JSON.stringify(report.latestAdaptation.reason)} at=${report.latestAdaptation.at}${report.latestAdaptation.checkpointId !== undefined ? ` checkpointId=${report.latestAdaptation.checkpointId}` : ""}${report.latestAdaptation.eventId !== undefined ? ` eventId=${report.latestAdaptation.eventId}` : ""}${report.latestAdaptation.summaryArtifactId !== undefined ? ` summaryArtifactId=${report.latestAdaptation.summaryArtifactId}` : ""}`,
    );
  }
  if (report.latestEvidenceRecovery !== undefined) {
    lines.push(
      `latestEvidenceRecovery attempts=${report.latestEvidenceRecovery.attempts} lowSignal=${report.latestEvidenceRecovery.lowSignalAttempts} consecutiveLowSignal=${report.latestEvidenceRecovery.consecutiveLowSignal} broadened=${report.latestEvidenceRecovery.broadenedSearchUsed ? "yes" : "no"} targetedFetch=${report.latestEvidenceRecovery.targetedFetchUsed ? "yes" : "no"}${report.latestEvidenceRecovery.latestQuality !== undefined ? ` quality=${JSON.stringify(report.latestEvidenceRecovery.latestQuality)}` : ""}${report.latestEvidenceRecovery.latestIssues !== undefined && report.latestEvidenceRecovery.latestIssues.length > 0 ? ` issues=${JSON.stringify(report.latestEvidenceRecovery.latestIssues)}` : ""}${report.latestEvidenceRecovery.terminalOutcome !== undefined ? ` terminal=${JSON.stringify(report.latestEvidenceRecovery.terminalOutcome)}` : ""}`,
    );
  }
  if (report.runtimePlan !== undefined) {
    lines.push(formatRuntimePlan("runtimeExecution", report.runtimePlan));
    if (report.runtimePlan.latestNarration !== undefined) {
      lines.push(formatRuntimeNarration("runtimeNarration", report.runtimePlan.latestNarration));
    }
  }
  if (report.lastMeaningfulProgress !== undefined) {
    lines.push(
      `lastProgress kind=${report.lastMeaningfulProgress.kind} label=${JSON.stringify(report.lastMeaningfulProgress.label)}`,
    );
  }
  lines.push(
    `scheduler claims=${report.scheduler.claims} spawns=${report.scheduler.spawns} syncs=${report.scheduler.syncs} waits=${report.scheduler.waits}${report.scheduler.lastAction !== undefined ? ` last=${report.scheduler.lastAction}` : ""}`,
  );
  if (report.wait !== undefined) {
    lines.push(
      `wait kind=${report.wait.kind} eventType=${report.wait.eventType ?? "n/a"} requestId=${report.wait.requestId ?? "n/a"} grantId=${report.wait.grantId ?? "n/a"} lineage=${report.wait.lineage.length}`,
    );
  }
  if (report.childBlocker !== undefined) {
    lines.push(
      `childBlocker delegationId=${report.childBlocker.delegationId} childThreadId=${report.childBlocker.childThreadId} status=${report.childBlocker.status}${report.childBlocker.reason !== undefined ? ` reason=${JSON.stringify(report.childBlocker.reason)}` : ""}`,
    );
  }
  if (report.dominantChildBlocker !== undefined) {
    lines.push(
      `dominantChildBlocker delegationId=${report.dominantChildBlocker.delegationId} childThreadId=${report.dominantChildBlocker.childThreadId} status=${report.dominantChildBlocker.status}` +
      `${report.dominantChildBlocker.groupId !== undefined ? ` group=${report.dominantChildBlocker.groupId}` : ""}` +
      `${report.dominantChildBlocker.reason !== undefined ? ` reason=${JSON.stringify(report.dominantChildBlocker.reason)}` : ""}`,
    );
  }
  for (const loop of report.loops) {
    lines.push(
      `loop at=${loop.at}${loop.guardType !== undefined ? ` guard=${loop.guardType}` : ""}${loop.message !== undefined ? ` message=${loop.message}` : ""}`,
    );
  }

  return lines;
}

function formatRuntimePlan(prefix: string, plan: NonNullable<ReplayDoctorReport["runtimePlan"]>): string {
  return `${prefix} phase=${plan.phase ?? "n/a"} status=${plan.status ?? "n/a"} chunk=${JSON.stringify(plan.currentChunk ?? "n/a")}` +
    `${plan.commandBatchId !== undefined ? ` batch=${plan.commandBatchId}` : ""}` +
    `${plan.executionMode !== undefined ? ` mode=${plan.executionMode}` : ""}` +
    `${plan.commandNames !== undefined && plan.commandNames.length > 0 ? ` commands=${JSON.stringify(plan.commandNames)}` : ""}` +
    `${plan.waitReason !== undefined ? ` wait=${JSON.stringify(plan.waitReason)}` : ""}` +
    `${plan.expectedNextCommand !== undefined ? ` next=${plan.expectedNextCommand}` : ""}` +
    `${plan.lastCheckpoint?.substate !== undefined ? ` checkpoint=${plan.lastCheckpoint.substate}` : ""}`;
}

function formatRuntimeNarration(
  prefix: string,
  narration: NonNullable<NonNullable<ReplayDoctorReport["runtimePlan"]>["latestNarration"]>,
): string {
  return `${prefix} step=${narration.stepAgent ?? "n/a"}` +
    `${narration.latest !== undefined ? ` latest=${JSON.stringify(narration.latest)}` : ""}` +
    `${narration.waitingOn !== undefined ? ` waitingOn=${JSON.stringify(narration.waitingOn)}` : ""}` +
    `${narration.next !== undefined ? ` next=${JSON.stringify(narration.next)}` : ""}`;
}
