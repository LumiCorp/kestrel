import type { RuntimeError } from "../../../src/kestrel/contracts/base.js";
import type { RunEvent, RuntimeEvent } from "../../../src/kestrel/contracts/events.js";
import type { NormalizedOutput } from "../../../src/kestrel/contracts/execution.js";
import type { AssemblyBundleRecord, DelegationRecord, InteractionRequestRecord, ThreadAssemblyRecord, ThreadRecord } from "../../../src/kestrel/contracts/orchestration.js";
import type { SessionStore } from "../../../src/kestrel/contracts/store.js";


export interface OpsInspectionFixtureRefs {
  root: {
    sessionId: string;
    threadId: string;
    runId: string;
    delegationId: string;
    completedDelegationId: string;
    supersededDelegationId: string;
    completedChildThreadId: string;
    supersededChildThreadId: string;
  };
  approvalChild: {
    sessionId: string;
    threadId: string;
    runId: string;
    requestId: string;
  };
  modeBlocked: {
    sessionId: string;
    threadId: string;
    runId: string;
  };
  compaction: {
    sessionId: string;
    threadId: string;
    runId: string;
    artifactId: string;
  };
  failureRoot: {
    sessionId: string;
    threadId: string;
    runId: string;
    delegationId: string;
  };
  failureChild: {
    sessionId: string;
    threadId: string;
    runId: string;
  };
  stalled: {
    sessionId: string;
    threadId: string;
    runId: string;
  };
  userInput: {
    sessionId: string;
    threadId: string;
    runId: string;
    requestId: string;
  };
}

export const OPS_FIXTURE_IDS: OpsInspectionFixtureRefs = {
  root: {
    sessionId: "ops-root-session",
    threadId: "ops-root-thread",
    runId: "ops-root-run",
    delegationId: "ops-delegation-approval",
    completedDelegationId: "ops-delegation-completed",
    supersededDelegationId: "ops-delegation-superseded",
    completedChildThreadId: "ops-completed-child-thread",
    supersededChildThreadId: "ops-superseded-child-thread",
  },
  approvalChild: {
    sessionId: "ops-approval-child-session",
    threadId: "ops-approval-child-thread",
    runId: "ops-approval-child-run",
    requestId: "ops-approval-request",
  },
  modeBlocked: {
    sessionId: "ops-mode-blocked-session",
    threadId: "ops-mode-blocked-thread",
    runId: "ops-mode-blocked-run",
  },
  compaction: {
    sessionId: "ops-compaction-session",
    threadId: "ops-compaction-thread",
    runId: "ops-compaction-run",
    artifactId: "ops-compaction-summary",
  },
  failureRoot: {
    sessionId: "ops-failure-root-session",
    threadId: "ops-failure-root-thread",
    runId: "ops-failure-root-run",
    delegationId: "ops-delegation-failure",
  },
  failureChild: {
    sessionId: "ops-failure-child-session",
    threadId: "ops-failure-child-thread",
    runId: "ops-failure-child-run",
  },
  stalled: {
    sessionId: "ops-stalled-session",
    threadId: "ops-stalled-thread",
    runId: "ops-stalled-run",
  },
  userInput: {
    sessionId: "ops-user-input-session",
    threadId: "ops-user-input-thread",
    runId: "ops-user-input-run",
    requestId: "ops-user-input-request",
  },
};

export async function seedOpsInspectionFixtures(
  store: SessionStore,
): Promise<OpsInspectionFixtureRefs> {
  const ids = OPS_FIXTURE_IDS;

  await seedApprovalBlockedDelegation(store);
  await seedDelegationFailure(store);
  await seedCompaction(store);
  await seedUserInputWait(store);
  await seedModeBlocked(store);
  await seedStalledRun(store);

  return ids;
}

