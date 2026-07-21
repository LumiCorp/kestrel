import assert from "node:assert/strict";

import { RunReplayService } from "../../src/replay/RunReplayService.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "RunReplayService reconstructs ordered stream summary and timeline", async () => {
  const store = new InMemorySessionStore();

  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    type: "run.started",
    level: "INFO",
    timestamp: "2026-02-26T00:00:00.000Z",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "step.selected",
    level: "INFO",
    timestamp: "2026-02-26T00:00:00.500Z",
    metadata: {
      step: "react.exec.dispatch",
    },
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "step.started",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.000Z",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "region.started",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.250Z",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "region.completed",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.500Z",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "region.synced",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.750Z",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    stepIndex: 0,
    type: "step.transitioned",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.900Z",
    metadata: {
      step: "react.exec.dispatch",
      nextStepAgent: "react.exec.finalize",
      status: "COMPLETED",
    },
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    type: "terminal.normalized",
    level: "INFO",
    timestamp: "2026-02-26T00:00:01.950Z",
    metadata: {
      status: "COMPLETED",
      finalStep: "react.exec.finalize",
      reasonCode: "goal_satisfied",
    },
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    type: "run.completed",
    level: "INFO",
    timestamp: "2026-02-26T00:00:02.000Z",
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-1",
  });

  assert.equal(replay.summary.eventCount, 9);
  assert.equal(replay.summary.stepsObserved, 1);
  assert.equal(replay.summary.terminalStatus, "COMPLETED");
  assert.equal(replay.summary.firstEventAt, "2026-02-26T00:00:00.000Z");
  assert.equal(replay.summary.lastEventAt, "2026-02-26T00:00:02.000Z");
  assert.equal(replay.summary.regionsStarted, 1);
  assert.equal(replay.summary.regionsCompleted, 1);
  assert.equal(replay.summary.syncNodesHit, 1);
  assert.equal(replay.summary.mergeConflicts, 0);
  assert.equal(replay.summary.progressStages, 0);
  assert.equal(replay.summary.progressToolCalls, 0);
  assert.equal(replay.summary.waitingMilestones, 0);
  assert.equal(replay.summary.heartbeatLiveOnlyCount, 0);
  assert.equal(replay.timeline.length, 9);
  assert.equal(replay.groups.length, 9);
  assert.equal(replay.timeline[1]?.label, "step selected");
  assert.equal(replay.transitions.some((entry) => entry.eventType === "step.transitioned"), true);
  assert.equal(replay.groups[1]?.kind, "step");
  const doctor = new RunReplayService(store).doctor(replay);
  assert.equal(doctor.status, "COMPLETED");
  assert.equal(doctor.finalStep, "react.exec.finalize");
  assert.equal(doctor.lastMeaningfulProgress?.label, "run.completed");
});

contractTest("runtime.hermetic", "RunReplayService reports action and maintenance model call counts", async () => {
  const store = new InMemorySessionStore();
  await store.appendRunEvent({
    runId: "run-model-budget",
    sessionId: "session-model-budget",
    type: "run.started",
    level: "INFO",
    timestamp: "2026-02-26T00:00:00.000Z",
  });
  await store.appendModelCallProvenance({
    callId: "call-action",
    runId: "run-model-budget",
    sessionId: "session-model-budget",
    stepIndex: 1,
    stepAgent: "agent.loop",
    phase: "deliberator",
    model: "mock",
    providerPayloadHash: "hash-action",
    componentHash: "component-action",
    metadata: {
      modelBudgetClass: "action",
      promptRetention: "hash_only",
      promptDump: {
        jsonPath: "/tmp/kestrel/model-prompts/action.json",
      },
    },
    createdAt: "2026-02-26T00:00:01.000Z",
    status: "COMPLETED",
  });
  await store.appendModelCallProvenance({
    callId: "call-maintenance",
    runId: "run-model-budget",
    sessionId: "session-model-budget",
    stepIndex: 1,
    stepAgent: "agent.loop",
    phase: "agent.compaction",
    model: "mock",
    providerPayloadHash: "hash-maintenance",
    componentHash: "component-maintenance",
    metadata: {
      modelBudgetClass: "maintenance",
      promptRetention: "hash_only",
    },
    createdAt: "2026-02-26T00:00:02.000Z",
    status: "COMPLETED",
  });

  const replay = await new RunReplayService(store).replay({ runId: "run-model-budget" });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.modelProvenance.callCount, 2);
  assert.equal(replay.modelProvenance.actionCallCount, 1);
  assert.equal(replay.modelProvenance.maintenanceCallCount, 1);
  assert.equal(doctor.modelProvenance?.actionCallCount, 1);
  assert.equal(doctor.modelProvenance?.maintenanceCallCount, 1);
  assert.equal(
    replay.modelProvenance.calls[0]?.metadata?.promptDump?.jsonPath,
    "/tmp/kestrel/model-prompts/action.json",
  );
});

