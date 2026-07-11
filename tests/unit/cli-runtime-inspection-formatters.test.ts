import assert from "node:assert/strict";
import test from "node:test";

import { formatDoctorInspection, formatReplayInspection } from "../../cli/runtime/inspectionFormatting.js";
import type { ReplayDoctorReport, ReplayResult } from "../../src/replay/RunReplayService.js";

test("formatReplayInspection renders approvals, delegations, compaction, and grouped transitions", () => {
  const replay = {
    summary: {
      runId: "run-parent",
      sessionId: "thread-parent",
      eventCount: 3,
      truncated: false,
      terminalStatus: "WAITING",
    },
    lineage: {
      focusThread: { threadId: "thread-child" },
      focusDelegation: { delegationId: "delegation-1" },
      childThreads: [
        {
          threadId: "thread-child",
          status: "WAITING",
          waitFor: {
            eventType: "user.approval",
          },
        },
        {
          threadId: "thread-complete",
          status: "COMPLETED",
        },
      ],
    },
    waits: {
      active: {
        kind: "approval",
        status: "active",
        actionable: true,
        requestId: "request-1",
        grantId: "grant-1",
        detail: "Need approval.",
        lineage: [],
      },
      history: [],
    },
    assembly: {
      mode: "explicit",
      active: {
        record: {
          bundleId: "bundle:reference:child",
          authority: "policy",
          cause: "thread_start",
        },
        bundle: {
          label: "Child runtime",
        },
      },
      history: [],
      proposals: [],
      decisions: [
        {
          proposalId: "assembly-proposal-1",
          result: "APPROVAL_REQUIRED",
          decidedBy: "policy",
        },
      ],
      specialists: [],
      contextPolicies: [],
    },
    compatibility: {
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      promptVariant: "reference-react:act",
      profile: "reference-react",
      status: "compatible",
      decisionSource: "profile",
    },
    adaptation: {
      status: "auto_applied",
      recommendedAction: "compact",
      reason: "Context pressure exceeded budget.",
      eventId: "compaction-event-1",
      summaryArtifactId: "summary-1",
      at: "2026-03-16T12:00:03.000Z",
    },
    evidenceRecovery: {
      attempts: 4,
      lowSignalAttempts: 2,
      consecutiveLowSignal: 1,
      broadenedSearchUsed: true,
      targetedFetchUsed: true,
      latestQuality: "mixed",
      latestIssues: ["coverage_gap"],
      terminalOutcome: "soft_finalize",
    },
    runtimePlan: {
      phase: "ACT",
      currentChunk: "waiting for approval",
      status: "waiting",
      expectedNextCommand: "agent.exec.wait_approval",
      waitReason: "Approve fs.write_text?",
      commandBatchId: "command-batch-12-tool",
      executionMode: "ordered_checkpoint",
      commandNames: ["fs.write_text"],
      lastCheckpoint: {
        substate: "wait_approval",
      },
      latestNarration: {
        stepAgent: "agent.exec.dispatch",
        latest: "I paused execution at the approval boundary.",
        waitingOn: "Approve fs.write_text?",
        next: "Once approval arrives, I will resume the command.",
      },
    },
    approvals: [
      {
        request: { requestId: "request-1" },
        grants: [{ grantId: "grant-1" }],
        latestGrant: { grantId: "grant-1" },
        status: "granted",
        actionable: true,
      },
    ],
    delegations: [
      {
        delegation: { delegationId: "delegation-1", status: "WAITING" },
        childThread: { threadId: "thread-child" },
        milestones: [{ seq: 1 }],
      },
      {
        delegation: { delegationId: "delegation-2", status: "CANCELLED", childThreadId: "thread-complete" },
        childThread: { threadId: "thread-complete" },
        milestones: [{ seq: 1 }],
      },
    ],
    supervision: {
      groups: [
        {
          groupId: "supervision:thread-parent",
          childOutcomes: [
            {
              delegationId: "delegation-1",
              parentThreadId: "thread-parent",
              childThreadId: "thread-child",
              status: "WAITING",
              resultState: "blocked",
              reason: "Awaiting approval.",
            },
            {
              delegationId: "delegation-2",
              parentThreadId: "thread-parent",
              childThreadId: "thread-complete",
              status: "CANCELLED",
              resultState: "superseded",
              summary: "Superseded by a newer delegation branch.",
            },
          ],
          fanInDecisions: [
            {
              at: "2026-03-16T12:00:04.000Z",
              eventType: "supervision.fan_in_pending",
              decision: "pending_checkpoint",
              groupId: "supervision:thread-parent",
              reason: "Awaiting operator review.",
            },
          ],
          dominantBlocker: {
            delegationId: "delegation-1",
            childThreadId: "thread-child",
            status: "WAITING",
            reason: "Awaiting approval.",
            groupId: "supervision:thread-parent",
          },
        },
      ],
      fanInDecisions: [],
      dominantBlocker: {
        delegationId: "delegation-1",
        childThreadId: "thread-child",
        status: "WAITING",
        reason: "Awaiting approval.",
        groupId: "supervision:thread-parent",
      },
      supersededLineage: [
        {
          delegationId: "delegation-2",
          supersededByDelegationId: "delegation-3",
          supersededAt: "2026-03-16T12:00:05.000Z",
        },
      ],
    },
    compaction: {
      summaries: [{ artifactId: "summary-1" }],
      events: [{ action: "compact" }],
      authoritativeSummary: { artifactId: "summary-1" },
      latestEvent: { action: "compact" },
    },
    groups: [
      {
        seq: 1,
        at: "2026-03-16T12:00:00.000Z",
        kind: "approval",
        label: "interaction requested",
        eventTypes: ["interaction.requested"],
        source: "event",
        runId: "run-parent",
      },
    ],
  } as unknown as ReplayResult;

  const lines = formatReplayInspection(replay);

  assert.equal(lines[0], "thread=thread-child delegation=delegation-1 run=run-parent session=thread-parent");
  assert.ok(lines.some((line) => line.includes("activeWait kind=approval")));
  assert.ok(lines.some((line) => line.includes("children total=2 active=1 waiting=1 completed=1 failed=0 superseded=1")));
  assert.ok(lines.some((line) => line.includes("supersededChildren thread-complete")));
  assert.ok(lines.some((line) => line.includes("supervision group=supervision:thread-parent children=2 fanInDecisions=1 dominantBlocker=thread-child")));
  assert.ok(lines.some((line) => line.includes("supervisionChild group=supervision:thread-parent delegationId=delegation-1 childThread=thread-child result=blocked")));
  assert.ok(lines.some((line) => line.includes("fanIn group=supervision:thread-parent decision=pending_checkpoint")));
  assert.ok(lines.some((line) => line.includes("assembly bundle=bundle:reference:child")));
  assert.ok(lines.some((line) => line.includes("assemblyDecision proposalId=assembly-proposal-1 result=APPROVAL_REQUIRED")));
  assert.ok(lines.some((line) => line.includes("compatibility provider=openrouter model=google/gemini-3.1-flash-lite-preview")));
  assert.ok(lines.some((line) => line.includes("adaptation status=auto_applied action=compact")));
  assert.ok(lines.some((line) => line.includes("evidenceRecovery attempts=4 lowSignal=2")));
  assert.ok(lines.some((line) => line.includes("runtimeExecution phase=ACT status=waiting")));
  assert.ok(lines.some((line) => line.includes("batch=command-batch-12-tool")));
  assert.ok(lines.some((line) => line.includes("runtimeNarration step=agent.exec.dispatch")));
  assert.ok(lines.some((line) => line.includes("approval requestId=request-1 status=granted")));
  assert.ok(lines.some((line) => line.includes("delegation id=delegation-1 status=WAITING")));
  assert.ok(lines.some((line) => line.includes("contextCompaction summary=summary-1 action=compact")));
  assert.ok(lines.some((line) => line.includes("[approval] interaction requested")));
});

