#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapturedReplayBundle, UiEvidenceArtifact } from "../src/governance/contracts.js";
import type { ReplaySummary } from "../src/replay/RunReplayService.js";

const SUITE_DIR = path.join(process.cwd(), "tests", "fixtures", "replay-suite");

const COMPLETED_EVENTS = [
  "run.started",
  "step.selected",
  "progress.stage",
  "step.started",
  "route.decision",
  "step.transitioned",
  "step.committed",
  "outbox.dispatched",
  "model.requested",
  "model.completed",
  "decision.generated",
  "decision.compiled",
  "region.scheduled",
  "region.scheduler.spawned",
  "region.scheduler.claimed",
  "region.started",
  "resolver.generated",
  "region.completed",
  "progress.tool",
  "tool.validated",
  "tool.queue.enqueued",
  "tool.queue.dequeued",
  "tool.chunk.started",
  "tool.chunk.completed",
  "decision.executed",
  "region.synced",
  "region.scheduler.synced",
  "run.completed",
  "terminal.normalized",
  "quality.computed",
] as const;

const FAILED_EVENTS = [
  "run.started",
  "step.selected",
  "progress.stage",
  "step.started",
  "route.decision",
  "step.transitioned",
  "step.committed",
  "outbox.dispatched",
  "model.requested",
  "model.completed",
  "decision.generated",
  "decision.compiled",
  "region.scheduled",
  "region.scheduler.spawned",
  "region.scheduler.claimed",
  "region.started",
  "decision.rejected",
  "run.failed",
  "terminal.normalized",
] as const;

async function main(): Promise<void> {
  await mkdir(SUITE_DIR, { recursive: true });
  const bundles: CapturedReplayBundle[] = [
    createBehaviorBundle({
      flowId: "research.evidence.happy.mock",
      behaviorId: "research.evidence.happy",
      baselineClass: "browser",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 4),
      primaryForBehavior: true,
      artifacts: makeArtifacts("research.evidence.happy.mock", ["dom", "screenshot"]),
    }),
    createBehaviorBundle({
      flowId: "research.evidence.conflict.mock",
      behaviorId: "research.evidence.conflict",
      baselineClass: "deterministic",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 5),
      primaryForBehavior: true,
    }),
    createBehaviorBundle({
      flowId: "research.evidence.fetch-fallback.mock",
      behaviorId: "research.evidence.fetch-fallback",
      baselineClass: "failure-recovery",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 4),
      primaryForBehavior: true,
      artifacts: makeArtifacts("research.evidence.fetch-fallback.mock", ["dom", "screenshot", "trace"]),
    }),
    createBehaviorBundle({
      flowId: "research.evidence.capability-unavailable.mock",
      behaviorId: "research.evidence.capability-unavailable",
      baselineClass: "failure-recovery",
      events: [...FAILED_EVENTS],
      summary: makeSummary("FAILED", 2, { progressToolCalls: 0 }),
      primaryForBehavior: true,
      expectedErrorCodes: ["DECISION_CAPABILITY_UNAVAILABLE"],
    }),
    createBehaviorBundle({
      flowId: "live.reference.forecast.mock",
      behaviorId: "live.reference.forecast",
      baselineClass: "browser",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 3),
      primaryForBehavior: true,
      artifacts: makeArtifacts("live.reference.forecast.mock", ["dom", "screenshot"]),
    }),
    createBehaviorBundle({
      flowId: "live.signal.brief.mock",
      behaviorId: "live.signal.brief",
      baselineClass: "live",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 5),
      primaryForBehavior: true,
    }),
    createSyntheticBundle({
      flowId: "browser.ui.happy.synthetic",
      baselineClass: "browser",
      events: [...COMPLETED_EVENTS],
      summary: makeSummary("COMPLETED", 3),
      artifacts: makeArtifacts("browser.ui.happy.synthetic", ["dom", "screenshot", "video"]),
    }),
    createSyntheticBundle({
      flowId: "browser.ui.failure.synthetic",
      baselineClass: "browser",
      events: [...FAILED_EVENTS],
      summary: makeSummary("FAILED", 2),
      expectedErrorCodes: ["UI_ASSERTION_FAILED"],
      artifacts: makeArtifacts("browser.ui.failure.synthetic", ["dom", "screenshot", "trace"]),
    }),
    createSyntheticBundle({
      flowId: "wait.resume.synthetic",
      baselineClass: "deterministic",
      events: [...COMPLETED_EVENTS, "wait.entered", "wait.resumed"],
      summary: {
        ...makeSummary("COMPLETED", 4),
        waitsEntered: 1,
        waitsResumed: 1,
      },
    }),
    createSyntheticBundle({
      flowId: "approval.escalation.synthetic",
      baselineClass: "failure-recovery",
      events: [...FAILED_EVENTS, "wait.entered"],
      summary: {
        ...makeSummary("FAILED", 2),
        waitsEntered: 1,
      },
      expectedErrorCodes: ["APPROVAL_REQUIRED"],
    }),
    createSyntheticBundle({
      flowId: "code-mode.artifact.synthetic",
      baselineClass: "live",
      events: [...COMPLETED_EVENTS],
      summary: {
        ...makeSummary("COMPLETED", 4),
        progressToolCalls: 3,
      },
      artifacts: makeArtifacts("code-mode.artifact.synthetic", ["dom", "trace"]),
    }),
  ];

  await Promise.all(
    bundles.map((bundle) =>
      writeFile(
        path.join(SUITE_DIR, `${bundle.manifest.flow_id}.json`),
        `${JSON.stringify(bundle, null, 2)}\n`,
        "utf8",
      )),
  );

  process.stdout.write(`[replay-suite] wrote ${bundles.length} bundle(s) to ${SUITE_DIR}\n`);
}

