import test from "node:test";
import assert from "node:assert/strict";

import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import { createEmptyMissionControlProjectDocument } from "../../../src/missionControl/projectAuthority.js";
import {
  executeDesktopMissionControlAction,
  getDesktopMissionControlProject,
  getDesktopOperatorRun,
  getDesktopOperatorThread,
  listDesktopOperatorRuns,
} from "../src/missionControl.js";
import { legacyRecoveryReviewInteractionFixture } from "../../../tests/fixtures/structured-review-contract.js";


const context: WebRunnerRequestContext = {
  actor: {
    actorId: "desktop-shell",
    actorType: "operator",
  },
};

test("Desktop Mission Control reads the canonical project document by registered UUID", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const calls: unknown[] = [];
  const project = {
    projectId,
    schemaVersion: 1 as const,
    revision: 0,
    authorityEpoch: 1,
    document: createEmptyMissionControlProjectDocument(projectId),
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-project",
        type: "mission_control.project",
        ts: "2026-07-10T12:00:00.000Z",
        payload: { projectId, project: { ...project } },
      };
    },
  };

  const response = await getDesktopMissionControlProject({
    adapter,
    projectId,
    context,
  });

  assert.deepEqual(response, { projectId, project });
  assert.deepEqual(calls, [{
    command: { type: "mission_control.project.get", projectId },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects cross-project canonical responses", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const otherProjectId = "22222222-2222-4222-8222-222222222222";
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-project-mismatch",
        type: "mission_control.project",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          projectId: otherProjectId,
          project: {
            projectId: otherProjectId,
            schemaVersion: 1,
            revision: 0,
            authorityEpoch: 1,
            document: createEmptyMissionControlProjectDocument(otherProjectId),
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
        },
      };
    },
  };

  await assert.rejects(
    () => getDesktopMissionControlProject({ adapter, projectId, context }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.mission_control_project_invalid_response",
      );
      return true;
    },
  );
});

