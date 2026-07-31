import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  DesktopBridge,
  DesktopMissionControlProjectResponse,
} from "../src/contracts.js";
import {
  isUnifiedMissionControlProjectEnabled,
  UnifiedMissionControlWorkspace,
} from "../renderer/src/UnifiedMissionControlWorkspace.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function installDom(
  getMissionControlProject: DesktopBridge["getMissionControlProject"],
): { root: Root; container: HTMLDivElement } {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    KeyboardEvent: browser.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(browser, {
    kestrelDesktop: { getMissionControlProject } as DesktopBridge,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  return { root: createRoot(container), container };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label
      || candidate.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Expected button '${label}'.`);
  return found;
}

function projectResponse(): DesktopMissionControlProjectResponse {
  return {
    projectId: PROJECT_ID,
    project: {
      projectId: PROJECT_ID,
      schemaVersion: 1,
      revision: 8,
      authorityEpoch: 0,
      document: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        autopilot: { enabled: false, wipLimit: 2 },
        items: {
          "item-ready": {
            id: "item-ready",
            title: "Prepare release notes",
            instructions: "Write the project release notes.",
            createdBy: "operator",
            phase: "ready",
            order: 1,
            attempts: [],
            version: 1,
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T10:00:00.000Z",
          },
          "item-active": {
            id: "item-active",
            title: "Verify Desktop package",
            instructions: "Run the canonical Desktop verification.",
            createdBy: "operator",
            phase: "active",
            order: 1,
            currentAttemptId: "attempt-2",
            attempts: [
              {
                id: "attempt-1",
                generation: 1,
                initiatedBy: "operator",
                status: "failed",
                version: 2,
                profileId: "desktop",
                requestedSessionId: "session-old",
                requestedThreadId: "thread-old",
                dispatchCommandId: "command-old",
                dispatchRunId: "run-old",
                runs: [],
                terminalReason: "Process exited.",
                createdAt: "2026-07-10T10:00:00.000Z",
                updatedAt: "2026-07-10T10:10:00.000Z",
              },
              {
                id: "attempt-2",
                generation: 2,
                initiatedBy: "operator",
                status: "running",
                version: 2,
                profileId: "desktop",
                requestedSessionId: "session-active",
                requestedThreadId: "thread-active",
                dispatchCommandId: "command-active",
                dispatchRunId: "run-active",
                currentRunId: "run-active",
                runs: [{
                  sessionId: "session-active",
                  threadId: "thread-active",
                  runId: "run-active",
                  commandId: "command-active",
                  acceptedAt: "2026-07-10T11:00:00.000Z",
                }],
                createdAt: "2026-07-10T11:00:00.000Z",
                updatedAt: "2026-07-10T11:00:00.000Z",
              },
            ],
            version: 3,
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T11:00:00.000Z",
          },
          "item-discarded": {
            id: "item-discarded",
            title: "Discarded experiment",
            instructions: "Historical work.",
            createdBy: "agent",
            phase: "discarded",
            order: 1,
            attempts: [],
            version: 2,
            createdAt: "2026-07-10T09:00:00.000Z",
            updatedAt: "2026-07-10T09:30:00.000Z",
          },
        },
        history: [{
          actionId: "history-active",
          actionType: "execution.retry",
          revision: 8,
          timestamp: "2026-07-10T11:00:00.000Z",
          itemId: "item-active",
          attemptId: "attempt-2",
          disposition: "applied",
        }],
      },
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-10T11:00:00.000Z",
    },
  };
}

contractTest(
  "desktop.mission-control-operator-flow",
  "unified Mission Control keeps List and Kanban equivalent with one stable read-only inspector",
  async () => {
    const response = projectResponse();
    const opened: string[] = [];
    const started: string[] = [];
    let returned = 0;
    const { root, container } = installDom(async (projectId) => {
      assert.equal(projectId, PROJECT_ID);
      return response;
    });

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          onReturnToConversation={() => {
            returned += 1;
          }}
          onOpenConversation={(sessionId) => opened.push(sessionId)}
          onStartConversation={(projectPath) => started.push(projectPath)}
          onError={() => {}}
        />,
      );
    });

    assert.match(container.textContent ?? "", /Read-only preview/u);
    assert.match(container.textContent ?? "", /Prepare release notes/u);
    assert.match(container.textContent ?? "", /Verify Desktop package/u);
    assert.doesNotMatch(container.textContent ?? "", /Discarded experiment/u);
    assert.doesNotMatch(
      container.textContent ?? "",
      /Steer now|Queue follow-up|Stop run|composer/u,
    );
    assert.equal(container.querySelector("[draggable=true]"), null);
    await act(async () => button(container, "Back to Conversation").click());
    assert.equal(returned, 1);

    await act(async () => {
      button(container, "Verify Desktop package").click();
    });
    assert.match(container.textContent ?? "", /attempt-2/u);
    assert.match(container.textContent ?? "", /attempt-1/u);
    assert.match(container.textContent ?? "", /run-active/u);
    assert.match(container.textContent ?? "", /execution\.retry/u);
    assert.match(container.textContent ?? "", /Frozen evidenceNone/u);
    await act(async () => button(container, "Open conversation").click());
    assert.deepEqual(opened, ["session-active"]);

    await act(async () => button(container, "Kanban").click());
    assert.match(container.textContent ?? "", /Current attempt/u);
    assert.match(container.textContent ?? "", /attempt-2/u);
    for (const label of [
      "Proposed",
      "Ready",
      "Active",
      "Needs attention",
      "Review",
      "Done",
    ]) {
      assert.ok(container.querySelector(`[aria-label="${label} lane"]`));
    }
    assert.equal(container.querySelector('[aria-label="Discarded lane"]'), null);

    const discardedToggle =
      container.querySelector<HTMLInputElement>(".show-discarded-control input");
    assert.ok(discardedToggle);
    await act(async () => {
      discardedToggle.click();
    });
    assert.match(container.textContent ?? "", /Discarded experiment/u);
    assert.equal(container.querySelector('[aria-label="Discarded lane"]'), null);

    await act(async () => button(container, "List").click());
    await act(async () => button(container, "Prepare release notes").click());
    await act(async () => button(container, "Start conversation").click());
    assert.deepEqual(started, ["/project"]);
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.mission-control-operator-flow",
  "unified Mission Control preserves authoritative state when refresh fails",
  async () => {
    const response = projectResponse();
    let call = 0;
    const errors: Array<string | undefined> = [];
    const { root, container } = installDom(async () => {
      call += 1;
      if (call === 1) return response;
      throw new Error("Runner disconnected.");
    });

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onStartConversation={() => {}}
          onError={(message) => errors.push(message)}
        />,
      );
    });
    await act(async () => button(container, "Refresh Mission Control").click());
    assert.match(container.textContent ?? "", /could not refresh/u);
    assert.match(container.textContent ?? "", /last authoritative project state/u);
    assert.match(container.textContent ?? "", /Verify Desktop package/u);
    assert.equal(errors.at(-1), "Runner disconnected.");
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.mission-control-operator-flow",
  "unified Mission Control preview gate requires the exact registered project UUID",
  () => {
    assert.equal(
      isUnifiedMissionControlProjectEnabled(
        PROJECT_ID,
        `?mission-control-project=${PROJECT_ID}`,
      ),
      true,
    );
    assert.equal(
      isUnifiedMissionControlProjectEnabled(
        PROJECT_ID,
        "?mission-control-project=22222222-2222-4222-8222-222222222222",
      ),
      false,
    );
    assert.equal(
      isUnifiedMissionControlProjectEnabled(undefined, ""),
      false,
    );
  },
);
