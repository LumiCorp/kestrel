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
  executeMissionControlMigration: DesktopBridge["executeMissionControlMigration"] =
    async (intent) => {
      const response = await getMissionControlProject(intent.projectId);
      return response;
    },
  executeMissionControlAction: DesktopBridge["executeMissionControlAction"] =
    async (intent) => {
      const response = await getMissionControlProject(intent.projectId);
      return response;
    },
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
    kestrelDesktop: {
      getMissionControlProject,
      executeMissionControlMigration,
      executeMissionControlAction,
    } as DesktopBridge,
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
        migration: {
          version: 1,
          status: "staged",
          registeredPath: "/project",
          sources: [],
          candidates: [],
          rebinds: [],
          stagedAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T09:00:00.000Z",
        },
      },
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-10T11:00:00.000Z",
    },
  };
}

function migrationResponse(
  revision: number,
  migration: NonNullable<
    DesktopMissionControlProjectResponse["project"]["document"]["migration"]
  > | undefined,
): DesktopMissionControlProjectResponse {
  const response = projectResponse();
  response.project.revision = revision;
  response.project.document.items = {};
  response.project.document.history = [];
  if (migration === undefined) {
    delete response.project.document.migration;
  } else {
    response.project.document.migration = migration;
  }
  return response;
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

    assert.match(container.textContent ?? "", /Legacy authority · read-only/u);
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
  "unified Mission Control activates once and routes explicit operator commands through project authority",
  async () => {
    const inactive = projectResponse();
    const intents: unknown[] = [];
    let current = inactive;
    const { root, container } = installDom(
      async () => current,
      async () => current,
      async (intent) => {
        intents.push(intent);
        const next = structuredClone(current);
        next.project.revision += 1;
        if (intent.type === "activate") {
          next.project.authorityEpoch = 1;
        }
        if (intent.type === "configure_autopilot") {
          next.project.document.autopilot = {
            enabled: intent.enabled,
            wipLimit: intent.wipLimit,
            ...(intent.enabled
              ? { confirmedAt: "2026-07-31T12:00:00.000Z" }
              : {}),
          };
        }
        current = next;
        return current;
      },
    );

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onStartConversation={() => {}}
          onError={() => {}}
        />,
      );
    });

    await act(async () => button(container, "Activate Mission Control").click());
    assert.deepEqual(intents[0], {
      type: "activate",
      projectId: PROJECT_ID,
      expectedRevision: 8,
    });
    assert.match(container.textContent ?? "", /Canonical authority · epoch 1/u);
    assert.equal(button(container, "Start").disabled, false);

    await act(async () => button(container, "Enable Autopilot").click());
    assert.equal(intents.length, 1);
    assert.match(
      container.textContent ?? "",
      /Autopilot will start eligible Ready work through the same Start path/u,
    );
    await act(async () => button(container, "Confirm enable Autopilot").click());
    assert.deepEqual(intents[1], {
      type: "configure_autopilot",
      projectId: PROJECT_ID,
      expectedRevision: 9,
      enabled: true,
      wipLimit: 2,
      confirmed: true,
    });
    assert.match(container.textContent ?? "", /Autopilot on/u);

    await act(async () => button(container, "Start").click());
    assert.deepEqual(intents[2], {
      type: "start",
      projectId: PROJECT_ID,
      expectedRevision: 10,
      itemId: "item-ready",
      expectedItemVersion: 1,
    });

    await act(async () => button(container, "Verify Desktop package").click());
    await act(async () => button(container, "Stop").click());
    assert.deepEqual(intents[3], {
      type: "stop",
      projectId: PROJECT_ID,
      expectedRevision: 11,
      itemId: "item-active",
      expectedItemVersion: 3,
      attemptId: "attempt-2",
      expectedAttemptVersion: 2,
      runId: "run-active",
      commandId: "command-active",
    });
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.mission-control-operator-flow",
  "unified Mission Control stages an explicit empty migration on first project read",
  async () => {
    const initial = migrationResponse(0, undefined);
    const staged = migrationResponse(1, {
      version: 1,
      status: "staged_empty",
      registeredPath: "/project",
      sources: [],
      candidates: [],
      rebinds: [],
      stagedAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    const intents: unknown[] = [];
    const { root, container } = installDom(
      async () => initial,
      async (intent) => {
        intents.push(intent);
        return staged;
      },
    );

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onStartConversation={() => {}}
          onError={() => {}}
        />,
      );
    });

    assert.deepEqual(intents, [{
      type: "stage",
      projectId: PROJECT_ID,
      expectedRevision: 0,
    }]);
    assert.match(container.textContent ?? "", /Migration: empty/u);
    assert.match(
      container.textContent ?? "",
      /Legacy session Mission Control remains the sole write authority/u,
    );
    assert.match(
      container.textContent ?? "",
      /No compatible legacy work exists/u,
    );
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.mission-control-operator-flow",
  "unified Mission Control blocks ambiguous sources until explicit rebind and selection",
  async () => {
    const fingerprint = "a".repeat(64);
    const firstCandidate = "b".repeat(64);
    const secondCandidate = "c".repeat(64);
    const needsRebind = migrationResponse(2, {
      version: 1,
      status: "needs_rebind",
      registeredPath: "/project",
      sources: [{
        sourceId: "session:legacy",
        kind: "session_snapshot",
        sessionId: "legacy",
        sourceVersion: 3,
        sourceFingerprint: fingerprint,
        projectPath: "/moved-project",
        linkStatus: "moved",
      }],
      candidates: [],
      rebinds: [],
      stagedAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    const needsResolution = migrationResponse(3, {
      ...needsRebind.project.document.migration!,
      status: "needs_resolution",
      sources: [{
        ...needsRebind.project.document.migration!.sources[0]!,
        linkStatus: "rebound",
        candidateId: firstCandidate,
      }],
      candidates: [
        {
          id: firstCandidate,
          canonicalFingerprint: "d".repeat(64),
          sourceIds: ["session:legacy"],
          valid: true,
          conflicts: [],
        },
        {
          id: secondCandidate,
          canonicalFingerprint: "e".repeat(64),
          sourceIds: ["session:other"],
          valid: true,
          conflicts: [],
        },
      ],
      rebinds: [{
        sourceId: "session:legacy",
        sourceFingerprint: fingerprint,
        projectId: PROJECT_ID,
        actionId: "rebind-action",
        reboundAt: "2026-07-31T12:01:00.000Z",
      }],
      updatedAt: "2026-07-31T12:01:00.000Z",
    });
    const resolved = migrationResponse(4, {
      ...needsResolution.project.document.migration!,
      status: "resolved",
      resolution: {
        type: "source",
        candidateId: firstCandidate,
        sourceFingerprints: { "session:legacy": fingerprint },
        actionId: "resolve-action",
        resolvedAt: "2026-07-31T12:02:00.000Z",
      },
      updatedAt: "2026-07-31T12:02:00.000Z",
    });
    const intents: unknown[] = [];
    const { root, container } = installDom(
      async () => needsRebind,
      async (intent) => {
        intents.push(intent);
        return intent.type === "rebind" ? needsResolution : resolved;
      },
    );

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onStartConversation={() => {}}
          onError={() => {}}
        />,
      );
    });
    assert.match(container.textContent ?? "", /project identity required/u);
    await act(async () => button(container, "Rebind to this project").click());
    assert.deepEqual(intents[0], {
      type: "rebind",
      projectId: PROJECT_ID,
      expectedRevision: 2,
      sourceId: "session:legacy",
      sourceFingerprint: fingerprint,
    });
    assert.match(container.textContent ?? "", /source selection required/u);
    await act(async () =>
      button(container, "Use this complete source").click()
    );
    assert.deepEqual(intents[1], {
      type: "resolve",
      projectId: PROJECT_ID,
      expectedRevision: 3,
      resolution: { type: "source", candidateId: firstCandidate },
    });
    assert.match(container.textContent ?? "", /Migration: resolved/u);
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