async function seedApprovalBlockedDelegation(store: SessionStore): Promise<void> {
  const root = OPS_FIXTURE_IDS.root;
  const child = OPS_FIXTURE_IDS.approvalChild;
  const completedChild = {
    sessionId: "ops-completed-child-session",
    threadId: root.completedChildThreadId,
    runId: "ops-completed-child-run",
  };
  const supersededChild = {
    sessionId: "ops-superseded-child-session",
    threadId: root.supersededChildThreadId,
    runId: "ops-superseded-child-run",
  };

  await ensureRun(store, root.sessionId, root.runId, "user.message", "WAITING", "2026-03-16T12:00:00.000Z");
  await ensureRun(store, child.sessionId, child.runId, "user.message", "WAITING", "2026-03-16T12:00:05.000Z");
  await ensureRun(
    store,
    completedChild.sessionId,
    completedChild.runId,
    "user.message",
    "COMPLETED",
    "2026-03-16T11:59:00.000Z",
  );
  await ensureRun(
    store,
    supersededChild.sessionId,
    supersededChild.runId,
    "user.message",
    "COMPLETED",
    "2026-03-16T11:58:00.000Z",
  );

  await store.upsertThread(thread({
    threadId: root.threadId,
    sessionId: root.sessionId,
    title: "Root investigation",
    status: "WAITING",
    activeRunId: root.runId,
    waitFor: {
      kind: "approval",
      eventType: "delegation.waiting",
      metadata: {
        prompt: "Child thread is waiting for approval.",
      },
    },
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:40.000Z",
  }));
  await store.upsertThread(thread({
    threadId: child.threadId,
    sessionId: child.sessionId,
    title: "Approval child",
    status: "WAITING",
    parentThreadId: root.threadId,
    activeRunId: child.runId,
    currentRequestId: child.requestId,
    lastRunStatus: "WAITING",
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        prompt: "Approve child thread before continuing.",
      },
    },
    createdAt: "2026-03-16T12:00:05.000Z",
    updatedAt: "2026-03-16T12:00:45.000Z",
  }));
  await store.upsertThread(thread({
    threadId: completedChild.threadId,
    sessionId: completedChild.sessionId,
    title: "Completed child",
    status: "COMPLETED",
    parentThreadId: root.threadId,
    activeRunId: completedChild.runId,
    lastRunStatus: "COMPLETED",
    createdAt: "2026-03-16T11:59:00.000Z",
    updatedAt: "2026-03-16T12:00:20.000Z",
  }));
  await store.upsertThread(thread({
    threadId: supersededChild.threadId,
    sessionId: supersededChild.sessionId,
    title: "Superseded child",
    status: "COMPLETED",
    parentThreadId: root.threadId,
    activeRunId: supersededChild.runId,
    lastRunStatus: "COMPLETED",
    createdAt: "2026-03-16T11:58:00.000Z",
    updatedAt: "2026-03-16T12:00:15.000Z",
  }));

  const delegation: DelegationRecord = {
    delegationId: root.delegationId,
    parentThreadId: root.threadId,
    childThreadId: child.threadId,
    parentRunId: root.runId,
    childRunId: child.runId,
    title: "Investigate operator approval",
    prompt: "Investigate and pause for approval.",
    status: "WAITING",
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
    waitEventType: "user.approval",
    launchedBy: "agent",
    createdAt: "2026-03-16T12:00:05.000Z",
    updatedAt: "2026-03-16T12:00:45.000Z",
  };
  await store.upsertDelegation(delegation);
  await store.upsertDelegation({
    delegationId: root.completedDelegationId,
    parentThreadId: root.threadId,
    childThreadId: completedChild.threadId,
    parentRunId: root.runId,
    childRunId: completedChild.runId,
    title: "Completed supporting investigation",
    prompt: "Collect supporting evidence and return.",
    status: "COMPLETED",
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
    launchedBy: "agent",
    resultSummary: "Collected supporting evidence.",
    createdAt: "2026-03-16T11:59:05.000Z",
    updatedAt: "2026-03-16T12:00:20.000Z",
  });
  await store.upsertDelegation({
    delegationId: root.supersededDelegationId,
    parentThreadId: root.threadId,
    childThreadId: supersededChild.threadId,
    parentRunId: root.runId,
    childRunId: supersededChild.runId,
    title: "Superseded child investigation",
    prompt: "Investigate a branch that was later superseded.",
    status: "CANCELLED",
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
    launchedBy: "agent",
    resultSummary: "Superseded by a newer delegation branch.",
    createdAt: "2026-03-16T11:58:05.000Z",
    updatedAt: "2026-03-16T12:00:18.000Z",
  });

  const request: InteractionRequestRecord = {
    requestId: child.requestId,
    threadId: child.threadId,
    runId: child.runId,
    kind: "approval",
    status: "PENDING",
    eventType: "user.approval",
    delegationId: root.delegationId,
    waitKind: "approval",
    prompt: "Approve child thread before continuing.",
    metadata: {
      requestId: child.requestId,
      threadId: child.threadId,
      delegationId: root.delegationId,
      prompt: "Approve child thread before continuing.",
    },
    createdAt: "2026-03-16T12:00:10.000Z",
  };
  await store.upsertInteractionRequest(request);

  await seedThreadAssembly(store, {
    recordId: "ops-root-assembly-record",
    threadId: root.threadId,
    bundleId: "bundle:ops:root:downgraded",
    label: "Ops root runtime bundle",
    source: "runtime_derived",
    toolAllowlist: ["internet.search", "file.read"],
    specialistIds: [],
    contextPolicyId: "context.default",
    approvalPolicyId: "approval.turn",
    metadata: {
      modelProvider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      promptVariant: "reference-react:root",
      compatibilityProfile: "reference-default",
      compatibilityStatus: "downgraded",
      compatibilityDecisionSource: "policy",
      downgradeReason: "provider_variant_unavailable",
      capabilityLossReason: "structured_output_unavailable",
    },
    authority: "policy",
    cause: "capability_loss",
    createdAt: "2026-03-16T12:00:30.000Z",
    updatedAt: "2026-03-16T12:00:30.000Z",
  });

  await seedThreadAssembly(store, {
    recordId: "ops-approval-child-assembly-record",
    threadId: child.threadId,
    bundleId: "bundle:ops:approval-child:downgraded",
    label: "Ops approval runtime bundle",
    source: "runtime_derived",
    toolAllowlist: ["internet.search"],
    specialistIds: [],
    contextPolicyId: "context.default",
    approvalPolicyId: "approval.turn",
    metadata: {
      modelProvider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      promptVariant: "reference-react:approval",
      compatibilityProfile: "reference-default",
      compatibilityStatus: "downgraded",
      compatibilityDecisionSource: "policy",
      downgradeReason: "approval_prompt_variant_unavailable",
      capabilityLossReason: "structured_output_unavailable",
    },
    authority: "policy",
    cause: "capability_loss",
    createdAt: "2026-03-16T12:00:31.000Z",
    updatedAt: "2026-03-16T12:00:31.000Z",
  });

  await appendRunEvents(store, [
    runEvent(root.runId, root.sessionId, "delegation.spawned", "INFO", "2026-03-16T12:00:06.000Z", {
      delegationId: root.delegationId,
      childThreadId: child.threadId,
      status: "WAITING",
    }),
    runEvent(root.runId, root.sessionId, "delegation.waiting", "INFO", "2026-03-16T12:00:45.000Z", {
      delegationId: root.delegationId,
      childThreadId: child.threadId,
      status: "WAITING",
      waitEventType: "user.approval",
    }),
    runEvent(root.runId, root.sessionId, "delegation.completed", "INFO", "2026-03-16T12:00:20.000Z", {
      delegationId: root.completedDelegationId,
      childThreadId: completedChild.threadId,
      status: "COMPLETED",
      resultSummary: "Collected supporting evidence.",
    }),
    runEvent(root.runId, root.sessionId, "delegation.completed", "INFO", "2026-03-16T12:00:18.000Z", {
      delegationId: root.supersededDelegationId,
      childThreadId: supersededChild.threadId,
      status: "CANCELLED",
      resultSummary: "Superseded by a newer delegation branch.",
    }),
    runEvent(child.runId, child.sessionId, "interaction.requested", "INFO", "2026-03-16T12:00:10.000Z", {
      threadId: child.threadId,
      runId: child.runId,
      requestId: child.requestId,
      delegationId: root.delegationId,
      kind: "approval",
    }),
    runEvent(child.runId, child.sessionId, "wait.entered", "INFO", "2026-03-16T12:00:11.000Z", {
      threadId: child.threadId,
      runId: child.runId,
      requestId: child.requestId,
      delegationId: root.delegationId,
      kind: "approval",
      eventType: "user.approval",
      prompt: "Approve child thread before continuing.",
    }),
    runEvent(child.runId, child.sessionId, "run.waiting", "INFO", "2026-03-16T12:00:12.000Z", {
      threadId: child.threadId,
      runId: child.runId,
      requestId: child.requestId,
      delegationId: root.delegationId,
      kind: "approval",
      eventType: "user.approval",
    }),
  ]);
}

