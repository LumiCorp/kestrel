import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  extractDesktopTerminalOutcome,
  getDesktopOutcomeHandoff,
  OutcomeHandoff,
  withDesktopOutcomeWorkspaceChanges,
} from "../renderer/src/outcomeHandoff.js";
import type { DesktopRunnerEvent } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

function installDom(): { root: Root; container: HTMLDivElement } {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  return { root: createRoot(container), container };
}

function terminalEvent(type: "run.completed" | "run.failed" | "run.cancelled"): DesktopRunnerEvent {
  return {
    id: "event-1",
    type,
    ts: "2026-07-27T12:00:00.000Z",
    payload: {
      result: {
        output: {
          runId: " run-123 ",
          status: type === "run.completed" ? " COMPLETED " : " FAILED ",
        },
      },
    },
  } as DesktopRunnerEvent;
}

contractTest("desktop.hermetic", "terminal handoff metadata is explicit, normalized, and rejects prose-shaped data", () => {
  assert.deepEqual(extractDesktopTerminalOutcome(terminalEvent("run.completed")), {
    kind: "desktop.terminal-outcome.v1",
    runId: "run-123",
    terminalEvent: "run.completed",
    resultStatus: "COMPLETED",
  });
  assert.deepEqual(getDesktopOutcomeHandoff({
    kind: "desktop.terminal-outcome.v1",
    runId: " run-456 ",
    terminalEvent: "run.cancelled",
    resultStatus: " CANCELLED ",
  }), {
    kind: "desktop.terminal-outcome.v1",
    runId: "run-456",
    terminalEvent: "run.cancelled",
    resultStatus: "CANCELLED",
  });
  assert.equal(getDesktopOutcomeHandoff({
    kind: "desktop.outcome-handoff.v1",
    runId: "run-123",
    status: "completed",
  }), undefined);
  assert.equal(getDesktopOutcomeHandoff({
    kind: "desktop.terminal-outcome.v1",
    runId: "run-123",
    terminalEvent: "run.completed",
    resultStatus: "   ",
  }), undefined);
  assert.deepEqual(withDesktopOutcomeWorkspaceChanges({
    kind: "desktop.terminal-outcome.v1",
    runId: "run-123",
    terminalEvent: "run.completed",
    resultStatus: "COMPLETED",
  }, {
    checkpoints: [{ runId: "run-other" }, { runId: "run-123" }],
  }), {
    kind: "desktop.terminal-outcome.v1",
    runId: "run-123",
    terminalEvent: "run.completed",
    resultStatus: "COMPLETED",
    hasWorkspaceChanges: true,
  });
});

contractTest("desktop.hermetic", "completed workspace outcomes hand off directly to existing evidence surfaces", async () => {
  const { root, container } = installDom();
  const reviewed: string[] = [];
  const inspected: string[] = [];
  let checksViewed = 0;
  await act(async () => root.render(<OutcomeHandoff
    outcome={{
      kind: "desktop.terminal-outcome.v1",
      runId: "run-123",
      terminalEvent: "run.completed",
      resultStatus: "COMPLETED",
      hasWorkspaceChanges: true,
    }}
    hasWorkspace
    onReviewChanges={(runId) => reviewed.push(runId)}
    onViewChecks={() => { checksViewed += 1; }}
    onInspectRun={(runId) => inspected.push(runId)}
  />));

  assert.equal(container.querySelector('[aria-label="Completed run actions"]')?.textContent?.replace(/\s+/gu, " ").trim(), "Run completedReview changesView checksInspect run");
  for (const label of ["Review changes", "View checks", "Inspect run"]) {
    const action = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
    assert.ok(action, `Expected ${label} action.`);
    await act(async () => action.click());
  }
  assert.deepEqual(reviewed, ["run-123"]);
  assert.equal(checksViewed, 1);
  assert.deepEqual(inspected, ["run-123"]);
  await act(async () => root.unmount());
});

contractTest("desktop.hermetic", "outcome handoff stays available for inspection without a workspace and is absent for non-successful outcomes", async () => {
  const { root, container } = installDom();
  await act(async () => root.render(<OutcomeHandoff
    outcome={{
      kind: "desktop.terminal-outcome.v1",
      runId: "run-123",
      terminalEvent: "run.completed",
      resultStatus: "COMPLETED",
    }}
    hasWorkspace={false}
    onReviewChanges={() => { throw new Error("Review should not be available."); }}
    onViewChecks={() => { throw new Error("Checks should not be available."); }}
    onInspectRun={() => {}}
  />));
  assert.equal(container.querySelector("button")?.textContent, "Inspect run");

  await act(async () => root.render(<OutcomeHandoff
    outcome={{
      kind: "desktop.terminal-outcome.v1",
      runId: "run-123",
      terminalEvent: "run.completed",
      resultStatus: "COMPLETED",
    }}
    hasWorkspace
    onReviewChanges={() => { throw new Error("Review should require run evidence."); }}
    onViewChecks={() => {}}
    onInspectRun={() => {}}
  />));
  assert.deepEqual(
    [...container.querySelectorAll("button")].map((button) => button.textContent),
    ["View checks", "Inspect run"],
  );

  await act(async () => root.render(<OutcomeHandoff
    outcome={{
      kind: "desktop.terminal-outcome.v1",
      runId: "run-123",
      terminalEvent: "run.failed",
      resultStatus: "FAILED",
    }}
    hasWorkspace
    onReviewChanges={() => {}}
    onViewChecks={() => {}}
    onInspectRun={() => {}}
  />));
  assert.equal(container.querySelector('[aria-label="Completed run actions"]'), null);
  await act(async () => root.unmount());
});