test("formatDoctorInspection renders blocking, dominant failure, and child blocker details", () => {
  const report = {
    focus: {
      threadId: "thread-child",
      delegationId: "delegation-1",
      runId: "run-child",
      sessionId: "thread-child",
    },
    status: "WAITING",
    finalStep: "agent.exec.wait_approval",
    wait: {
      kind: "approval",
      eventType: "user.approval",
      requestId: "request-1",
      grantId: "grant-1",
      lineage: ["entered"],
    },
    blockingResource: {
      kind: "approval",
      actionable: true,
      requestId: "request-1",
      grantId: "grant-1",
      delegationId: "delegation-1",
      detail: "Awaiting approval.",
    },
    lastMeaningfulProgress: {
      kind: "delegation",
      label: "delegation waiting",
    },
    childBlocker: {
      delegationId: "delegation-1",
      childThreadId: "thread-child",
      status: "WAITING",
      reason: "Awaiting approval.",
    },
    dominantChildBlocker: {
      delegationId: "delegation-1",
      childThreadId: "thread-child",
      status: "WAITING",
      reason: "Awaiting approval.",
      groupId: "supervision:thread-child",
    },
    scheduler: {
      claims: 0,
      spawns: 1,
      syncs: 0,
      waits: 1,
      lastAction: "region.scheduler.waiting",
    },
    loops: [],
    dominantFailure: {
      classification: "approval_wait",
      message: "Run is blocked on operator approval.",
    },
    activeAssembly: {
      mode: "explicit",
      bundleId: "bundle:reference:child",
      label: "Child runtime",
      authority: "policy",
      cause: "proposal",
      toolAllowlist: ["fs.read_text", "web.search"],
      specialistIds: [],
      latestDecisionResult: "APPROVAL_REQUIRED",
      provider: {
        id: "openrouter",
        model: "google/gemini-3.1-flash-lite-preview",
        promptVariant: "reference-react:act",
      },
      compatibility: {
        status: "downgraded",
        decisionSource: "runtime",
        capabilityLossReason: "Capabilities narrowed after tool loss: web.search",
      },
    },
    compatibility: {
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite-preview",
      promptVariant: "reference-react:act",
      profile: "reference-react",
      status: "downgraded",
      decisionSource: "runtime",
      capabilityLossReason: "Capabilities narrowed after tool loss: web.search",
    },
    latestReasoning: {
      at: "2026-03-16T12:00:01.000Z",
      message: "Waiting for operator approval before continuing child execution.",
      runId: "run-child",
    },
    latestAdaptation: {
      status: "pending_checkpoint",
      recommendedAction: "handoff",
      reason: "Provider context limits reached.",
      checkpointId: "checkpoint-1",
      at: "2026-03-16T12:00:02.000Z",
    },
    latestEvidenceRecovery: {
      attempts: 5,
      lowSignalAttempts: 3,
      consecutiveLowSignal: 2,
      broadenedSearchUsed: true,
      targetedFetchUsed: false,
      latestQuality: "low",
      latestIssues: ["source_diversity_low"],
      terminalOutcome: "handoff_fallback",
    },
    runtimePlan: {
      phase: "ACT",
      currentChunk: "waiting for approval",
      status: "waiting",
      expectedNextCommand: "agent.exec.wait_approval",
      waitReason: "Approve fs.write_text?",
      commandBatchId: "command-batch-12-tool",
      executionMode: "ordered_checkpoint",
      commandNames: ["fs.write_text"],
      latestNarration: {
        stepAgent: "agent.exec.dispatch",
        latest: "I paused execution at the approval boundary.",
        waitingOn: "Approve fs.write_text?",
      },
    },
    actionable: true,
  } as unknown as ReplayDoctorReport;

  const lines = formatDoctorInspection(report);

  assert.equal(lines[0], "status=WAITING finalStep=agent.exec.wait_approval");
  assert.ok(lines.some((line) => line === "actionable=yes"));
  assert.ok(lines.some((line) => line.includes("blocking kind=approval")));
  assert.ok(lines.some((line) => line.includes("assembly mode=explicit bundle=bundle:reference:child")));
  assert.ok(lines.some((line) => line.includes("assemblyProvider provider=openrouter model=google/gemini-3.1-flash-lite-preview")));
  assert.ok(lines.some((line) => line.includes("assemblyCompatibility status=downgraded source=runtime")));
  assert.ok(lines.some((line) => line.includes("compatibility provider=openrouter model=google/gemini-3.1-flash-lite-preview")));
  assert.ok(lines.some((line) => line.includes("classification=approval_wait")));
  assert.ok(lines.some((line) => line.includes("latestReasoning at=2026-03-16T12:00:01.000Z")));
  assert.ok(lines.some((line) => line.includes("latestAdaptation status=pending_checkpoint action=handoff")));
  assert.ok(lines.some((line) => line.includes("latestEvidenceRecovery attempts=5 lowSignal=3")));
  assert.ok(lines.some((line) => line.includes("runtimeExecution phase=ACT status=waiting")));
  assert.ok(lines.some((line) => line.includes("runtimeNarration step=agent.exec.dispatch")));
  assert.ok(lines.some((line) => line.includes("lastProgress kind=delegation")));
  assert.ok(lines.some((line) => line.includes("childBlocker delegationId=delegation-1")));
  assert.ok(lines.some((line) => line.includes("dominantChildBlocker delegationId=delegation-1 childThreadId=thread-child status=WAITING group=supervision:thread-child")));
});
