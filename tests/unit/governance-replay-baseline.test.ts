import test from "node:test";
import assert from "node:assert/strict";

import {
  diffCapturedReplayBundle,
  diffReplayAgainstBaseline,
} from "../../src/governance/replayBaseline.js";
import type { CapturedReplayBundle, ReplayBaseline } from "../../src/governance/contracts.js";

test("diffReplayAgainstBaseline catches missing strict events", () => {
  const baseline: ReplayBaseline = {
    scenario_id: "s1",
    strict_events: ["step.selected", "terminal.normalized"],
    expected_terminal_status: "COMPLETED",
    tolerant_metrics: {
      stepsObservedDelta: 0,
    },
    approved_at: "2026-03-12",
  };

  const violations = diffReplayAgainstBaseline({
    baseline,
    events: ["step.selected"],
    summary: {
      eventCount: 1,
      stepsObserved: 1,
      regionsStarted: 0,
      regionsCompleted: 0,
      syncNodesHit: 0,
      mergeConflicts: 0,
      progressStages: 0,
      progressToolCalls: 0,
      waitingMilestones: 0,
      heartbeatLiveOnlyCount: 0,
      schedulerActions: 0,
      waitsEntered: 0,
      waitsResumed: 0,
      loopGuards: 0,
      terminalStatus: "FAILED",
      truncated: false,
    },
    previousSummary: {
      eventCount: 2,
      stepsObserved: 1,
      regionsStarted: 0,
      regionsCompleted: 0,
      syncNodesHit: 0,
      mergeConflicts: 0,
      progressStages: 0,
      progressToolCalls: 0,
      waitingMilestones: 0,
      heartbeatLiveOnlyCount: 0,
      schedulerActions: 0,
      waitsEntered: 0,
      waitsResumed: 0,
      loopGuards: 0,
      truncated: false,
    },
    errorCodes: [],
  });

  assert.equal(violations.length > 0, true);
});

test("diffReplayAgainstBaseline enforces expected error codes", () => {
  const baseline: ReplayBaseline = {
    scenario_id: "s2",
    strict_events: ["terminal.normalized"],
    expected_error_codes: ["DECISION_CAPABILITY_UNAVAILABLE"],
    tolerant_metrics: {},
    approved_at: "2026-03-12",
  };

  const violations = diffReplayAgainstBaseline({
    baseline,
    events: ["terminal.normalized"],
    summary: {
      eventCount: 1,
      stepsObserved: 1,
      regionsStarted: 0,
      regionsCompleted: 0,
      syncNodesHit: 0,
      mergeConflicts: 0,
      progressStages: 0,
      progressToolCalls: 0,
      waitingMilestones: 0,
      heartbeatLiveOnlyCount: 0,
      schedulerActions: 0,
      waitsEntered: 0,
      waitsResumed: 0,
      loopGuards: 0,
      truncated: false,
    },
    previousSummary: {
      eventCount: 1,
      stepsObserved: 1,
      regionsStarted: 0,
      regionsCompleted: 0,
      syncNodesHit: 0,
      mergeConflicts: 0,
      progressStages: 0,
      progressToolCalls: 0,
      waitingMilestones: 0,
      heartbeatLiveOnlyCount: 0,
      schedulerActions: 0,
      waitsEntered: 0,
      waitsResumed: 0,
      loopGuards: 0,
      truncated: false,
    },
    errorCodes: [],
  });

  assert.equal(violations.some((violation) => violation.field === "errorCodes"), true);
});

test("diffCapturedReplayBundle enforces required browser artifact inventory", () => {
  const bundle: CapturedReplayBundle = {
    manifest: {
      flow_id: "research.evidence.happy.mock",
      source_behavior_id: "research.evidence.happy",
      source_mode: "mock",
      baseline_class: "browser",
      strict_events: ["step.selected", "terminal.normalized"],
      expected_terminal_status: "COMPLETED",
      tolerant_metrics: {},
      expected_artifacts: {
        required_snapshot_types: ["dom", "screenshot"],
        min_count: 2,
      },
      approved_at: "2026-03-12",
    },
    current: {
      events: ["step.selected", "terminal.normalized"],
      summary: {
        eventCount: 2,
        stepsObserved: 1,
        regionsStarted: 0,
        regionsCompleted: 0,
        syncNodesHit: 0,
        mergeConflicts: 0,
        progressStages: 0,
        progressToolCalls: 0,
        waitingMilestones: 0,
        heartbeatLiveOnlyCount: 0,
        schedulerActions: 0,
        waitsEntered: 0,
        waitsResumed: 0,
        loopGuards: 0,
        terminalStatus: "COMPLETED",
        truncated: false,
      },
      uiEvidenceArtifacts: [],
    },
    previous: {
      summary: {
        eventCount: 2,
        stepsObserved: 1,
        regionsStarted: 0,
        regionsCompleted: 0,
        syncNodesHit: 0,
        mergeConflicts: 0,
        progressStages: 0,
        progressToolCalls: 0,
        waitingMilestones: 0,
        heartbeatLiveOnlyCount: 0,
        schedulerActions: 0,
        waitsEntered: 0,
        waitsResumed: 0,
        loopGuards: 0,
        terminalStatus: "COMPLETED",
        truncated: false,
      },
    },
  };

  const violations = diffCapturedReplayBundle({
    bundle,
    events: bundle.current.events,
    summary: bundle.current.summary,
    uiEvidenceArtifacts: [
      {
        flow_id: bundle.manifest.flow_id,
        snapshot_type: "dom",
        capture_phase: "post-finalize",
        selector_assertions: [],
        artifact_path: ".kestrel/artifacts/example.html",
        result: "passed",
      },
    ],
  });

  assert.equal(
    violations.some((violation) => violation.field.startsWith("artifacts.")),
    true,
  );
});