contractTest("runtime.hermetic", "RunReplayService includes thread/delegation lineage and orchestration milestones", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("thread-parent");
  await store.ensureSession("session-child");
  await store.upsertThread({
    threadId: "thread-parent",
    sessionId: "thread-parent",
    title: "Parent",
    status: "COMPLETED",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-child",
    sessionId: "session-child",
    title: "Child",
    status: "WAITING",
    parentThreadId: "thread-parent",
    activeRunId: "run-child",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.upsertAssemblyBundle({
    bundleId: "bundle:reference:child",
    label: "Child runtime",
    source: "thread_inherited",
    toolAllowlist: ["fs.read_text", "web.search"],
    specialistIds: ["specialist:reference:delegation"],
    contextPolicyId: "context-policy:reference:default",
    approvalPolicyId: "approval-policy:turn_scoped",
    metadata: {
      modelProvider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      promptVariant: "reference-react:act",
      compatibilityProfile: "reference-react",
      compatibilityStatus: "compatible",
      compatibilityDecisionSource: "profile",
    },
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  });
  await store.appendThreadAssemblyRecord({
    recordId: "assembly-record-1",
    threadId: "thread-child",
    bundleId: "bundle:reference:child",
    cause: "thread_start",
    authority: "policy",
    createdAt: "2026-03-16T12:00:01.500Z",
  });
  await store.upsertAssemblyChangeProposal({
    proposalId: "assembly-proposal-1",
    threadId: "thread-child",
    requestedToolAllowlist: ["fs.read_text", "web.search"],
    proposedBy: "model",
    status: "PENDING",
    reason: "Need search access",
    createdAt: "2026-03-16T12:00:01.750Z",
  });
  await store.appendAssemblyChangeDecision({
    decisionId: "assembly-decision-1",
    threadId: "thread-child",
    proposalId: "assembly-proposal-1",
    result: "APPROVAL_REQUIRED",
    decidedBy: "policy",
    reason: "Widening requires approval",
    resultingBundleId: "bundle:reference:child",
    createdAt: "2026-03-16T12:00:01.800Z",
  });
  await store.upsertSpecialistDefinition({
    specialistId: "specialist:reference:delegation",
    label: "Delegation specialist",
    allowedToolAllowlist: ["fs.read_text", "web.search"],
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  });
  await store.upsertContextPolicyDefinition({
    contextPolicyId: "context-policy:reference:default",
    label: "Reference context policy",
    defaultAction: "continue",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-1",
    parentThreadId: "thread-parent",
    childThreadId: "thread-child",
    title: "Investigate",
    prompt: "Investigate the failure",
    status: "WAITING",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.upsertInteractionRequest({
    requestId: "request-1",
    threadId: "thread-child",
    runId: "run-child",
    kind: "approval",
    status: "RESOLVED",
    eventType: "user.approval",
    delegationId: "delegation-1",
    createdAt: "2026-03-16T12:00:02.000Z",
    resolvedAt: "2026-03-16T12:00:03.000Z",
  });
  await store.upsertApprovalGrant({
    grantId: "grant-1",
    threadId: "thread-child",
    requestId: "request-1",
    delegationId: "delegation-1",
    scope: "delegation_turn",
    status: "ACTIVE",
    allowedToolClasses: ["read_only"],
    allowedCapabilities: ["filesystem.read"],
    issuedBy: "operator",
    issuedAt: "2026-03-16T12:00:03.000Z",
  });
  await store.saveContextSummaryArtifact({
    artifactId: "summary-1",
    threadId: "thread-child",
    runId: "run-child",
    summary: "Compacted summary",
    source: "auto_compaction",
    createdAt: "2026-03-16T12:00:04.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "compaction-1",
    threadId: "thread-child",
    runId: "run-child",
    action: "compact",
    reason: "Context budget exceeded",
    summaryArtifactId: "summary-1",
    createdAt: "2026-03-16T12:00:04.000Z",
  });
  await store.appendRunEvent({
    runId: "run-child",
    sessionId: "session-child",
    type: "runtime.assembly.changed",
    level: "INFO",
    timestamp: "2026-03-16T12:00:01.850Z",
    metadata: {
      threadId: "thread-child",
      bundleId: "bundle:reference:child",
      cause: "thread_start",
      authority: "policy",
    },
  });
  await store.appendRunEvent({
    runId: "run-parent",
    sessionId: "thread-parent",
    type: "delegation.spawned",
    level: "INFO",
    timestamp: "2026-03-16T12:00:01.000Z",
    metadata: {
      delegationId: "delegation-1",
      childThreadId: "thread-child",
      status: "RUNNING",
    },
  });
  await store.appendRunEvent({
    runId: "run-child",
    sessionId: "session-child",
    type: "reasoning.update",
    level: "INFO",
    timestamp: "2026-03-16T12:00:01.900Z",
    metadata: {
      threadId: "thread-child",
      message: "Need operator approval before child execution can continue.",
    },
  });
  await store.appendRunEvent({
    runId: "run-child",
    sessionId: "session-child",
    type: "interaction.requested",
    level: "INFO",
    timestamp: "2026-03-16T12:00:02.000Z",
    metadata: {
      threadId: "thread-child",
      delegationId: "delegation-1",
      requestId: "request-1",
    },
  });
  await store.appendRunEvent({
    runId: "run-child",
    sessionId: "session-child",
    type: "approval.granted",
    level: "INFO",
    timestamp: "2026-03-16T12:00:03.000Z",
    metadata: {
      threadId: "thread-child",
      delegationId: "delegation-1",
      requestId: "request-1",
      grantId: "grant-1",
    },
  });
  await store.appendRunEvent({
    runId: "run-child",
    sessionId: "session-child",
    type: "context.compaction_applied",
    level: "INFO",
    timestamp: "2026-03-16T12:00:04.000Z",
    metadata: {
      threadId: "thread-child",
      summaryArtifactId: "summary-1",
    },
  });

  const replay = await new RunReplayService(store).replay({
    delegationId: "delegation-1",
    threadId: "thread-child",
  });

  assert.equal(replay.summary.threadId, "thread-child");
  assert.equal(replay.summary.delegationId, "delegation-1");
  assert.equal(replay.lineage.focusThread?.threadId, "thread-child");
  assert.equal(replay.lineage.parentThread?.threadId, "thread-parent");
  assert.equal(replay.lineage.parentDelegation?.delegationId, "delegation-1");
  assert.equal(replay.approvals.length, 1);
  assert.equal(replay.approvals[0]?.request.runId, "run-child");
  assert.equal(replay.approvals[0]?.latestGrant?.grantId, "grant-1");
  assert.equal(replay.compaction.authoritativeSummary?.artifactId, "summary-1");
  assert.equal(replay.assembly.mode, "explicit");
  assert.equal(replay.assembly.active?.record.bundleId, "bundle:reference:child");
  assert.equal(replay.assembly.active?.bundle?.label, "Child runtime");
  assert.equal(replay.assembly.proposals[0]?.proposalId, "assembly-proposal-1");
  assert.equal(replay.assembly.decisions[0]?.result, "APPROVAL_REQUIRED");
  assert.equal(replay.timeline.some((entry) => entry.label === "delegation spawned"), true);
  assert.equal(replay.timeline.some((entry) => entry.label === "interaction requested"), true);
  assert.equal(replay.timeline.some((entry) => entry.label === "context compaction applied"), true);
  assert.equal(replay.timeline.some((entry) => entry.label === "assembly changed"), true);
  assert.equal(
    replay.timeline.some((entry) => entry.detail?.includes("grantId=grant-1") === true),
    true,
  );
  const doctor = new RunReplayService(store).doctor(replay);
  assert.equal(doctor.focus.threadId, "thread-child");
  assert.equal(doctor.wait?.kind, "approval");
  assert.equal(doctor.wait?.grantId, "grant-1");
  assert.equal(doctor.dominantFailure?.classification, "approval_wait");
  assert.equal(doctor.activeAssembly?.bundleId, "bundle:reference:child");
  assert.equal(doctor.activeAssembly?.latestDecisionResult, "APPROVAL_REQUIRED");
  assert.equal(doctor.activeAssembly?.provider?.id, "openrouter");
  assert.equal(doctor.activeAssembly?.provider?.promptVariant, "reference-react:act");
  assert.equal(doctor.latestReasoning?.message, "Need operator approval before child execution can continue.");
  assert.equal(replay.compatibility?.provider, "openrouter");
  assert.equal(replay.compatibility?.model, "google/gemini-3.1-flash-lite-preview");
  assert.equal(replay.compatibility?.promptVariant, "reference-react:act");
  assert.equal(replay.compatibility?.profile, "reference-react");
  assert.equal(doctor.compatibility?.status, "compatible");
  assert.equal(doctor.compatibility?.decisionSource, "profile");
  assert.equal(doctor.compatibility?.provider, "openrouter");
  assert.equal(doctor.compatibility?.model, "google/gemini-3.1-flash-lite-preview");
});

contractTest("runtime.hermetic", "RunReplayService surfaces summarize_forward adaptation lineage with authoritative summary artifacts", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-adaptation-summarize");
  await store.upsertThread({
    threadId: "thread-adaptation-summarize",
    sessionId: "session-adaptation-summarize",
    title: "Adaptation summarize",
    status: "COMPLETED",
    activeRunId: "run-adaptation-summarize",
    createdAt: "2026-03-17T08:00:00.000Z",
    updatedAt: "2026-03-17T08:01:00.000Z",
  });
  await store.saveContextSummaryArtifact({
    artifactId: "summary-adaptation-summarize",
    threadId: "thread-adaptation-summarize",
    runId: "run-adaptation-summarize",
    summary: "Summarized forward checkpoint context.",
    source: "summarize_forward",
    createdAt: "2026-03-17T08:01:30.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "adaptation-event-summarize",
    threadId: "thread-adaptation-summarize",
    runId: "run-adaptation-summarize",
    action: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    summaryArtifactId: "summary-adaptation-summarize",
    createdAt: "2026-03-17T08:01:31.000Z",
  });
  await store.appendRunEvent({
    runId: "run-adaptation-summarize",
    sessionId: "session-adaptation-summarize",
    type: "context.adaptation_applied",
    level: "INFO",
    timestamp: "2026-03-17T08:01:31.000Z",
    metadata: {
      threadId: "thread-adaptation-summarize",
      action: "summarize_forward",
      summaryArtifactId: "summary-adaptation-summarize",
      reason: "Evidence recovery is exhausted.",
    },
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-adaptation-summarize",
    threadId: "thread-adaptation-summarize",
    runId: "run-adaptation-summarize",
    status: "ACCEPTED",
    recommendedAction: "summarize_forward",
    resolutionAction: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    createdAt: "2026-03-17T08:01:29.000Z",
    resolvedAt: "2026-03-17T08:01:32.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "adaptation-event-summarize-linked",
    threadId: "thread-adaptation-summarize",
    runId: "run-adaptation-summarize",
    action: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    summaryArtifactId: "summary-adaptation-summarize",
    metadata: {
      checkpointId: "checkpoint-adaptation-summarize",
    },
    createdAt: "2026-03-17T08:01:33.000Z",
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-adaptation-summarize",
    threadId: "thread-adaptation-summarize",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.adaptation?.status, "accepted");
  assert.equal(replay.adaptation?.recommendedAction, "summarize_forward");
  assert.equal(replay.adaptation?.checkpointId, "checkpoint-adaptation-summarize");
  assert.equal(replay.adaptation?.summaryArtifactId, "summary-adaptation-summarize");
  assert.equal(replay.compaction.authoritativeSummary?.artifactId, "summary-adaptation-summarize");
  assert.equal(doctor.latestAdaptation?.recommendedAction, "summarize_forward");
  assert.equal(
    replay.timeline.some(
      (entry) => entry.label === "adaptation applied" && entry.detail?.includes("summary-adaptation-summarize") === true,
    ),
    true,
  );
});

contractTest("runtime.hermetic", "RunReplayService surfaces split_into_child_thread adaptation lineage with delegation references", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-adaptation-split");
  await store.ensureSession("session-adaptation-split-child");
  await store.upsertThread({
    threadId: "thread-adaptation-split-parent",
    sessionId: "session-adaptation-split",
    title: "Adaptation split parent",
    status: "WAITING",
    activeRunId: "run-adaptation-split-parent",
    createdAt: "2026-03-17T09:00:00.000Z",
    updatedAt: "2026-03-17T09:01:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-adaptation-split-child",
    sessionId: "session-adaptation-split-child",
    title: "Adaptation split child",
    parentThreadId: "thread-adaptation-split-parent",
    status: "RUNNING",
    activeRunId: "run-adaptation-split-child",
    createdAt: "2026-03-17T09:01:10.000Z",
    updatedAt: "2026-03-17T09:01:40.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-adaptation-split",
    parentThreadId: "thread-adaptation-split-parent",
    parentRunId: "run-adaptation-split-parent",
    childThreadId: "thread-adaptation-split-child",
    childRunId: "run-adaptation-split-child",
    title: "Split child objective",
    prompt: "Continue unresolved objective in child thread",
    status: "RUNNING",
    createdAt: "2026-03-17T09:01:05.000Z",
    updatedAt: "2026-03-17T09:01:40.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "adaptation-event-split",
    threadId: "thread-adaptation-split-parent",
    runId: "run-adaptation-split-parent",
    action: "split_into_child_thread",
    reason: "Context pressure and capability loss require a split.",
    metadata: {
      delegationId: "delegation-adaptation-split",
      childThreadId: "thread-adaptation-split-child",
      checkpointId: "checkpoint-adaptation-split",
    },
    createdAt: "2026-03-17T09:01:41.000Z",
  });
  await store.appendRunEvent({
    runId: "run-adaptation-split-parent",
    sessionId: "session-adaptation-split",
    type: "context.adaptation_applied",
    level: "INFO",
    timestamp: "2026-03-17T09:01:41.000Z",
    metadata: {
      threadId: "thread-adaptation-split-parent",
      action: "split_into_child_thread",
      delegationId: "delegation-adaptation-split",
      childThreadId: "thread-adaptation-split-child",
      checkpointId: "checkpoint-adaptation-split",
      reason: "Context pressure and capability loss require a split.",
    },
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-adaptation-split",
    threadId: "thread-adaptation-split-parent",
    runId: "run-adaptation-split-parent",
    status: "ACCEPTED",
    recommendedAction: "split_into_child_thread",
    resolutionAction: "split_into_child_thread",
    reason: "Context pressure and capability loss require a split.",
    createdAt: "2026-03-17T09:01:39.000Z",
    resolvedAt: "2026-03-17T09:01:42.000Z",
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-adaptation-split-parent",
    threadId: "thread-adaptation-split-parent",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.adaptation?.status, "accepted");
  assert.equal(replay.adaptation?.recommendedAction, "split_into_child_thread");
  assert.equal(replay.adaptation?.checkpointId, "checkpoint-adaptation-split");
  assert.equal(replay.adaptation?.childThreadId, "thread-adaptation-split-child");
  assert.equal(replay.adaptation?.delegationId, "delegation-adaptation-split");
  assert.equal(doctor.latestAdaptation?.recommendedAction, "split_into_child_thread");
  assert.equal(doctor.latestAdaptation?.childThreadId, "thread-adaptation-split-child");
  assert.equal(doctor.latestAdaptation?.delegationId, "delegation-adaptation-split");
  assert.equal(
    replay.timeline.some(
      (entry) => entry.label === "adaptation applied" && entry.detail?.includes("childThreadId=thread-adaptation-split-child") === true,
    ),
    true,
  );
});

contractTest("runtime.hermetic", "RunReplayService identifies blocked parent threads and stalled runs", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("thread-root");
  await store.ensureSession("session-child");
  await store.upsertThread({
    threadId: "thread-root",
    sessionId: "thread-root",
    title: "Root",
    status: "RUNNING",
    activeRunId: "run-root",
    createdAt: "2026-03-16T11:59:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-child-2",
    sessionId: "session-child",
    title: "Child",
    status: "WAITING",
    parentThreadId: "thread-root",
    activeRunId: "run-child-2",
    createdAt: "2026-03-16T11:59:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-2",
    parentThreadId: "thread-root",
    childThreadId: "thread-child-2",
    parentRunId: "run-root",
    childRunId: "run-child-2",
    title: "Investigate",
    prompt: "Investigate",
    status: "WAITING",
    waitEventType: "user.reply",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:05:00.000Z",
  });
  await store.appendRunEvent({
    runId: "run-root",
    sessionId: "thread-root",
    type: "delegation.waiting",
    level: "INFO",
    timestamp: "2026-03-16T12:05:00.000Z",
    metadata: {
      delegationId: "delegation-2",
      childThreadId: "thread-child-2",
      status: "WAITING",
      waitEventType: "user.reply",
    },
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-root",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(doctor.status, "WAITING");
  assert.equal(doctor.childBlocker?.delegationId, "delegation-2");
  assert.equal(doctor.blockingResource?.kind, "delegation");
  assert.equal(doctor.dominantFailure?.classification, "delegation_blocked");
});

contractTest("runtime.hermetic", "RunReplayService exposes supervision groups, fan-in decisions, superseded lineage, and dominant blocker across multiple children", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("thread-supervision-parent");
  await store.ensureSession("session-supervision-child-a");
  await store.ensureSession("session-supervision-child-b");
  await store.ensureSession("session-supervision-child-c");

  await store.upsertThread({
    threadId: "thread-supervision-parent",
    sessionId: "thread-supervision-parent",
    title: "Supervision parent",
    status: "RUNNING",
    activeRunId: "run-supervision-parent",
    createdAt: "2026-03-17T12:00:00.000Z",
    updatedAt: "2026-03-17T12:10:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-supervision-child-a",
    sessionId: "session-supervision-child-a",
    title: "Child A",
    status: "WAITING",
    parentThreadId: "thread-supervision-parent",
    activeRunId: "run-supervision-child-a",
    createdAt: "2026-03-17T12:00:00.000Z",
    updatedAt: "2026-03-17T12:04:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-supervision-child-b",
    sessionId: "session-supervision-child-b",
    title: "Child B",
    status: "FAILED",
    parentThreadId: "thread-supervision-parent",
    activeRunId: "run-supervision-child-b",
    createdAt: "2026-03-17T12:00:00.000Z",
    updatedAt: "2026-03-17T12:06:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-supervision-child-c",
    sessionId: "session-supervision-child-c",
    title: "Child C",
    status: "WAITING",
    parentThreadId: "thread-supervision-parent",
    activeRunId: "run-supervision-child-c",
    createdAt: "2026-03-17T12:00:00.000Z",
    updatedAt: "2026-03-17T12:08:00.000Z",
  });

  await store.upsertDelegation({
    delegationId: "delegation-supervision-a",
    parentThreadId: "thread-supervision-parent",
    childThreadId: "thread-supervision-child-a",
    parentRunId: "run-supervision-parent",
    childRunId: "run-supervision-child-a",
    title: "Child A objective",
    prompt: "Run child A objective",
    status: "WAITING",
    waitEventType: "user.approval",
    resultSummary: "Waiting on approval.",
    policy: {
      supervision: {
        groupId: "supervision-group-1",
        mode: "fan_out",
      },
    },
    createdAt: "2026-03-17T12:00:30.000Z",
    updatedAt: "2026-03-17T12:04:00.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-supervision-b",
    parentThreadId: "thread-supervision-parent",
    childThreadId: "thread-supervision-child-b",
    parentRunId: "run-supervision-parent",
    childRunId: "run-supervision-child-b",
    title: "Child B objective",
    prompt: "Run child B objective",
    status: "FAILED",
    errorMessage: "Superseded by a newer child run.",
    policy: {
      supervision: {
        groupId: "supervision-group-1",
        outcomeState: "superseded",
        supersededByDelegationId: "delegation-supervision-c",
        supersededAt: "2026-03-17T12:07:10.000Z",
      },
    },
    createdAt: "2026-03-17T12:00:40.000Z",
    updatedAt: "2026-03-17T12:06:00.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-supervision-c",
    parentThreadId: "thread-supervision-parent",
    childThreadId: "thread-supervision-child-c",
    parentRunId: "run-supervision-parent",
    childRunId: "run-supervision-child-c",
    title: "Child C objective",
    prompt: "Run child C objective",
    status: "WAITING",
    waitEventType: "user.reply",
    resultSummary: "Latest child is blocked waiting for operator reply.",
    policy: {
      supervision: {
        groupId: "supervision-group-1",
      },
    },
    createdAt: "2026-03-17T12:00:50.000Z",
    updatedAt: "2026-03-17T12:08:00.000Z",
  });

  await store.appendRunEvent({
    runId: "run-supervision-parent",
    sessionId: "thread-supervision-parent",
    type: "delegation.progress",
    level: "INFO",
    timestamp: "2026-03-17T12:05:00.000Z",
    metadata: {
      delegationId: "delegation-supervision-a",
      childThreadId: "thread-supervision-child-a",
      supervisionGroupId: "supervision-group-1",
      fanInDecision: "wait_for_more",
      reason: "Need one additional child before fan-in.",
    },
  });
  await store.appendRunEvent({
    runId: "run-supervision-parent",
    sessionId: "thread-supervision-parent",
    type: "delegation.waiting",
    level: "INFO",
    timestamp: "2026-03-17T12:08:01.000Z",
    metadata: {
      delegationId: "delegation-supervision-c",
      childThreadId: "thread-supervision-child-c",
      supervisionGroupId: "supervision-group-1",
      status: "WAITING",
    },
  });
  await store.appendRunEvent({
    runId: "run-supervision-parent",
    sessionId: "thread-supervision-parent",
    type: "run.waiting",
    level: "INFO",
    timestamp: "2026-03-17T12:08:02.000Z",
    metadata: {
      threadId: "thread-supervision-parent",
      delegationId: "delegation-supervision-c",
    },
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-supervision-parent",
    threadId: "thread-supervision-parent",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  const group = replay.supervision.groups.find((entry) => entry.groupId === "supervision-group-1");
  assert.equal(group !== undefined, true);
  assert.equal(group?.childOutcomes.length, 3);
  assert.equal(
    group?.childOutcomes.some(
      (entry) =>
        entry.delegationId === "delegation-supervision-b" &&
        entry.state === "superseded" &&
        entry.supersededByDelegationId === "delegation-supervision-c",
    ),
    true,
  );
  assert.equal(
    replay.supervision.fanInDecisions.some(
      (entry) => entry.groupId === "supervision-group-1" && entry.decision === "wait_for_more",
    ),
    true,
  );
  assert.equal(
    replay.supervision.supersededLineage.some(
      (entry) =>
        entry.delegationId === "delegation-supervision-b" &&
        entry.supersededByDelegationId === "delegation-supervision-c",
    ),
    true,
  );
  assert.equal(replay.supervision.dominantBlocker?.delegationId, "delegation-supervision-c");
  assert.equal(doctor.childBlocker?.delegationId, "delegation-supervision-c");
  assert.equal(doctor.childBlocker?.groupId, "supervision-group-1");
  assert.equal(
    replay.timeline.some(
      (entry) =>
        entry.label === "delegation.progress" &&
        entry.detail?.includes("fanInDecision=wait_for_more") === true,
    ),
    true,
  );
});

contractTest("runtime.hermetic", "RunReplayService keeps fan-in checkpoints out of latest adaptation summaries", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-adaptation-filter");
  await store.upsertThread({
    threadId: "thread-adaptation-filter",
    sessionId: "session-adaptation-filter",
    title: "Adaptation filter thread",
    status: "WAITING",
    activeRunId: "run-adaptation-filter",
    createdAt: "2026-03-17T12:00:00.000Z",
    updatedAt: "2026-03-17T12:05:00.000Z",
  });
  await store.upsertThread({
    threadId: "thread-adaptation-filter-child",
    sessionId: "session-adaptation-filter-child",
    title: "Adaptation filter child",
    status: "COMPLETED",
    parentThreadId: "thread-adaptation-filter",
    activeRunId: "run-adaptation-filter-child",
    createdAt: "2026-03-17T12:00:30.000Z",
    updatedAt: "2026-03-17T12:04:30.000Z",
  });
  await store.upsertDelegation({
    delegationId: "delegation-adaptation-filter-child",
    parentThreadId: "thread-adaptation-filter",
    childThreadId: "thread-adaptation-filter-child",
    parentRunId: "run-adaptation-filter",
    childRunId: "run-adaptation-filter-child",
    title: "Adaptation filter child objective",
    prompt: "Collect one child result",
    status: "COMPLETED",
    resultSummary: "Collected a partial child result.",
    policy: {
      supervision: {
        groupId: "group-adaptation-filter",
      },
    },
    createdAt: "2026-03-17T12:00:30.000Z",
    updatedAt: "2026-03-17T12:04:30.000Z",
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-adaptation",
    threadId: "thread-adaptation-filter",
    runId: "run-adaptation-filter",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Context pressure is too high to continue safely.",
    createdAt: "2026-03-17T12:03:00.000Z",
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-fanin",
    threadId: "thread-adaptation-filter",
    runId: "run-adaptation-filter",
    status: "PENDING",
    recommendedAction: "operator_checkpoint",
    reason: "Choose the authoritative child result set.",
    metadata: {
      kind: "fan_in",
      selectedDelegationIds: ["delegation-a", "delegation-b"],
    },
    createdAt: "2026-03-17T12:04:00.000Z",
  });
  await store.appendRunEvent({
    runId: "run-adaptation-filter",
    sessionId: "session-adaptation-filter",
    type: "delegation.progress",
    level: "INFO",
    timestamp: "2026-03-17T12:04:30.000Z",
    metadata: {
      threadId: "thread-adaptation-filter",
      supervisionGroupId: "group-adaptation-filter",
      fanInDecision: "pending_checkpoint",
      checkpointId: "checkpoint-fanin",
      reason: "Operator must choose the child set to keep.",
    },
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-adaptation-filter",
    threadId: "thread-adaptation-filter",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(doctor.latestAdaptation?.checkpointId, "checkpoint-adaptation");
  assert.equal(doctor.latestAdaptation?.recommendedAction, "summarize_forward");
  assert.equal(
    replay.timeline.some(
      (entry) =>
        entry.label === "delegation.progress" &&
        entry.detail?.includes("fanInDecision=pending_checkpoint") === true,
    ),
    true,
  );
});

contractTest("runtime.hermetic", "RunReplayService reports legacy threads without assembly history as implicit/legacy", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-legacy");
  await store.upsertThread({
    threadId: "thread-legacy",
    sessionId: "session-legacy",
    title: "Legacy",
    status: "COMPLETED",
    activeRunId: "run-legacy",
    createdAt: "2026-03-16T10:00:00.000Z",
    updatedAt: "2026-03-16T10:05:00.000Z",
  });
  await store.appendRunEvent({
    runId: "run-legacy",
    sessionId: "session-legacy",
    type: "run.completed",
    level: "INFO",
    timestamp: "2026-03-16T10:05:00.000Z",
    metadata: {
      threadId: "thread-legacy",
    },
  });

  const replay = await new RunReplayService(store).replay({
    threadId: "thread-legacy",
    runId: "run-legacy",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.assembly.mode, "implicit_legacy");
  assert.equal(replay.assembly.history.length, 0);
  assert.equal(doctor.activeAssembly?.mode, "implicit_legacy");
  assert.deepEqual(doctor.activeAssembly?.toolAllowlist, []);
});

contractTest("runtime.hermetic", "RunReplayService classifies TOOL_LOOKUP_FAILED caused by capability-loss tool pruning", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-pruned");
  await store.upsertThread({
    threadId: "thread-pruned",
    sessionId: "session-pruned",
    title: "Pruned",
    status: "FAILED",
    activeRunId: "run-pruned",
    createdAt: "2026-03-17T00:24:50.000Z",
    updatedAt: "2026-03-17T00:25:31.000Z",
  });
  await store.upsertAssemblyBundle({
    bundleId: "bundle:reference:default",
    label: "Reference default",
    source: "profile_default",
    toolAllowlist: ["internet.search", "FinalizeAnswer"],
    specialistIds: [],
    createdAt: "2026-03-17T00:24:50.000Z",
    updatedAt: "2026-03-17T00:24:50.000Z",
  });
  await store.upsertAssemblyBundle({
    bundleId: "bundle:thread-pruned:capability-loss:1",
    label: "Reference narrowed runtime",
    source: "runtime_derived",
    toolAllowlist: ["internet.search"],
    specialistIds: [],
    metadata: {
      derivedFromBundleId: "bundle:reference:default",
      unavailableTools: ["FinalizeAnswer"],
    },
    createdAt: "2026-03-17T00:24:50.050Z",
    updatedAt: "2026-03-17T00:24:50.050Z",
  });
  await store.appendThreadAssemblyRecord({
    recordId: "assembly-record-thread-start",
    threadId: "thread-pruned",
    bundleId: "bundle:reference:default",
    cause: "thread_start",
    authority: "profile",
    createdAt: "2026-03-17T00:24:50.000Z",
  });
  await store.appendThreadAssemblyRecord({
    recordId: "assembly-record-cap-loss",
    threadId: "thread-pruned",
    bundleId: "bundle:thread-pruned:capability-loss:1",
    cause: "capability_loss",
    authority: "policy",
    metadata: {
      unavailableTools: ["FinalizeAnswer"],
    },
    createdAt: "2026-03-17T00:24:50.060Z",
  });
  await store.appendRunEvent({
    runId: "run-pruned",
    sessionId: "session-pruned",
    type: "run.failed",
    level: "ERROR",
    timestamp: "2026-03-17T00:25:31.457Z",
    metadata: {
      code: "TOOL_LOOKUP_FAILED",
      details: {
        toolName: "FinalizeAnswer",
      },
      message: "Tool 'FinalizeAnswer' is not allowlisted.",
    },
  });
  await store.appendRunEvent({
    runId: "run-pruned",
    sessionId: "session-pruned",
    type: "terminal.normalized",
    level: "INFO",
    timestamp: "2026-03-17T00:25:31.462Z",
    metadata: {
      status: "FAILED",
      reasonCode: "TOOL_LOOKUP_FAILED",
      finalStep: "react.exec.finalize",
      threadId: "thread-pruned",
    },
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-pruned",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(doctor.status, "FAILED");
  assert.equal(doctor.terminalReasonCode, "TOOL_LOOKUP_FAILED");
  assert.equal(doctor.dominantFailure?.classification, "capability_loss_pruned_tool");
  assert.equal(doctor.dominantFailure?.message.includes("FinalizeAnswer"), true);
});

contractTest("runtime.hermetic", "RunReplayService derives evidence recovery summary from persisted checkpoint signals", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-evidence-checkpoint");
  await store.upsertThread({
    threadId: "thread-evidence-checkpoint",
    sessionId: "session-evidence-checkpoint",
    title: "Evidence checkpoint",
    status: "WAITING",
    activeRunId: "run-evidence-checkpoint",
    createdAt: "2026-03-17T10:00:00.000Z",
    updatedAt: "2026-03-17T10:00:30.000Z",
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-evidence-1",
    threadId: "thread-evidence-checkpoint",
    runId: "run-evidence-checkpoint",
    status: "PENDING",
    recommendedAction: "summarize_forward",
    reason: "Evidence recovery is exhausted.",
    signals: {
      evidenceRecovery: {
        objectiveKey: "supplier onboarding controls",
        family: "news_research",
        attempts: 4,
        lowSignalAttempts: 2,
        consecutiveLowSignal: 2,
        broadenedSearchUsed: true,
        targetedFetchUsed: true,
        duplicateEvents: 1,
        latestDuplicate: {
          kind: "duplicate_executed_result",
          family: "web_search_results",
          toolName: "internet.search",
          fingerprint: "fp-dup",
          duplicateCount: 2,
          matchedPriorStep: 3,
        },
        latest: {
          quality: "low",
          lowSignal: true,
          issues: ["low_signal_mix"],
          stage: "target_article_fetch",
        },
      },
    },
    createdAt: "2026-03-17T10:00:35.000Z",
  });

  const replay = await new RunReplayService(store).replay({
    threadId: "thread-evidence-checkpoint",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.evidenceRecovery?.attempts, 4);
  assert.equal(replay.evidenceRecovery?.family, "web_research");
  assert.equal(replay.evidenceRecovery?.lowSignalAttempts, 2);
  assert.equal(replay.evidenceRecovery?.consecutiveLowSignal, 2);
  assert.equal(replay.evidenceRecovery?.broadenedSearchUsed, true);
  assert.equal(replay.evidenceRecovery?.targetedFetchUsed, true);
  assert.equal(replay.evidenceRecovery?.duplicateEvents, 1);
  assert.equal(replay.evidenceRecovery?.latestDuplicateKind, "duplicate_executed_result");
  assert.equal(replay.evidenceRecovery?.latestDuplicateCount, 2);
  assert.deepEqual(replay.evidenceRecovery?.latestIssues, ["low_signal_mix"]);
  assert.equal(doctor.latestEvidenceRecovery?.attempts, 4);
  assert.equal(doctor.latestEvidenceRecovery?.family, "web_research");
  assert.equal(doctor.latestEvidenceRecovery?.targetedFetchUsed, true);
});

contractTest("runtime.hermetic", "RunReplayService surfaces canonical filesystem retrieval family from persisted checkpoint signals", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-filesystem-evidence");
  await store.upsertThread({
    threadId: "thread-filesystem-evidence",
    sessionId: "session-filesystem-evidence",
    title: "Filesystem evidence checkpoint",
    status: "WAITING",
    activeRunId: "run-filesystem-evidence",
    createdAt: "2026-03-17T10:00:00.000Z",
    updatedAt: "2026-03-17T10:00:30.000Z",
  });
  await store.upsertContextCheckpoint({
    checkpointId: "checkpoint-filesystem-evidence-1",
    threadId: "thread-filesystem-evidence",
    runId: "run-filesystem-evidence",
    status: "PENDING",
    recommendedAction: "continue",
    reason: "Awaiting narrower coding scope.",
    signals: {
      evidenceRecovery: {
        objectiveKey: "keep working on the website",
        family: "filesystem_retrieval",
        attempts: 2,
        lowSignalAttempts: 0,
        consecutiveLowSignal: 0,
        broadenedSearchUsed: false,
        targetedFetchUsed: false,
        duplicateEvents: 0,
        filesystemInspection: {
          inventoryActions: 1,
          groundedReadActions: 1,
          budgetExhausted: true,
          inventoryPaths: [".", "app", "app/page.tsx"],
        },
      },
    },
    createdAt: "2026-03-17T10:00:35.000Z",
  });

  const replay = await new RunReplayService(store).replay({
    threadId: "thread-filesystem-evidence",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.evidenceRecovery?.family, "filesystem_retrieval");
  assert.equal(doctor.latestEvidenceRecovery?.family, "filesystem_retrieval");
});

contractTest("runtime.hermetic", "RunReplayService surfaces split adaptation lineage and compaction-backed evidence fallback", async () => {
  const store = new InMemorySessionStore();

  await store.ensureSession("session-adaptation");
  await store.upsertThread({
    threadId: "thread-adaptation",
    sessionId: "session-adaptation",
    title: "Adaptation thread",
    status: "WAITING",
    activeRunId: "run-adaptation",
    createdAt: "2026-03-17T11:00:00.000Z",
    updatedAt: "2026-03-17T11:01:00.000Z",
  });
  await store.saveContextSummaryArtifact({
    artifactId: "summary-adapt-1",
    threadId: "thread-adaptation",
    runId: "run-adaptation",
    summary: "Summarized forward context",
    source: "summarize_forward",
    createdAt: "2026-03-17T11:00:20.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "adaptation-event-1",
    threadId: "thread-adaptation",
    runId: "run-adaptation",
    action: "split_into_child_thread",
    reason: "Context pressure and low-signal evidence require child-thread split.",
    summaryArtifactId: "summary-adapt-1",
    metadata: {
      childThreadId: "thread-adaptation-child",
      delegationId: "delegation-adaptation-1",
      sourceSignals: {
        contextPressure: "high",
        evidenceRecovery: {
          objectiveKey: "supplier onboarding controls",
          family: "news_research",
          attempts: 5,
          lowSignalAttempts: 3,
          consecutiveLowSignal: 3,
          broadenedSearchUsed: true,
          targetedFetchUsed: true,
          latest: {
            quality: "low",
            lowSignal: true,
            issues: ["insufficient_results"],
            stage: "target_article_fetch",
          },
        },
      },
    },
    createdAt: "2026-03-17T11:00:30.000Z",
  });
  await store.appendRunEvent({
    runId: "run-adaptation",
    sessionId: "session-adaptation",
    type: "context.adaptation_applied",
    level: "INFO",
    timestamp: "2026-03-17T11:00:31.000Z",
    metadata: {
      threadId: "thread-adaptation",
      action: "split_into_child_thread",
      childThreadId: "thread-adaptation-child",
      delegationId: "delegation-adaptation-1",
      summaryArtifactId: "summary-adapt-1",
    },
  });

  const replay = await new RunReplayService(store).replay({
    runId: "run-adaptation",
    threadId: "thread-adaptation",
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.adaptation?.status, "auto_applied");
  assert.equal(replay.adaptation?.recommendedAction, "split_into_child_thread");
  assert.equal(replay.adaptation?.childThreadId, "thread-adaptation-child");
  assert.equal(replay.adaptation?.delegationId, "delegation-adaptation-1");
  assert.equal(replay.adaptation?.summaryArtifactId, "summary-adapt-1");
  assert.equal(replay.evidenceRecovery?.attempts, 5);
  assert.equal(replay.evidenceRecovery?.consecutiveLowSignal, 3);
  assert.deepEqual(replay.evidenceRecovery?.latestIssues, ["insufficient_results"]);
  assert.equal(doctor.latestAdaptation?.recommendedAction, "split_into_child_thread");
  assert.equal(doctor.latestEvidenceRecovery?.attempts, 5);
  assert.equal(
    replay.timeline.some(
      (entry) =>
        entry.label === "adaptation applied" &&
        entry.detail?.includes("action=split_into_child_thread") === true,
    ),
    true,
  );
});

contractTest("runtime.hermetic", "RunReplayService captures compact adaptation for repeated continuation-thrash sessions", async () => {
  const store = new InMemorySessionStore();
  const sessionId = "session-1773889053602";
  const runId = "run-1773889053605";
  const threadId = "thread-1773889053602";
  const evidenceRecovery = {
    objectiveKey: "reference-session-1773889053602-1773889053605",
    family: "news_research",
    attempts: 91,
    lowSignalAttempts: 91,
    consecutiveLowSignal: 91,
    broadenedSearchUsed: true,
    targetedFetchUsed: true,
    latest: {
      quality: "low",
      lowSignal: true,
      issues: ["low_signal_mix", "insufficient_results"],
      stage: "target_article_fetch",
    },
  };

  await store.ensureSession(sessionId);
  await store.upsertThread({
    threadId,
    sessionId,
    title: "Reference continuation thrash",
    status: "WAITING",
    activeRunId: runId,
    lastRunStatus: "WAITING",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "max_steps_continuation",
      },
    },
    metadata: {
      autoCompactionState: "armed",
    },
    createdAt: "2026-03-19T14:00:00.000Z",
    updatedAt: "2026-03-19T14:10:00.000Z",
  });
  await store.saveContextSummaryArtifact({
    artifactId: "summary-thrash-1",
    threadId,
    runId,
    summary: "Compacted continuation context after repeated low-signal retries.",
    source: "auto_compaction",
    metadata: {
      sourceSignals: {
        evidenceRecovery,
      },
    },
    createdAt: "2026-03-19T14:09:30.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "compaction-thrash-1",
    threadId,
    runId,
    action: "compact",
    reason: "Thread is thrashing and should compact before more work continues.",
    summaryArtifactId: "summary-thrash-1",
    metadata: {
      sourceSignals: {
        evidenceRecovery,
      },
    },
    createdAt: "2026-03-19T14:09:31.000Z",
  });

  for (let index = 0; index < 32; index += 1) {
    await store.appendRunEvent({
      runId,
      sessionId,
      stepIndex: index,
      type: "progress.tool",
      level: "INFO",
      timestamp: new Date(Date.UTC(2026, 2, 19, 14, 0, index)).toISOString(),
      metadata: {
        threadId,
        tool: index % 2 === 0 ? "internet.search" : "internet.extract",
        seq: index + 1,
      },
    });
  }

  for (let index = 0; index < 40; index += 1) {
    await store.appendRunEvent({
      runId,
      sessionId,
      stepIndex: index,
      type: "reasoning.update",
      level: "INFO",
      timestamp: new Date(Date.UTC(2026, 2, 19, 14, 2, index)).toISOString(),
      metadata: {
        threadId,
        message: `Reasoning update ${index + 1}`,
        seq: index + 1,
      },
    });
  }

  for (let index = 0; index < 3; index += 1) {
    const minute = 6 + index;
    await store.appendRunEvent({
      runId,
      sessionId,
      type: "progress.waiting",
      level: "INFO",
      timestamp: new Date(Date.UTC(2026, 2, 19, 14, minute, 0)).toISOString(),
      metadata: {
        threadId,
        reason: "max_steps_continuation",
      },
    });
    await store.appendRunEvent({
      runId,
      sessionId,
      type: "wait.entered",
      level: "INFO",
      timestamp: new Date(Date.UTC(2026, 2, 19, 14, minute, 1)).toISOString(),
      metadata: {
        threadId,
        kind: "user",
        eventType: "user.reply",
        reason: "max_steps_continuation",
      },
    });
    await store.appendRunEvent({
      runId,
      sessionId,
      type: "run.waiting",
      level: "INFO",
      timestamp: new Date(Date.UTC(2026, 2, 19, 14, minute, 2)).toISOString(),
      metadata: {
        threadId,
        reason: "max_steps_continuation",
      },
    });
    if (index < 2) {
      await store.appendRunEvent({
        runId,
        sessionId,
        type: "wait.resumed",
        level: "INFO",
        timestamp: new Date(Date.UTC(2026, 2, 19, 14, minute, 3)).toISOString(),
        metadata: {
          threadId,
          eventType: "user.reply",
        },
      });
    }
  }

  const replay = await new RunReplayService(store).replay({
    runId,
    threadId,
  });
  const doctor = new RunReplayService(store).doctor(replay);

  assert.equal(replay.summary.progressToolCalls, 32);
  assert.equal(replay.summary.waitingMilestones, 3);
  assert.equal(replay.summary.waitsEntered, 3);
  assert.equal(replay.summary.waitsResumed, 2);
  assert.equal(replay.adaptation?.recommendedAction, "compact");
  assert.equal(replay.adaptation?.status, "auto_applied");
  assert.equal(replay.evidenceRecovery?.attempts, 91);
  assert.equal(replay.evidenceRecovery?.consecutiveLowSignal, 91);
  assert.equal(doctor.wait?.kind, "user_input");
  assert.equal(doctor.wait?.eventType, "user.reply");
  assert.equal(doctor.latestAdaptation?.recommendedAction, "compact");
  assert.equal(doctor.latestEvidenceRecovery?.attempts, 91);
  assert.equal(doctor.latestEvidenceRecovery?.consecutiveLowSignal, 91);
  assert.equal(doctor.latestReasoning?.message, "Reasoning update 40");
});
