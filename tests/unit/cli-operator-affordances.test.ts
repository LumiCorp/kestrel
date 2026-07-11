import test from "node:test";
import assert from "node:assert/strict";

import type { NormalizedOutput } from "../../src/index.js";
import { buildRuntimeOperatorAffordance } from "../../src/orchestration/OperatorAffordanceProjection.js";
import {
  decorateOperatorAffordance,
  formatOperatorAffordance,
} from "../../cli/runtime/operatorAffordances.js";
import type { TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";

const baseProfile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "ref",
  modelProvider: "openrouter",
};

const baseSession: TuiSessionMeta = {
  name: "default",
  sessionId: "session-1",
  profileId: "reference",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  interactionMode: "plan",
  started: false,
};

function createOutput(waitFor?: NormalizedOutput["waitFor"]): NormalizedOutput {
  return {
    status: waitFor !== undefined ? "WAITING" : "COMPLETED",
    sessionId: "session-1",
    runId: "run-1",
    ...(waitFor !== undefined ? { waitFor } : {}),
    errors: [],
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
  };
}

test("buildRuntimeOperatorAffordance surfaces blocked wait reasons and compacted context", () => {
  const affordance = buildRuntimeOperatorAffordance({
    reactState: {
      interactionMode: "plan",
      contextCache: {
        contextTelemetry: {
          promptBudgetChars: 12000,
          estimatedChars: 8200,
          degradationMode: "compact",
          droppedSections: ["recentConversation.full"],
          manualCompactionApplied: true,
        },
      },
    },
    turn: {
      interactionMode: "plan",
    },
    output: createOutput({
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "route_mode_blocked",
        requiredToolClass: "sandboxed_only",
        toolName: "code.execute",
        question: "You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
        resumeReply: "switch to build",
        resumeCommand: "/mode build",
        prompt: [
          "Question: You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
          "Reply naturally to approve the switch, name the mode, or run: `/mode build`",
          "The run will resume automatically.",
        ].join("\n"),
      },
    }),
  });

  assert.deepEqual(affordance.allowedToolClasses, ["read_only", "planning_write"]);
  assert.equal(affordance.blockReason?.code, "route_mode_blocked");
  assert.match(String(affordance.blockReason?.summary), /sandboxed_only/);
  assert.equal(affordance.context?.manualCompactionApplied, true);
  assert.equal(affordance.wait?.eventType, "user.reply");
  assert.equal(
    affordance.wait?.prompt,
    "You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
  );
  assert.equal(
    affordance.wait?.detail,
    "Reply naturally to approve the switch, name the mode, or run: `/mode build`",
  );
});

test("buildRuntimeOperatorAffordance treats acter-blocked waits as mode switches", () => {
  const affordance = buildRuntimeOperatorAffordance({
    reactState: {
      interactionMode: "build",
      actSubmode: "safe",
    },
    turn: {
      interactionMode: "build",
      actSubmode: "safe",
    },
    output: createOutput({
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "acter_mode_blocked",
        requiredToolClass: "external_side_effect",
        toolName: "effect:user_message",
      },
    }),
  });

  assert.equal(affordance.blockReason?.code, "acter_mode_blocked");
  assert.match(String(affordance.blockReason?.summary), /external_side_effect/);
  assert.equal(affordance.recommendedAction?.code, "switch_mode");
  assert.match(String(affordance.recommendedAction?.summary), /Reply naturally to approve the switch/u);
});

test("decorateOperatorAffordance enriches provider, skill pack, and manual compaction state", () => {
  const decorated = decorateOperatorAffordance({
    base: {
      interactionMode: "build",
      actSubmode: "safe",
      allowedToolClasses: ["read_only", "sandboxed_only"],
    },
    profile: {
      ...baseProfile,
      modelProvider: "openai",
      model: "gpt-5.4-2026-03-05",
    },
    session: {
      ...baseSession,
      interactionMode: "build",
      actSubmode: "safe",
      activeSkillPackId: "research",
      pendingManualCompaction: true,
      started: true,
    },
    skillPack: {
      id: "research",
      label: "Research",
      instructions: ["Prefer current evidence."],
      allowedTools: ["internet.search"],
    },
  });

  assert.equal(decorated.provider?.id, "openai");
  assert.equal(decorated.provider?.model, "gpt-5.4-2026-03-05");
  assert.equal(decorated.activeSkillPack?.id, "research");
  assert.equal(decorated.context?.manualCompactionArmed, true);
  assert.doesNotMatch(formatOperatorAffordance(decorated).join("\n"), /MCP profile/u);
});