async function seedDelegationFailure(store: SessionStore): Promise<void> {
  const root = OPS_FIXTURE_IDS.failureRoot;
  const child = OPS_FIXTURE_IDS.failureChild;

  await ensureRun(store, root.sessionId, root.runId, "user.message", "WAITING", "2026-03-16T12:10:00.000Z");
  await ensureRun(store, child.sessionId, child.runId, "user.message", "FAILED", "2026-03-16T12:10:05.000Z", {
    code: "DELEGATION_CHILD_FAILED",
    message: "Child execution failed.",
    details: {
      childThreadId: child.threadId,
    },
  });

  await store.upsertThread(thread({
    threadId: root.threadId,
    sessionId: root.sessionId,
    title: "Failure parent",
    status: "WAITING",
    activeRunId: root.runId,
    createdAt: "2026-03-16T12:10:00.000Z",
    updatedAt: "2026-03-16T12:10:40.000Z",
  }));
  await store.upsertThread(thread({
    threadId: child.threadId,
    sessionId: child.sessionId,
    title: "Failure child",
    status: "FAILED",
    parentThreadId: root.threadId,
    activeRunId: child.runId,
    lastRunStatus: "FAILED",
    createdAt: "2026-03-16T12:10:05.000Z",
    updatedAt: "2026-03-16T12:10:30.000Z",
  }));

  await store.upsertDelegation({
    delegationId: root.delegationId,
    parentThreadId: root.threadId,
    childThreadId: child.threadId,
    parentRunId: root.runId,
    childRunId: child.runId,
    title: "Investigate failed child",
    prompt: "Investigate and report failure.",
    status: "FAILED",
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
    launchedBy: "agent",
    errorMessage: "Child execution failed.",
    createdAt: "2026-03-16T12:10:05.000Z",
    updatedAt: "2026-03-16T12:10:40.000Z",
  });

  await appendRunEvents(store, [
    runEvent(root.runId, root.sessionId, "delegation.failed", "WARN", "2026-03-16T12:10:40.000Z", {
      delegationId: root.delegationId,
      childThreadId: child.threadId,
      status: "FAILED",
      errorMessage: "Child execution failed.",
      errorCode: "DELEGATION_CHILD_FAILED",
    }),
    runEvent(child.runId, child.sessionId, "run.failed", "ERROR", "2026-03-16T12:10:30.000Z", {
      threadId: child.threadId,
      runId: child.runId,
    }),
    runEvent(child.runId, child.sessionId, "terminal.normalized", "INFO", "2026-03-16T12:10:31.000Z", {
      status: "FAILED",
      reasonCode: "DELEGATION_CHILD_FAILED",
      threadId: child.threadId,
    }),
  ]);
}

