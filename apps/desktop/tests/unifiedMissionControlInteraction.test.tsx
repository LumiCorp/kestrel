import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  DesktopBridge,
  DesktopMissionControlActionIntent,
  DesktopMissionControlProjectSetup,
  DesktopMissionControlProjectResponse,
  DesktopRuntimeHealth,
} from "../src/contracts.js";
import {
  formatRelativeTime,
  isMissionWorkItemSubmitDisabled,
  shouldClearMissionControlOperatorInput,
  UnifiedMissionControlWorkspace,
} from "../renderer/src/UnifiedMissionControlWorkspace.js";
import {
  createPreviewMissionControlProject,
} from "../renderer/src/missionControlPreviewStore.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTED_RUNTIME_HEALTH: DesktopRuntimeHealth = {
  state: "healthy",
  connection: "connected",
  summary: "Runtime ready.",
  running: true,
};

test("Mission Control relative timestamps advance against the display clock", () => {
  const timestamp = Date.parse("2026-08-17T12:00:00.000Z");
  assert.equal(formatRelativeTime(new Date(timestamp).toISOString(), timestamp + 20_000), "just now");
  assert.equal(formatRelativeTime(new Date(timestamp).toISOString(), timestamp + 2 * 60_000), "2m ago");
  assert.equal(formatRelativeTime(new Date(timestamp).toISOString(), timestamp + 2 * 60 * 60_000), "2h ago");
});

function installDom(
  getMissionControlProject: DesktopBridge["getMissionControlProject"],
  executeMissionControlAction: DesktopBridge["executeMissionControlAction"] =
    async (intent) => {
      const response = await getMissionControlProject(intent.projectId);
      return response;
    },
  inspectMissionControlProjectSetup: (
    projectId: string,
  ) => Promise<DesktopMissionControlProjectSetup> = async (projectId) => ({
    projectId,
    projectPath: "/project",
    actions: [{
      actionId: "package:test",
      label: "test",
      kind: "test",
      command: "pnpm",
      args: ["run", "test"],
      cwd: "/project",
      required: true,
      artifactPaths: [],
      source: "package_script",
    }],
    suites: [{
      suiteId: "required",
      label: "Required validation",
      actionIds: ["package:test"],
      stopOnFailure: true,
    }],
  }),
): {
  root: Root;
  container: HTMLDivElement;
  emitMissionControlProject: (project: DesktopMissionControlProjectResponse) => void;
} {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    React,
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
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
  const missionControlListeners = new Set<
    (project: DesktopMissionControlProjectResponse) => void
  >();
  Object.assign(browser, {
    kestrelDesktop: {
      getMissionControlProject,
      executeMissionControlAction,
      onMissionControlProject: (
        listener: (project: DesktopMissionControlProjectResponse) => void,
      ) => {
        missionControlListeners.add(listener);
        return () => missionControlListeners.delete(listener);
      },
      inspectMissionControlProjectSetup,
    } as DesktopBridge,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  return {
    root: createRoot(container),
    container,
    emitMissionControlProject(project: DesktopMissionControlProjectResponse) {
      for (const listener of missionControlListeners) listener(project);
    },
  };
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

function changeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const browser = window as unknown as Window;
  const prototype = element instanceof browser.HTMLSelectElement
    ? browser.HTMLSelectElement.prototype
    : element instanceof browser.HTMLTextAreaElement
      ? browser.HTMLTextAreaElement.prototype
      : browser.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(
    prototype,
    "value",
  )?.set;
  if (setter === undefined) element.value = value;
  else setter.call(element, value);
  if (
    element instanceof browser.HTMLInputElement ||
    element instanceof browser.HTMLTextAreaElement
  ) {
    element.dispatchEvent(new browser.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }));
  }
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function projectResponse(): DesktopMissionControlProjectResponse {
  return {
    projectId: PROJECT_ID,
    project: {
      projectId: PROJECT_ID,
      schemaVersion: 1,
      revision: 8,
      authorityEpoch: 1,
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

test(
  "unified Mission Control keeps List and Kanban equivalent with one stable read-only inspector",
  async () => {
    const response = projectResponse();
    const opened: string[] = [];
    let returned = 0;
    const { root, container } = installDom(async (projectId) => {
      assert.equal(projectId, PROJECT_ID);
      return response;
    });

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {
            returned += 1;
          }}
          onOpenConversation={(sessionId) => opened.push(sessionId)}
          onError={() => {}}
        />,
      );
    });

    assert.doesNotMatch(container.textContent ?? "", /Project authority|11111111-1111-4111-8111-111111111111/u);
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
    assert.ok(container.querySelector("[draggable=true]"));
    assert.match(container.textContent ?? "", /Current attempt/u);
    assert.match(container.textContent ?? "", /attempt-2/u);
    for (const label of [
      "Suggested",
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
    assert.equal(
      [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.trim() === "Start conversation",
      ),
      false,
    );
    await act(async () => root.unmount());
  },
);

test(
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
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
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

test(
  "unified Mission Control keeps the active project load across parent callback rerenders",
  async () => {
    const response = projectResponse();
    let resolveProject:
      | ((value: DesktopMissionControlProjectResponse) => void)
      | undefined;
    let calls = 0;
    const reportedByFirst: Array<string | undefined> = [];
    const reportedByLatest: Array<string | undefined> = [];
    const { root, container } = installDom(async () => {
      calls += 1;
      return new Promise<DesktopMissionControlProjectResponse>((resolve) => {
        resolveProject = resolve;
      });
    });
    const commonProps = {
      project: { id: PROJECT_ID, path: "/project", label: "Kestrel" },
      runtimeHealth: CONNECTED_RUNTIME_HEALTH,
      onReturnToConversation: () => {},
      onOpenConversation: () => {},
    };

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          {...commonProps}
          onError={(message) => reportedByFirst.push(message)}
        />,
      );
    });
    assert.equal(calls, 1);

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          {...commonProps}
          onError={(message) => reportedByLatest.push(message)}
        />,
      );
    });
    assert.equal(
      calls,
      1,
      "changing a parent callback must not cancel and restart the project request",
    );

    await act(async () => {
      assert.ok(resolveProject);
      resolveProject(response);
    });
    assert.doesNotMatch(container.textContent ?? "", /Project authority/u);
    assert.deepEqual(reportedByFirst, []);
    assert.deepEqual(reportedByLatest, [undefined]);
    await act(async () => root.unmount());
  },
);