test("decorateOperatorAffordance preserves runtime tool classes when runtime state is authoritative", () => {
  const decorated = decorateOperatorAffordance({
    base: {
      interactionMode: "build",
      actSubmode: "safe",
      allowedToolClasses: ["read_only"],
      blockReason: {
        code: "route_mode_blocked",
        summary: "blocked",
      },
      assembly: {
        mode: "explicit",
        threadId: "session-1",
        bundleId: "bundle:reference:default",
        label: "Reference default",
        provider: {
          id: "openrouter",
          model: "google/gemini-3.1-flash-lite-preview",
          promptVariant: "reference-react:act",
        },
        compatibility: {
          status: "compatible",
          decisionSource: "profile",
        },
      },
      latestReasoning: {
        message: "Confirming the next safe action before using tools.",
        at: "2026-03-17T12:00:00.000Z",
        runId: "run-1",
      },
    },
    runtimeAuthoritative: true,
    profile: baseProfile,
    session: {
      ...baseSession,
      interactionMode: "build",
      actSubmode: "safe",
      executionPolicy: {
        toolClassPolicy: {
          read_only: false,
          sandboxed_only: true,
          external_side_effect: false,
        },
      },
      started: true,
    },
  });

  assert.deepEqual(decorated.allowedToolClasses, ["read_only"]);
  assert.equal(decorated.blockReason?.code, "route_mode_blocked");
  const rendered = formatOperatorAffordance(decorated).join("\n");
  assert.match(rendered, /Assembly provider: openrouter\/google\/gemini-3.1-flash-lite-preview/u);
  assert.match(rendered, /Reasoning: Confirming the next safe action before using tools\./u);
});