function createBehaviorBundle(input: {
  flowId: string;
  behaviorId: string;
  baselineClass: CapturedReplayBundle["manifest"]["baseline_class"];
  events: string[];
  summary: ReplaySummary;
  primaryForBehavior: boolean;
  expectedErrorCodes?: string[] | undefined;
  artifacts?: UiEvidenceArtifact[] | undefined;
}): CapturedReplayBundle {
  return {
    manifest: {
      flow_id: input.flowId,
      source_behavior_id: input.behaviorId,
      source_mode: "mock",
      baseline_class: input.baselineClass,
      primary_for_behavior: input.primaryForBehavior,
      strict_events: selectStrictEvents(input.events),
      expected_terminal_status: input.summary.terminalStatus,
      ...(input.expectedErrorCodes !== undefined ? { expected_error_codes: input.expectedErrorCodes } : {}),
      tolerant_metrics: {
        stepsObservedDelta: 1,
        progressToolCallsDelta: 2,
        durationMsDelta: 5000,
      },
      ...(input.artifacts !== undefined
        ? {
            expected_artifacts: {
              required_snapshot_types: [
                ...new Set(input.artifacts.map((artifact) => artifact.snapshot_type)),
              ],
              min_count: input.artifacts.length,
            },
          }
        : {}),
      approved_at: "2026-03-12T00:00:00.000Z",
    },
    current: {
      events: input.events,
      summary: input.summary,
      ...(input.expectedErrorCodes !== undefined ? { errorCodes: input.expectedErrorCodes } : {}),
      ...(input.artifacts !== undefined ? { uiEvidenceArtifacts: input.artifacts } : {}),
    },
    previous: {
      summary: input.summary,
    },
  };
}

function createSyntheticBundle(input: {
  flowId: string;
  baselineClass: CapturedReplayBundle["manifest"]["baseline_class"];
  events: string[];
  summary: ReplaySummary;
  expectedErrorCodes?: string[] | undefined;
  artifacts?: UiEvidenceArtifact[] | undefined;
}): CapturedReplayBundle {
  return {
    manifest: {
      flow_id: input.flowId,
      baseline_class: input.baselineClass,
      strict_events: selectStrictEvents(input.events),
      expected_terminal_status: input.summary.terminalStatus,
      ...(input.expectedErrorCodes !== undefined ? { expected_error_codes: input.expectedErrorCodes } : {}),
      tolerant_metrics: {
        stepsObservedDelta: 1,
        progressToolCallsDelta: 2,
        durationMsDelta: 5000,
      },
      ...(input.artifacts !== undefined
        ? {
            expected_artifacts: {
              required_snapshot_types: [
                ...new Set(input.artifacts.map((artifact) => artifact.snapshot_type)),
              ],
              min_count: input.artifacts.length,
            },
          }
        : {}),
      approved_at: "2026-03-12T00:00:00.000Z",
    },
    current: {
      events: input.events,
      summary: input.summary,
      ...(input.expectedErrorCodes !== undefined ? { errorCodes: input.expectedErrorCodes } : {}),
      ...(input.artifacts !== undefined ? { uiEvidenceArtifacts: input.artifacts } : {}),
    },
    previous: {
      summary: input.summary,
    },
  };
}

function makeSummary(
  terminalStatus: ReplaySummary["terminalStatus"],
  progressToolCalls: number,
  overrides: Partial<ReplaySummary> = {},
): ReplaySummary {
  return {
    eventCount: terminalStatus === "FAILED" ? FAILED_EVENTS.length : COMPLETED_EVENTS.length,
    stepsObserved: 4,
    regionsStarted: 1,
    regionsCompleted: terminalStatus === "FAILED" ? 0 : 1,
    syncNodesHit: terminalStatus === "FAILED" ? 0 : 1,
    mergeConflicts: 0,
    progressStages: 3,
    progressToolCalls,
    waitingMilestones: 0,
    heartbeatLiveOnlyCount: 0,
    schedulerActions: 2,
    waitsEntered: 0,
    waitsResumed: 0,
    loopGuards: 0,
    terminalStatus,
    truncated: false,
    ...overrides,
  };
}

function makeArtifacts(
  flowId: string,
  snapshotTypes: Array<"dom" | "screenshot" | "trace" | "video">,
): UiEvidenceArtifact[] {
  return snapshotTypes.map((snapshotType) => ({
    flow_id: flowId,
    snapshot_type: snapshotType,
    capture_phase: "post-finalize",
    selector_assertions: ["[data-testid=\"evaluation-output\"]"],
    artifact_path: `.kestrel/artifacts/seed/${flowId}.${snapshotType}`,
    result: "passed",
  }));
}

function selectStrictEvents(events: string[]): string[] {
  return events.filter((eventType, index, all) =>
    all.indexOf(eventType) === index &&
    (eventType === "run.started" ||
      eventType === "step.selected" ||
      eventType === "step.started" ||
      eventType === "step.committed" ||
      eventType === "terminal.normalized" ||
      eventType.startsWith("wait.") ||
      eventType === "progress.tool"),
  );
}

void main().catch((error) => {
  process.stderr.write(`seed-replay-suite failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