test(
  "Desktop sends project-scoped lifecycle actions with exact optimistic identities",
  async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const calls: unknown[] = [];
    const project = {
      projectId,
      schemaVersion: 1 as const,
      revision: 7,
      authorityEpoch: 1,
      document: createEmptyMissionControlProjectDocument(projectId),
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    };
    const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
      async sendControl(command, requestContext) {
        calls.push({ command, requestContext });
        return {
          id: "event-action",
          type: "mission_control.project",
          ts: "2026-07-31T12:00:00.000Z",
          payload: { projectId, project },
        };
      },
    };

    const response = await executeDesktopMissionControlAction({
      adapter,
      intent: {
        type: "start",
        projectId,
        expectedRevision: 6,
        itemId: "item-ready",
        expectedItemVersion: 3,
      },
      registeredProjectIds: [projectId],
      profileId: "desktop",
      actionId: "desktop-action-1",
      actionTs: "2026-07-31T12:00:00.000Z",
      context,
    });
    assert.equal(response.projectId, projectId);
    const sent = calls[0] as {
      command: {
        type: string;
        action: Record<string, unknown>;
      };
      requestContext: WebRunnerRequestContext;
    };
    assert.equal(sent.command.type, "mission_control.action.execute");
    assert.deepEqual(
      {
        projectId: sent.command.action.projectId,
        actionId: sent.command.action.actionId,
        actionTs: sent.command.action.actionTs,
        expectedRevision: sent.command.action.expectedRevision,
        itemId: sent.command.action.itemId,
        expectedItemVersion: sent.command.action.expectedItemVersion,
        type: sent.command.action.type,
        initiatedBy: sent.command.action.initiatedBy,
        profileId: sent.command.action.profileId,
      },
      {
        projectId,
        actionId: "desktop-action-1",
        actionTs: "2026-07-31T12:00:00.000Z",
        expectedRevision: 6,
        itemId: "item-ready",
        expectedItemVersion: 3,
        type: "execution.start",
        initiatedBy: "operator",
        profileId: "desktop",
      },
    );
    assert.match(String(sent.command.action.attemptId), /^[0-9a-f-]{36}$/u);
    assert.match(String(sent.command.action.sessionId), /^[0-9a-f-]{36}$/u);
    assert.equal(
      sent.command.action.threadId,
      sent.command.action.sessionId,
    );
    assert.deepEqual(sent.requestContext, context);

    await assert.rejects(
      executeDesktopMissionControlAction({
        adapter,
        intent: {
          type: "start",
          projectId,
          expectedRevision: 7,
          itemId: "item-ready",
          expectedItemVersion: 3,
        },
        registeredProjectIds: [],
        profileId: "desktop",
        actionId: "desktop-action-unregistered",
        actionTs: "2026-07-31T12:01:00.000Z",
        context,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "desktop.unregistered_mission_control_project",
    );
    assert.equal(calls.length, 1);

    await assert.rejects(
      executeDesktopMissionControlAction({
        adapter,
        intent: {
          type: "configure_autopilot",
          projectId,
          expectedRevision: 7,
          enabled: true,
          wipLimit: 2,
          confirmed: false,
        },
        registeredProjectIds: [projectId],
        profileId: "desktop",
        actionId: "desktop-action-unconfirmed",
        actionTs: "2026-07-31T12:02:00.000Z",
        context,
      }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "desktop.invalid_mission_control_action_intent",
    );
    assert.equal(calls.length, 1);
  },
);

test("Desktop maps editing, follow-ups, and complete Ready ordering to authority actions", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const actions: Record<string, unknown>[] = [];
  const project = {
    projectId,
    schemaVersion: 1 as const,
    revision: 12,
    authorityEpoch: 1,
    document: createEmptyMissionControlProjectDocument(projectId),
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
  };
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      if (command.type === "mission_control.action.execute") {
        actions.push(command.action as Record<string, unknown>);
      }
      return {
        id: "event-action",
        type: "mission_control.project",
        ts: "2026-07-31T12:00:00.000Z",
        payload: { projectId, project },
      };
    },
  };
  const contract = {
    workType: "non_code" as const,
    changeOutcome: "no_change" as const,
    validation: {
      mode: "not_applicable" as const,
      reason: "No project files change.",
    },
    requiredEvidence: [],
  };
  const common = {
    adapter,
    registeredProjectIds: [projectId],
    profileId: "desktop",
    actionTs: "2026-07-31T12:00:00.000Z",
    context,
  };
  await executeDesktopMissionControlAction({
    ...common,
    actionId: "edit-action",
    intent: {
      type: "update",
      projectId,
      expectedRevision: 9,
      itemId: "ready-one",
      expectedItemVersion: 2,
      title: "Clarified work",
      instructions: "Clarified instructions.",
      completionContract: contract,
    },
  });
  await executeDesktopMissionControlAction({
    ...common,
    actionId: "order-action",
    intent: {
      type: "resequence",
      projectId,
      expectedRevision: 10,
      targetPhase: "ready",
      orderedItemIds: ["ready-two", "ready-one"],
    },
  });
  await executeDesktopMissionControlAction({
    ...common,
    actionId: "follow-up-action",
    intent: {
      type: "create",
      projectId,
      expectedRevision: 11,
      title: "Follow up: Accepted work",
      instructions: "Apply a new correction.",
      completionContract: contract,
      followUpToItemId: "done-one",
    },
  });
  assert.deepEqual(actions[0], {
    type: "item.update",
    projectId,
    actionId: "edit-action",
    actionTs: common.actionTs,
    expectedRevision: 9,
    itemId: "ready-one",
    expectedItemVersion: 2,
    title: "Clarified work",
    instructions: "Clarified instructions.",
    completionContract: contract,
  });
  assert.deepEqual(actions[1], {
    type: "item.resequence",
    projectId,
    actionId: "order-action",
    actionTs: common.actionTs,
    expectedRevision: 10,
    targetPhase: "ready",
    orderedItemIds: ["ready-two", "ready-one"],
  });
  assert.equal(actions[2]?.type, "item.create");
  assert.equal(actions[2]?.followUpToItemId, "done-one");
});