async function seedCompaction(store: SessionStore): Promise<void> {
  const compaction = OPS_FIXTURE_IDS.compaction;

  await ensureRun(store, compaction.sessionId, compaction.runId, "user.message", "COMPLETED", "2026-03-16T12:20:00.000Z");

  await store.upsertThread(thread({
    threadId: compaction.threadId,
    sessionId: compaction.sessionId,
    title: "Compaction thread",
    status: "COMPLETED",
    activeRunId: compaction.runId,
    lastRunStatus: "COMPLETED",
    createdAt: "2026-03-16T12:20:00.000Z",
    updatedAt: "2026-03-16T12:20:20.000Z",
  }));

  await store.saveContextSummaryArtifact({
    artifactId: compaction.artifactId,
    threadId: compaction.threadId,
    runId: compaction.runId,
    summary: "Compacted summary for operator inspection.",
    source: "auto_compaction",
    metadata: {
      sourceSignals: {
        evidenceRecovery: {
          attempts: 4,
          lowSignalAttempts: 2,
          consecutiveLowSignal: 1,
          broadenedSearchUsed: true,
          targetedFetchUsed: true,
          latest: {
            quality: "mixed",
            issues: ["source_coverage_gap"],
          },
        },
      },
    },
    createdAt: "2026-03-16T12:20:10.000Z",
  });
  await store.appendThreadCompactionEvent({
    eventId: "ops-compaction-event",
    threadId: compaction.threadId,
    runId: compaction.runId,
    action: "compact",
    reason: "Context budget exceeded",
    summaryArtifactId: compaction.artifactId,
    metadata: {
      sourceSignals: {
        evidenceRecovery: {
          attempts: 4,
          lowSignalAttempts: 2,
          consecutiveLowSignal: 1,
          broadenedSearchUsed: true,
          targetedFetchUsed: true,
          latest: {
            quality: "mixed",
            issues: ["source_coverage_gap"],
          },
        },
      },
    },
    createdAt: "2026-03-16T12:20:11.000Z",
  });

  await appendRunEvents(store, [
    runEvent(compaction.runId, compaction.sessionId, "context.compaction_applied", "INFO", "2026-03-16T12:20:11.000Z", {
      threadId: compaction.threadId,
      runId: compaction.runId,
      summaryArtifactId: compaction.artifactId,
    }),
    runEvent(compaction.runId, compaction.sessionId, "run.completed", "INFO", "2026-03-16T12:20:20.000Z", {
      threadId: compaction.threadId,
      runId: compaction.runId,
    }),
    runEvent(compaction.runId, compaction.sessionId, "terminal.normalized", "INFO", "2026-03-16T12:20:21.000Z", {
      status: "COMPLETED",
      threadId: compaction.threadId,
    }),
  ]);
}

