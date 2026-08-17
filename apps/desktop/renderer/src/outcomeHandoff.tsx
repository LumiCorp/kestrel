import type { DesktopRunnerEvent } from "../../src/contracts";
import React from "react";

export interface DesktopTerminalOutcome {
  kind: "desktop.terminal-outcome.v1";
  runId: string;
  terminalEvent: "run.completed" | "run.failed" | "run.cancelled";
  resultStatus: string;
  hasWorkspaceChanges?: true | undefined;
}

export function extractDesktopTerminalOutcome(
  event: DesktopRunnerEvent,
): DesktopTerminalOutcome | undefined {
  if (
    event.type !== "run.completed" &&
    event.type !== "run.failed" &&
    event.type !== "run.cancelled"
  ) return;
  const result = record(event.payload.result);
  const output = record(result?.output);
  const runId = text(output?.runId);
  const resultStatus = text(output?.status);
  if (runId === undefined || resultStatus === undefined) return;
  return {
    kind: "desktop.terminal-outcome.v1",
    runId,
    terminalEvent: event.type,
    resultStatus,
  };
}

export function getDesktopOutcomeHandoff(
  value: unknown,
): DesktopTerminalOutcome | undefined {
  const candidate = record(value);
  if (
    candidate?.kind !== "desktop.terminal-outcome.v1" ||
    (candidate.terminalEvent !== "run.completed" &&
      candidate.terminalEvent !== "run.failed" &&
      candidate.terminalEvent !== "run.cancelled")
  ) return;
  const runId = text(candidate.runId);
  const resultStatus = text(candidate.resultStatus);
  return runId === undefined || resultStatus === undefined
    ? undefined
    : {
        kind: "desktop.terminal-outcome.v1",
        runId,
        terminalEvent: candidate.terminalEvent,
        resultStatus,
        ...(candidate.hasWorkspaceChanges === true
          ? { hasWorkspaceChanges: true as const }
          : {}),
      };
}

/**
 * A project is only a possible workspace. A run-level checkpoint is the
 * evidence that an exact-run diff can be opened safely.
 */
export function withDesktopOutcomeWorkspaceChanges(
  outcome: DesktopTerminalOutcome,
  lifecycle: { checkpoints: ReadonlyArray<{ runId?: string | undefined }> },
): DesktopTerminalOutcome {
  return lifecycle.checkpoints.some((checkpoint) => checkpoint.runId === outcome.runId)
    ? { ...outcome, hasWorkspaceChanges: true }
    : outcome;
}

export function OutcomeHandoff(props: {
  outcome: DesktopTerminalOutcome;
  hasWorkspace: boolean;
  onReviewChanges: (runId: string) => void;
  onInspectRun: (runId: string) => void;
}) {
  if (
    props.outcome.terminalEvent !== "run.completed" ||
    props.outcome.resultStatus !== "COMPLETED"
  ) return null;
  return (
    <section className="outcome-handoff" aria-label="Completed run actions">
      <span>Run completed</span>
      <div className="outcome-handoff-actions">
        {props.hasWorkspace && props.outcome.hasWorkspaceChanges === true ? <button type="button" onClick={() => props.onReviewChanges(props.outcome.runId)}>Review changes</button> : null}
        <button type="button" onClick={() => props.onInspectRun(props.outcome.runId)}>Inspect run</button>
      </div>
    </section>
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