test("Desktop Mission Control projects runtime thread inspection through the runner", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-thread",
        type: "operator.thread",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            thread: {
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              title: "Canonical web cutover",
              status: "RUNNING",
              activeRunId: "run-1",
              agentProfileLabel: "Kestrel build",
              createdAt: "2026-07-10T11:00:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            },
            childThreads: [{
              threadId: "thread-child:session-1",
              sessionId: "session-1",
              title: "Verify Desktop bridge",
              status: "WAITING",
              parentThreadId: "thread-main:session-1",
              createdAt: "2026-07-10T11:30:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            }],
            dialogs: [{
              dialogId: "dialog-1",
              name: "Peregrine",
              status: "open",
              childThreadId: "thread-child:session-1",
              messages: [{
                messageId: "dialog-message-1",
                dialogId: "dialog-1",
                parentRunId: "run-1",
                name: "Peregrine",
                childSessionId: "thread-child:session-1",
                sender: "collaborator",
                text: "The bridge is verified.",
                createdAt: "2026-07-10T11:59:00.000Z",
              }],
            }],
            childBlockerChain: [],
            workspace: {
              kind: "managed",
              workspaceId: "workspace-a",
              label: "Project A",
              workspaceRoot: "/tmp/managed/project-a",
              sourceWorkspaceRoot: "/tmp/project-a",
              sourceRepoRoot: "/tmp/project-a",
              managedWorktreeRoot: "/tmp/managed/project-a",
              baseHead: "base-sha",
              lastObservedSourceHead: "source-sha",
              leaseId: "lease-1",
              leaseKind: "run",
              dirty: true,
            },
            focusedThreadId: "thread-main:session-1",
            operatorPhase: "act",
            blocker: {
              kind: "checkpoint",
              summary: "Desktop package smoke is required.",
              actionable: true,
              threadId: "thread-main:session-1",
            },
            nextAction: {
              kind: "resolve_context_checkpoint",
              summary: "Run packaged Electron smoke.",
              threadId: "thread-main:session-1",
              checkpointId: "checkpoint-1",
            },
            runtimePlan: {
              phase: "verify",
              status: "running",
              expectedNextCommand: "pnpm desktop:test",
              commandNames: ["pnpm desktop:test"],
            },
            activeRun: { runId: "run-1", status: "RUNNING" },
            followUpQueue: {
              state: "paused",
              pauseReason: "operator",
              items: [{
                followUpId: "follow-up-1",
                message: "Run the package smoke next.",
                attachmentIds: ["attachment-1"],
                interactionMode: "build",
                actSubmode: "safe",
                source: "human",
                sourceMessageId: "message-1",
                createdAt: "2026-07-10T12:00:00.000Z",
                state: "queued",
              }],
            },
            inboxItems: [{
              itemId: "request:request-1",
              kind: "user_input_request",
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              title: "Choose the verification target.",
              actionable: true,
              requestId: "request-1",
              interaction: {
                ...structuredClone(legacyRecoveryReviewInteractionFixture),
                requestId: "request-1",
              },
              createdAt: "2026-07-10T12:00:00.000Z",
            }],
          },
        },
      };
    },
  };

  const response = await getDesktopOperatorThread({
    adapter,
    threadId: "thread-main:session-1",
    context,
  });

  assert.equal(response.thread.activeRunId, "run-1");
  assert.equal(response.thread.status, "RUNNING");
  assert.deepEqual(response.workspace, {
    kind: "managed",
    workspaceId: "workspace-a",
    label: "Project A",
    workspaceRoot: "/tmp/managed/project-a",
    sourceWorkspaceRoot: "/tmp/project-a",
    sourceRepoRoot: "/tmp/project-a",
    managedWorktreeRoot: "/tmp/managed/project-a",
    baseHead: "base-sha",
    lastObservedSourceHead: "source-sha",
    leaseId: "lease-1",
    leaseKind: "run",
    dirty: true,
  });
  assert.equal(response.blocker?.summary, "Desktop package smoke is required.");
  assert.equal(response.nextAction?.checkpointId, "checkpoint-1");
  assert.deepEqual(response.runtimePlan?.commandNames, ["pnpm desktop:test"]);
  assert.deepEqual(response.activeRun, { runId: "run-1", status: "RUNNING" });
  assert.equal(response.followUpQueue.pauseReason, "operator");
  assert.equal(response.followUpQueue.items[0]?.attachmentIds[0], "attachment-1");
  assert.equal(response.followUpQueue.items[0]?.source, "human");
  assert.equal(response.followUpQueue.items[0]?.sourceMessageId, "message-1");
  assert.equal(response.inboxItems[0]?.requestId, "request-1");
  assert.equal(
    response.inboxItems[0]?.interaction?.metadata?.reason,
    "recovery_review",
  );
  assert.deepEqual(response.childThreads.map((thread) => thread.threadId), ["thread-child:session-1"]);
  assert.equal(response.dialogs?.[0]?.messages[0]?.parentRunId, "run-1");
  assert.deepEqual(calls, [{
    command: { type: "operator.thread", threadId: "thread-main:session-1" },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime thread responses", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-thread-invalid",
        type: "operator.thread",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            thread: {
              threadId: "thread-main:session-1",
              sessionId: "session-1",
              title: "Broken thread",
              status: "UNKNOWN",
              createdAt: "2026-07-10T11:00:00.000Z",
              updatedAt: "2026-07-10T12:00:00.000Z",
            },
            childThreads: [],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => getDesktopOperatorThread({
      adapter,
      threadId: "thread-main:session-1",
      context,
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_thread_invalid_response",
      );
      return true;
    },
  );
});