async function seedUserInputWait(store: SessionStore): Promise<void> {
  const userInput = OPS_FIXTURE_IDS.userInput;

  await ensureRun(store, userInput.sessionId, userInput.runId, "user.message", "WAITING", "2026-03-16T12:30:00.000Z");
  await store.upsertThread(thread({
    threadId: userInput.threadId,
    sessionId: userInput.sessionId,
    title: "User input wait",
    status: "WAITING",
    activeRunId: userInput.runId,
    currentRequestId: userInput.requestId,
    lastRunStatus: "WAITING",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        prompt: "Clarify the target report format.",
      },
    },
    createdAt: "2026-03-16T12:30:00.000Z",
    updatedAt: "2026-03-16T12:30:15.000Z",
  }));

  await store.upsertInteractionRequest({
    requestId: userInput.requestId,
    threadId: userInput.threadId,
    runId: userInput.runId,
    kind: "user_input",
    status: "PENDING",
    eventType: "user.reply",
    waitKind: "user",
    prompt: "Clarify the target report format.",
    createdAt: "2026-03-16T12:30:05.000Z",
  });

  await appendRunEvents(store, [
    runEvent(userInput.runId, userInput.sessionId, "interaction.requested", "INFO", "2026-03-16T12:30:05.000Z", {
      threadId: userInput.threadId,
      runId: userInput.runId,
      requestId: userInput.requestId,
      kind: "user_input",
    }),
    runEvent(userInput.runId, userInput.sessionId, "run.waiting", "INFO", "2026-03-16T12:30:06.000Z", {
      threadId: userInput.threadId,
      runId: userInput.runId,
      requestId: userInput.requestId,
      kind: "user",
      eventType: "user.reply",
    }),
  ]);
}