test("formatOperatorAffordance includes focused thread, blocker, and next action parity fields", () => {
  const rendered = formatOperatorAffordance({
    interactionMode: "build",
    actSubmode: "safe",
    allowedToolClasses: ["read_only"],
    focusedThreadId: "thread-child",
    blockReason: {
      code: "delegation_wait",
      summary: "Parent thread is blocked by a waiting child agent.",
    },
    childBlocker: {
      delegationId: "delegation-1",
      childThreadId: "thread-grandchild",
      status: "WAITING",
      reason: "Waiting for user.reply",
    },
    childThreads: [
      {
        threadId: "thread-grandchild",
        title: "Waiting child",
        status: "WAITING",
        updatedAt: "2026-03-17T12:00:01.000Z",
        waitEventType: "user.reply",
        delegationId: "delegation-1",
        delegationStatus: "WAITING",
      },
      {
        threadId: "thread-completed",
        title: "Completed child",
        status: "COMPLETED",
        updatedAt: "2026-03-17T12:00:02.000Z",
        delegationId: "delegation-2",
        delegationStatus: "COMPLETED",
        outcomeSummary: "Collected evidence.",
      },
      {
        threadId: "thread-superseded",
        title: "Superseded child",
        status: "COMPLETED",
        updatedAt: "2026-03-17T12:00:03.000Z",
        delegationId: "delegation-3",
        delegationStatus: "CANCELLED",
        superseded: true,
      },
    ],
    childBlockerChainDetails: [
      {
        threadId: "thread-grandchild",
        title: "Waiting child",
        status: "WAITING",
        delegationId: "delegation-1",
        waitEventType: "user.reply",
        reason: "Waiting for user reply.",
      },
    ],
    latestCheckpoint: {
      checkpointId: "checkpoint-1",
      status: "PENDING",
      recommendedAction: "compact",
      reason: "Fan-in required before parent completion.",
    },
    latestCheckpointDisposition: "PENDING",
    latestFanInDisposition: {
      status: "pending_checkpoint",
      checkpointId: "checkpoint-1",
      summary: "Fan-in required before parent completion.",
    },
    recommendedAction: {
      code: "switch_thread",
      summary: "Open child thread to resolve the wait.",
    },
    latestAdaptation: {
      status: "pending_checkpoint",
      recommendedAction: "compact",
      reason: "Context pressure exceeded threshold.",
      at: "2026-03-17T12:00:00.000Z",
    },
    latestEvidenceRecovery: {
      attempts: 3,
      lowSignalAttempts: 2,
      consecutiveLowSignal: 1,
      broadenedSearchUsed: true,
      targetedFetchUsed: false,
      latestQuality: "low",
      latestIssues: ["missing_primary_sources"],
      terminalOutcome: "soft_finalize",
    },
    runtimePlan: {
      phase: "ACT",
      currentChunk: "waiting for approval",
      status: "waiting",
      expectedNextCommand: "agent.exec.wait_approval",
      waitReason: "Approve fs.write_text?",
      blocker: "Approve fs.write_text?",
      commandBatchId: "command-batch-12-tool",
      executionMode: "ordered_checkpoint",
      commandNames: ["fs.write_text"],
      lastCheckpoint: {
        substate: "wait_approval",
        currentStepAgent: "agent.exec.dispatch",
        nextStepAgent: "agent.exec.wait_approval",
        updatedAtStepIndex: 12,
      },
    },
    inbox: {
      total: 1,
      actionable: 1,
      approvals: 0,
      userInputs: 0,
      checkpoints: 0,
      childBlockers: 1,
      stalled: 0,
      assemblyProposals: 0,
      compatibilityAlerts: 0,
    },
  }).join("\n");

  assert.match(rendered, /Focused thread: thread-child/u);
  assert.match(rendered, /Child blocker: thread-grandchild via delegation-1/u);
  assert.match(rendered, /Children: total=3 active=1 waiting=1 completed=2 failed=0 cancelled=1/u);
  assert.match(rendered, /Child thread: thread-grandchild status=WAITING delegation=WAITING wait=user\.reply/u);
  assert.match(rendered, /Child thread: thread-completed status=COMPLETED delegation=COMPLETED outcome="Collected evidence."/u);
  assert.match(rendered, /Superseded child markers: thread-superseded/u);
  assert.match(rendered, /Fan-in checkpoint: compact \(PENDING\)/u);
  assert.match(rendered, /Recommended next action: Open child thread to resolve the wait\./u);
  assert.match(rendered, /Adaptation: pending_checkpoint action=compact @ 2026-03-17T12:00:00.000Z/u);
  assert.match(rendered, /Evidence recovery: attempts=3 lowSignal=2 consecutiveLowSignal=1 broadened=yes targetedFetch=no/u);
  assert.match(rendered, /Evidence issues: missing_primary_sources/u);
  assert.match(rendered, /Evidence terminal outcome: soft_finalize/u);
  assert.match(rendered, /Runtime execution: phase=ACT status=waiting chunk="waiting for approval"/u);
  assert.match(rendered, /Command batch: command-batch-12-tool mode=ordered_checkpoint commands=fs\.write_text/u);
  assert.match(rendered, /Wait reason: Approve fs\.write_text\?/u);
  assert.match(rendered, /Expected next command: agent\.exec\.wait_approval/u);
  assert.match(rendered, /Checkpoint route: agent\.exec\.dispatch -> agent\.exec\.wait_approval \(wait_approval\)/u);
});

test("decorateOperatorAffordance recomputes tool classes for session-only fallback state", () => {
  const decorated = decorateOperatorAffordance({
    base: {
      interactionMode: "build",
      actSubmode: "safe",
      allowedToolClasses: ["read_only", "sandboxed_only"],
    },
    profile: baseProfile,
    session: {
      ...baseSession,
      interactionMode: "plan",
      started: true,
    },
  });

  assert.deepEqual(decorated.allowedToolClasses, ["read_only", "planning_write"]);
});