test("Desktop Mission Control projects a bounded runtime run and session index", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-runs",
        type: "operator.runs",
        ts: "2026-07-10T12:00:03.000Z",
        payload: {
          view: {
            version: "operator-run-index-v1",
            generatedAt: "2026-07-10T12:00:03.000Z",
            filters: { sessionId: "session-1", status: "WAITING", limit: 10 },
            hasMore: false,
            runs: [{
              run: {
                runId: "run-1",
                sessionId: "session-1",
                eventType: "user.message",
                status: "WAITING",
                startedAt: "2026-07-10T12:00:00.000Z",
              },
              threadId: "thread-main:session-1",
              summary: { eventCount: 3, truncated: false },
              diagnosis: {
                status: "WAITING",
                finalStep: "exec.wait_approval",
                actionable: true,
                wait: {
                  kind: "approval",
                  actionable: true,
                  requestId: "request-1",
                },
              },
            }],
            sessions: [{
              sessionId: "session-1",
              runCount: 1,
              statusCounts: { RUNNING: 0, WAITING: 1, COMPLETED: 0, FAILED: 0 },
              latestRunId: "run-1",
              latestStatus: "WAITING",
              latestStartedAt: "2026-07-10T12:00:00.000Z",
            }],
          },
        },
      };
    },
  };

  const response = await listDesktopOperatorRuns({
    adapter,
    query: { sessionId: "session-1", status: "WAITING", limit: 10 },
    context,
  });

  assert.equal(response.version, "operator-run-index-v1");
  assert.equal(response.runs[0]?.run.runId, "run-1");
  assert.equal(response.runs[0]?.diagnosis.wait?.kind, "approval");
  assert.equal(response.sessions[0]?.statusCounts.WAITING, 1);
  assert.deepEqual(calls, [{
    command: {
      type: "operator.runs",
      sessionId: "session-1",
      status: "WAITING",
      limit: 10,
    },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime run indexes", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-runs-invalid",
        type: "operator.runs",
        ts: "2026-07-10T12:00:03.000Z",
        payload: {
          view: {
            version: "operator-run-index-v1",
            generatedAt: "2026-07-10T12:00:03.000Z",
            filters: { limit: 51 },
            hasMore: false,
            runs: [],
            sessions: [],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => listDesktopOperatorRuns({ adapter, context }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_runs_invalid_response",
      );
      return true;
    },
  );
});

test("Desktop Mission Control projects bounded runtime run inspection through the runner", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command, requestContext) {
      calls.push({ command, requestContext });
      return {
        id: "event-run",
        type: "operator.run",
        ts: "2026-07-10T12:00:02.000Z",
        runId: "run-1",
        sessionId: "session-1",
        threadId: "thread-main:session-1",
        payload: {
          view: {
            version: "operator-run-v1",
            run: {
              runId: "run-1",
              sessionId: "session-1",
              eventType: "user.message",
              status: "WAITING",
              startedAt: "2026-07-10T12:00:00.000Z",
            },
            threadId: "thread-main:session-1",
            summary: {
              eventCount: 3,
              firstEventAt: "2026-07-10T12:00:00.000Z",
              lastEventAt: "2026-07-10T12:00:02.000Z",
              stepsObserved: 1,
              progressToolCalls: 1,
              waitingMilestones: 1,
              truncated: false,
            },
            diagnosis: {
              status: "WAITING",
              finalStep: "exec.wait_approval",
              actionable: true,
              wait: {
                kind: "approval",
                actionable: true,
                eventType: "operator.approval",
                threadId: "thread-main:session-1",
                requestId: "request-1",
                enteredAt: "2026-07-10T12:00:02.000Z",
              },
              latestReasoning: {
                message: "Package proof requires approval.",
                at: "2026-07-10T12:00:01.000Z",
              },
            },
            modelProvenance: {
              retention: "hash_only",
              callCount: 1,
              actionCallCount: 1,
              maintenanceCallCount: 0,
              providers: ["openai"],
              models: ["gpt-5"],
            },
            runtimePlan: {
              phase: "verify",
              currentChunk: "Packaged smoke",
              status: "waiting",
              expectedNextCommand: "pnpm --filter @kestrel/desktop package",
            },
            timeline: [{
              seq: 1,
              at: "2026-07-10T12:00:00.000Z",
              label: "run started",
              source: "engine",
            }, {
              seq: 2,
              at: "2026-07-10T12:00:02.000Z",
              label: "wait entered",
              detail: "eventType=operator.approval",
              source: "wait",
              step: "exec.wait_approval",
              stepIndex: 4,
            }],
          },
        },
      };
    },
  };

  const response = await getDesktopOperatorRun({
    adapter,
    runId: "run-1",
    context,
  });

  assert.equal(response.run.status, "WAITING");
  assert.equal(response.diagnosis.wait?.requestId, "request-1");
  assert.equal(response.modelProvenance.callCount, 1);
  assert.equal(response.timeline[1]?.source, "wait");
  assert.deepEqual(calls, [{
    command: { type: "operator.run", runId: "run-1" },
    requestContext: context,
  }]);
});

test("Desktop Mission Control rejects malformed runtime run responses", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl() {
      return {
        id: "event-run-invalid",
        type: "operator.run",
        ts: "2026-07-10T12:00:00.000Z",
        payload: {
          view: {
            version: "operator-run-v1",
            run: {
              runId: "run-1",
              sessionId: "session-1",
              eventType: "user.message",
              status: "WAITING",
              startedAt: "2026-07-10T12:00:00.000Z",
            },
            summary: {
              eventCount: 1,
              stepsObserved: 0,
              progressToolCalls: 0,
              waitingMilestones: 0,
              truncated: false,
            },
            diagnosis: {
              status: "WAITING",
              actionable: false,
            },
            modelProvenance: {
              retention: "hash_only",
              callCount: 0,
              actionCallCount: 0,
              maintenanceCallCount: 0,
              providers: [],
              models: [],
            },
            timeline: [{
              seq: 0,
              at: "not-a-timestamp",
              label: "broken",
              source: "unknown",
            }],
          },
        },
      } as never;
    },
  };

  await assert.rejects(
    () => getDesktopOperatorRun({ adapter, runId: "run-1", context }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "desktop.operator_run_invalid_response",
      );
      return true;
    },
  );
});