async function seedModeBlocked(store: SessionStore): Promise<void> {
  const blocked = OPS_FIXTURE_IDS.modeBlocked;

  await ensureRun(store, blocked.sessionId, blocked.runId, "user.message", "WAITING", "2026-03-16T12:35:00.000Z");
  await store.upsertThread(thread({
    threadId: blocked.threadId,
    sessionId: blocked.sessionId,
    title: "Mode blocked",
    status: "WAITING",
    activeRunId: blocked.runId,
    lastRunStatus: "WAITING",
    waitFor: {
      kind: "user",
      eventType: "user.mode_switch",
      metadata: {
        reason: "route_mode_blocked",
        requiredToolClass: "sandboxed_only",
        prompt: "Switch to Build to continue.",
      },
    },
    createdAt: "2026-03-16T12:35:00.000Z",
    updatedAt: "2026-03-16T12:35:10.000Z",
  }));

  await appendRunEvents(store, [
    runEvent(blocked.runId, blocked.sessionId, "wait.entered", "INFO", "2026-03-16T12:35:05.000Z", {
      threadId: blocked.threadId,
      runId: blocked.runId,
      kind: "user",
      eventType: "user.mode_switch",
      reason: "route_mode_blocked",
      requiredToolClass: "sandboxed_only",
      prompt: "Switch to Build to continue.",
    }),
    runEvent(blocked.runId, blocked.sessionId, "run.waiting", "INFO", "2026-03-16T12:35:06.000Z", {
      threadId: blocked.threadId,
      runId: blocked.runId,
      kind: "user",
      eventType: "user.mode_switch",
    }),
  ]);
}

async function seedStalledRun(store: SessionStore): Promise<void> {
  const stalled = OPS_FIXTURE_IDS.stalled;

  await ensureRun(store, stalled.sessionId, stalled.runId, "user.message", "RUNNING", "2026-03-16T11:00:00.000Z");
  await store.upsertThread(thread({
    threadId: stalled.threadId,
    sessionId: stalled.sessionId,
    title: "Stalled thread",
    status: "RUNNING",
    activeRunId: stalled.runId,
    createdAt: "2026-03-16T11:00:00.000Z",
    updatedAt: "2026-03-16T11:02:00.000Z",
  }));

  await appendRunEvents(store, [
    runEvent(stalled.runId, stalled.sessionId, "run.started", "INFO", "2026-03-16T11:00:00.000Z", {
      threadId: stalled.threadId,
      runId: stalled.runId,
    }),
    runEvent(stalled.runId, stalled.sessionId, "step.selected", "INFO", "2026-03-16T11:01:00.000Z", {
      threadId: stalled.threadId,
      runId: stalled.runId,
      step: "react.exec.stalled",
    }),
  ]);
}

async function ensureRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
  eventType: RuntimeEvent["type"],
  status: NormalizedOutput["status"] | "RUNNING",
  startedAt: string,
  error?: RuntimeError | undefined,
): Promise<void> {
  await store.ensureSession(sessionId, "react.exec.inspect");
  await store.startRun(runId, {
    id: `evt-${runId}-start`,
    type: eventType,
    sessionId,
    payload: {
      runId,
    },
    timestamp: startedAt,
  });
  await store.appendRunEvent(runEvent(runId, sessionId, "run.started", "INFO", startedAt, {
    runId,
    sessionId,
  }));
  if (status !== "RUNNING") {
    await store.completeRun(runId, status, error);
  }
}

function thread(input: ThreadRecord): ThreadRecord {
  return input;
}

function runEvent(
  runId: string,
  sessionId: string,
  type: RunEvent["type"],
  level: RunEvent["level"],
  timestamp: string,
  metadata?: Record<string, unknown> | undefined,
): RunEvent {
  return {
    runId,
    sessionId,
    type,
    level,
    timestamp,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

async function appendRunEvents(store: SessionStore, events: RunEvent[]): Promise<void> {
  for (const event of events) {
    await store.appendRunEvent(event);
  }
}

async function seedThreadAssembly(
  store: SessionStore,
  input: AssemblyBundleRecord &
    Pick<ThreadAssemblyRecord, "recordId" | "threadId" | "authority" | "cause">,
): Promise<void> {
  const bundle: AssemblyBundleRecord = {
    bundleId: input.bundleId,
    label: input.label,
    source: input.source,
    toolAllowlist: input.toolAllowlist,
    specialistIds: input.specialistIds,
    ...(input.contextPolicyId !== undefined ? { contextPolicyId: input.contextPolicyId } : {}),
    ...(input.approvalPolicyId !== undefined ? { approvalPolicyId: input.approvalPolicyId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  await store.upsertAssemblyBundle(bundle);

  const record: ThreadAssemblyRecord = {
    recordId: input.recordId,
    threadId: input.threadId,
    bundleId: input.bundleId,
    authority: input.authority,
    cause: input.cause,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt,
  };
  await store.appendThreadAssemblyRecord(record);
}