test(
  "project snapshots may update parent state without a render-phase warning",
  async () => {
    const response = projectResponse();
    const { root } = installDom(async () => response);
    const consoleErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => {
      consoleErrors.push(values.map(String).join(" "));
    };
    function Harness() {
      const [, setReportedRevision] = useState(0);
      return (
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onProjectResponse={(next) => setReportedRevision(next.project.revision)}
          onError={() => {}}
        />
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      assert.equal(
        consoleErrors.some((message) => message.includes("Cannot update a component")),
        false,
      );
    } finally {
      console.error = originalConsoleError;
      await act(async () => root.unmount());
    }
  },
);

test(
  "unified Mission Control routes explicit operator commands through active project authority",
  async () => {
    const inactive = projectResponse();
    const intents: unknown[] = [];
    let current = inactive;
    const { root, container } = installDom(
      async () => current,
      async (intent) => {
        intents.push(intent);
        const next = structuredClone(current);
        next.project.revision += 1;
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
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onError={() => {}}
        />,
      );
    });

    assert.doesNotMatch(container.textContent ?? "", /Project authority/u);
    assert.equal(button(container, "Start").disabled, false);

    await act(async () => button(container, "Enable Autopilot").click());
    assert.equal(intents.length, 0);
    assert.match(
      container.textContent ?? "",
      /Autopilot will start eligible Ready work through the same Start path/u,
    );
    await act(async () => button(container, "Confirm enable Autopilot").click());
    assert.deepEqual(intents[0], {
      type: "configure_autopilot",
      projectId: PROJECT_ID,
      expectedRevision: 8,
      enabled: true,
      wipLimit: 2,
      confirmed: true,
    });
    assert.match(container.textContent ?? "", /Autopilot on/u);

    await act(async () => button(container, "Start").click());
    assert.deepEqual(intents[1], {
      type: "start",
      projectId: PROJECT_ID,
      expectedRevision: 9,
      itemId: "item-ready",
      expectedItemVersion: 1,
    });

    await act(async () => button(container, "Verify Desktop package").click());
    await act(async () => button(container, "Stop").click());
    assert.deepEqual(intents[2], {
      type: "stop",
      projectId: PROJECT_ID,
      expectedRevision: 10,
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

test(
  "live project revisions win races with the initial fetch and ignore older state",
  async () => {
    let resolveInitial:
      | ((value: DesktopMissionControlProjectResponse) => void)
      | undefined;
    const initial = projectResponse();
    const live = structuredClone(initial);
    live.project.revision = 10;
    live.project.updatedAt = "2026-07-10T12:00:00.000Z";
    live.project.document.items["item-ready"]!.title = "Live release plan";
    const { root, container, emitMissionControlProject } = installDom(
      async () => new Promise((resolve) => { resolveInitial = resolve; }),
    );

    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onError={() => {}}
        />,
      );
    });
    await act(async () => emitMissionControlProject(live));
    assert.match(container.textContent ?? "", /Live release plan/u);

    await act(async () => {
      assert.ok(resolveInitial);
      resolveInitial(initial);
    });
    assert.match(container.textContent ?? "", /Live release plan/u);
    assert.doesNotMatch(container.textContent ?? "", /Prepare release notes/u);
    await act(async () => root.unmount());
  },
);

test(
  "Ready ordering sends the complete authoritative phase order",
  async () => {
    const initial = projectResponse();
    initial.project.document.items["item-ready-second"] = {
      ...initial.project.document.items["item-ready"]!,
      id: "item-ready-second",
      title: "Package release notes",
      order: 2,
    };
    const intents: DesktopMissionControlActionIntent[] = [];
    let current = initial;
    const { root, container } = installDom(
      async () => current,
      async (intent) => {
        intents.push(intent);
        const next = structuredClone(current);
        next.project.revision += 1;
        current = next;
        return next;
      },
    );
    await act(async () => {
      root.render(
        <UnifiedMissionControlWorkspace
          project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
          runtimeHealth={CONNECTED_RUNTIME_HEALTH}
          onReturnToConversation={() => {}}
          onOpenConversation={() => {}}
          onError={() => {}}
        />,
      );
    });
    await act(async () => button(container, "Move Prepare release notes down").click());
    assert.deepEqual(intents[0], {
      type: "resequence",
      projectId: PROJECT_ID,
      expectedRevision: 8,
      targetPhase: "ready",
      orderedItemIds: ["item-ready-second", "item-ready"],
    });
    await act(async () => root.unmount());
  },
);

test("project switching remounts Mission Control before the next authority response", async () => {
  const secondProjectId = "22222222-2222-4222-8222-222222222222";
  const first = projectResponse();
  const second = structuredClone(first);
  second.projectId = secondProjectId;
  second.project.projectId = secondProjectId;
  second.project.document.projectId = secondProjectId;
  second.project.document.items["item-ready"]!.title = "Project B release notes";
  let resolveSecond: ((response: DesktopMissionControlProjectResponse) => void) | undefined;
  const intents: DesktopMissionControlActionIntent[] = [];
  const { root, container } = installDom(
    async (projectId) => projectId === PROJECT_ID
      ? first
      : await new Promise((resolve) => { resolveSecond = resolve; }),
    async (intent) => {
      intents.push(intent);
      return intent.projectId === PROJECT_ID ? first : second;
    },
  );
  const projects = [
    { id: PROJECT_ID, path: "/project-a", label: "Project A" },
    { id: secondProjectId, path: "/project-b", label: "Project B" },
  ];

  function Harness() {
    const [project, setProject] = useState(projects[0]!);
    return (
      <UnifiedMissionControlWorkspace
        key={project.id}
        project={project}
        projects={projects}
        runtimeHealth={CONNECTED_RUNTIME_HEALTH}
        onProjectChange={(path) => setProject(projects.find((candidate) => candidate.path === path)!)}
        onReturnToConversation={() => {}}
        onOpenConversation={() => {}}
        onError={() => {}}
      />
    );
  }

  await act(async () => root.render(<Harness />));
  await act(async () => button(container, "Enable Autopilot").click());
  assert.match(container.textContent ?? "", /Confirm enable Autopilot/u);
  const selector = container.querySelector(
    'select[aria-label="Mission Control project"]',
  ) as HTMLSelectElement;
  await act(async () => changeValue(selector, "/project-b"));
  assert.doesNotMatch(container.textContent ?? "", /Confirm enable Autopilot/u);
  assert.match(container.textContent ?? "", /Loading project Mission Control/u);
  assert.doesNotMatch(container.textContent ?? "", /No work has been created/u);
  assert.deepEqual(intents, []);

  await act(async () => {
    assert.ok(resolveSecond);
    resolveSecond(second);
  });
  assert.match(container.textContent ?? "", /Project B release notes/u);
  await act(async () => root.unmount());
});

test("Mission Control connection status follows runtime connectivity", async () => {
  const response = projectResponse();
  const { root, container } = installDom(async () => response);
  const render = async (runtimeHealth: DesktopRuntimeHealth) => {
    await act(async () => root.render(
      <UnifiedMissionControlWorkspace
        project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
        runtimeHealth={runtimeHealth}
        onReturnToConversation={() => {}}
        onOpenConversation={() => {}}
        onError={() => {}}
      />,
    ));
  };

  await render(CONNECTED_RUNTIME_HEALTH);
  assert.match(container.textContent ?? "", /Live/u);
  await render({
    ...CONNECTED_RUNTIME_HEALTH,
    state: "degraded",
    connection: "connecting",
  });
  assert.match(container.textContent ?? "", /Reconnecting/u);
  await render({
    ...CONNECTED_RUNTIME_HEALTH,
    state: "degraded",
    connection: "disconnected",
  });
  assert.match(container.textContent ?? "", /Last updated/u);
  await act(async () => root.unmount());
});

test("project-check discovery can retry while non-code work remains available", async () => {
  let setupCalls = 0;
  const { root, container } = installDom(
    async () => projectResponse(),
    undefined,
    async (projectId) => {
      setupCalls += 1;
      if (setupCalls === 1) throw new Error("Package manifest unavailable.");
      return {
        projectId,
        projectPath: "/project",
        actions: [],
        suites: [],
      };
    },
  );
  await act(async () => root.render(
    <UnifiedMissionControlWorkspace
      project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
      runtimeHealth={CONNECTED_RUNTIME_HEALTH}
      onReturnToConversation={() => {}}
      onOpenConversation={() => {}}
      onError={() => {}}
    />,
  ));
  await act(async () => button(container, "Create work").click());
  assert.match(container.textContent ?? "", /Package manifest unavailable/u);
  assert.equal(button(container, "Add to Ready").disabled, true);
  assert.equal(isMissionWorkItemSubmitDisabled({
    disabled: false,
    willChangeFiles: false,
    projectSetupState: "failed",
    title: "Document release ownership",
    instructions: "Record the responsible operator without changing files.",
  }), false);
  assert.equal(isMissionWorkItemSubmitDisabled({
    disabled: false,
    willChangeFiles: true,
    projectSetupState: "failed",
    title: "Change project files",
    instructions: "Apply the requested project change.",
  }), true);

  const form = container.querySelector(".mission-work-form")!;
  const noChange = [...form.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("No project file changes"))!
    .querySelector("input") as HTMLInputElement;
  act(() => noChange.click());
  assert.equal(noChange.checked, true);
  assert.equal(container.querySelector(".mission-project-checks"), null);

  const changesFiles = [...form.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Yes, project files"))!
    .querySelector("input") as HTMLInputElement;
  act(() => changesFiles.click());
  assert.equal(button(container, "Add to Ready").disabled, true);
  await act(async () => button(container, "Retry").click());
  assert.equal(setupCalls, 2);
  assert.doesNotMatch(container.textContent ?? "", /Package manifest unavailable/u);
  await act(async () => root.unmount());
});

async function renderMutationWorkspace() {
  let current = await createPreviewMissionControlProject(PROJECT_ID, NOW_FOR_TESTS);
  const calls = new Map<string, number>();
  const { root, container } = installDom(
    async () => current,
    async (intent) => {
      const call = (calls.get(intent.type) ?? 0) + 1;
      calls.set(intent.type, call);
      if (call === 1) throw new Error(`${intent.type} failed`);
      current = structuredClone(current);
      current.project.revision += 1;
      current.project.updatedAt = NOW_FOR_TESTS;
      if ("itemId" in intent) {
        const item = current.project.document.items[intent.itemId]!;
        item.version += 1;
        item.updatedAt = NOW_FOR_TESTS;
        if (intent.type === "request_changes") {
          item.phase = "ready";
          item.currentReviewBundleId = undefined;
        } else if (intent.type === "accept") {
          item.phase = "done";
        } else if (intent.type === "reply") {
          const attempt = item.attempts.find(
            (candidate) => candidate.id === intent.attemptId,
          )!;
          attempt.status = "running";
          attempt.pendingRequest = undefined;
          attempt.version += 1;
          attempt.updatedAt = NOW_FOR_TESTS;
        }
      }
      return current;
    },
  );
  await act(async () => root.render(
    <UnifiedMissionControlWorkspace
      project={{ id: PROJECT_ID, path: "/project", label: "Kestrel" }}
      runtimeHealth={CONNECTED_RUNTIME_HEALTH}
      onReturnToConversation={() => {}}
      onOpenConversation={() => {}}
      onError={() => {}}
    />,
  ));
  return { root, container };
}

test("review feedback stays open until authority succeeds", async () => {
  const { root, container } = await renderMutationWorkspace();
  await act(async () => button(container, "Inspect the frozen candidate").click());
  await act(async () => button(container, "Request changes").click());
  const feedback = container.querySelector(".mission-request-changes textarea") as HTMLTextAreaElement;
  await act(async () => changeValue(feedback, "Preserve this exact feedback."));
  await act(async () => button(container, "Send feedback").click());
  assert.equal(feedback.value, "Preserve this exact feedback.");
  assert.ok(container.querySelector(".mission-request-changes"));
  await act(async () => root.unmount());
});

test("waiting replies stay intact until authority succeeds", async () => {
  const { root, container } = await renderMutationWorkspace();
  await act(async () => button(container, "Confirm the release audience").click());
  const reply = container.querySelector('.unified-mission-inspector input[type="text"], .unified-mission-inspector input:not([type])') as HTMLInputElement;
  await act(async () => changeValue(reply, "Release to the Desktop beta group."));
  await act(async () => button(container, "Send exact reply").click());
  assert.equal(reply.value, "Release to the Desktop beta group.");
  await act(async () => root.unmount());
});

test("acceptance confirmation stays open until authority succeeds", async () => {
  const { root, container } = await renderMutationWorkspace();
  await act(async () => button(container, "Inspect the frozen candidate").click());
  await act(async () => button(container, "Accept").click());
  await act(async () => button(container, "Accept and complete").click());
  assert.ok(container.querySelector('[aria-label="Confirm acceptance"]'));
  await act(async () => button(container, "Accept and complete").click());
  assert.equal(container.querySelector('[aria-label="Confirm acceptance"]'), null);
  await act(async () => root.unmount());
});

const NOW_FOR_TESTS = "2026-08-17T12:00:00.000Z";

test("operator input clears only after a successful authority result", () => {
  assert.equal(shouldClearMissionControlOperatorInput(false), false);
  assert.equal(shouldClearMissionControlOperatorInput(true), true);
});
