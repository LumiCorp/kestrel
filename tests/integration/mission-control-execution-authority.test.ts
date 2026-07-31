import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import type {
  RunnerCommandMetadata,
  RunnerCommandPayloadByType,
  RunnerCommandType,
  RunnerEvent,
} from "@kestrel-agents/protocol";

import type { TuiProfile } from "../../cli/contracts.js";
import { CommandRouter } from "../../cli/runner/CommandRouter.js";
import { EventWriter } from "../../cli/runner/EventWriter.js";
import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  MissionControlExecutionRuntime,
  type MissionControlRunnerCommandClient,
} from "../../src/missionControl/executionRuntime.js";
import {
  MissionControlExecutionService,
  missionControlActiveWorkCount,
} from "../../src/missionControl/executionAuthority.js";
import { MissionControlProjectService } from "../../src/missionControl/projectAuthority.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_TS = "2026-07-30T12:00:00.000Z";

contractTest(
  "runtime.mission-control-execution-authority",
  "real runner accepts and exposes the exact reserved Mission Control identity",
  async () => {
    const output = new PassThrough();
    const writer = new EventWriter(output);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let receivedMissionControl:
      | RunnerCommandPayloadByType["run.start"]["turn"]["missionControl"]
      | undefined;
    const host = new RunnerHost(writer, () => ({
      runTurn: async (turn) => {
        receivedMissionControl = turn.missionControl;
        await gate;
        return completedResult(turn.sessionId, turn.runId!);
      },
      close: async () => {},
    }));
    const router = new CommandRouter(host, writer);
    const events: RunnerEvent[] = [];
    const reader = readline.createInterface({ input: output, terminal: false });
    reader.on("line", (line) => {
      events.push(JSON.parse(line) as RunnerEvent);
    });
    const profile: TuiProfile = {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    };
    const command = router.acceptLine(JSON.stringify({
      id: "mission-command-real",
      type: "run.start",
      payload: {
        profile,
        turn: {
          sessionId: "mission-session-real",
          runId: "mission-run-real",
          message: "Execute the exact canonical work item.",
          eventType: "mission_control.work_item",
          missionControl: {
            projectId: PROJECT_ID,
            itemId: "work-real",
            attemptId: "attempt-real",
            commandId: "mission-command-real",
            runId: "mission-run-real",
          },
        },
      },
    }));
    await waitFor(
      () => events.some((entry) => entry.type === "run.started"),
    );
    const started = events.find(
      (entry): entry is Extract<RunnerEvent, { type: "run.started" }> =>
        entry.type === "run.started",
    );
    assert.ok(started);
    assert.equal(started.commandId, "mission-command-real");
    assert.equal(started.sessionId, "mission-session-real");
    assert.equal(started.threadId, "mission-session-real");
    assert.equal(started.runId, "mission-run-real");
    assert.deepEqual(receivedMissionControl, {
      projectId: PROJECT_ID,
      itemId: "work-real",
      attemptId: "attempt-real",
      commandId: "mission-command-real",
      runId: "mission-run-real",
    });
    release();
    await command;
    reader.close();
    await host.close();
  },
);

contractTest(
  "runtime.mission-control-execution-authority",
  "canonical attempts control exact runner execution and recover without duplicate dispatch",
  async () => {
    const store = new InMemorySessionStore();
    const projects = new MissionControlProjectService(store);
    await projects.execute({
      type: "item.create",
      projectId: PROJECT_ID,
      actionId: "create-work",
      actionTs: ACTION_TS,
      expectedRevision: 0,
      itemId: "work-1",
      title: "Implement exact execution",
      instructions: "Exercise the real Mission Control execution contract.",
      createdBy: "operator",
      order: 0,
    });
    await projects.execute({
      type: "item.create",
      projectId: PROJECT_ID,
      actionId: "create-second-work",
      actionTs: ACTION_TS,
      expectedRevision: 1,
      itemId: "work-2",
      title: "Respect project WIP",
      instructions: "This work must not start while the first attempt is active.",
      createdBy: "operator",
      order: 1,
    });

    const runner = new ControlledRunner();
    const runtime = new MissionControlExecutionRuntime(store, runner, {
      now: () => ACTION_TS,
    });
    const starting = await runtime.execute({
      type: "execution.start",
      projectId: PROJECT_ID,
      actionId: "start-work",
      actionTs: ACTION_TS,
      expectedRevision: 2,
      itemId: "work-1",
      expectedItemVersion: 1,
      attemptId: "attempt-1",
      initiatedBy: "operator",
      profileId: "reference",
      sessionId: "mission-session-1",
      threadId: "mission-session-1",
    });
    assert.equal(currentAttempt(starting)?.status, "starting");
    assert.equal(missionControlActiveWorkCount(starting.project.document), 1);
    assert.equal(runner.commandCount("run.start"), 0);
    await assert.rejects(
      new MissionControlExecutionService(store).execute({
        type: "execution.start",
        projectId: PROJECT_ID,
        actionId: "start-second-work",
        actionTs: ACTION_TS,
        expectedRevision: starting.project.revision,
        itemId: "work-2",
        expectedItemVersion:
          starting.project.document.items["work-2"]!.version,
        attemptId: "attempt-second",
        initiatedBy: "operator",
        profileId: "reference",
        sessionId: "mission-session-2",
        threadId: "mission-session-2",
      }),
      /WIP limit has been reached/u,
    );

    await runner.waitForCommand("run.start");
    const startCommand = runner.latestCommand("run.start");
    assert.ok(startCommand);
    assert.equal(currentAttempt(await projects.getProject(PROJECT_ID))?.status, "starting");
    runner.acceptStart(startCommand.commandId);
    await runtime.dispatchPending(PROJECT_ID);

    let project = await projects.getProject(PROJECT_ID);
    let attempt = currentAttempt(project);
    assert.equal(attempt?.status, "running");
    assert.equal(missionControlActiveWorkCount(project.document), 1);
    assert.deepEqual(attempt?.runs.map((run) => ({
      sessionId: run.sessionId,
      threadId: run.threadId,
      runId: run.runId,
      commandId: run.commandId,
    })), [{
      sessionId: "mission-session-1",
      threadId: "mission-session-1",
      runId: "attempt-1",
      commandId: startCommand.commandId,
    }]);

    runner.setWaiting("attempt-1", {
      kind: "user_input",
      requestId: "request-1",
      eventType: "user.reply",
    });
    await runtime.reconcile(PROJECT_ID);
    project = await projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project);
    assert.equal(attempt?.status, "waiting");
    assert.equal(missionControlActiveWorkCount(project.document), 1);
    assert.equal(attempt?.pendingRequest?.requestId, "request-1");
    const waitingRevision = project.revision;
    await runtime.reconcile(PROJECT_ID);
    assert.equal(
      (await projects.getProject(PROJECT_ID)).revision,
      waitingRevision,
    );

    await runtime.execute({
      type: "execution.reply",
      projectId: PROJECT_ID,
      actionId: "reply-request",
      actionTs: ACTION_TS,
      expectedRevision: project.revision,
      itemId: "work-1",
      expectedItemVersion: project.document.items["work-1"]!.version,
      attemptId: attempt!.id,
      expectedAttemptVersion: attempt!.version,
      requestId: "request-1",
      message: "Use the existing exact runner contract.",
    });
    await runtime.dispatchPending(PROJECT_ID);
    project = await projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project);
    assert.equal(attempt?.status, "running");
    assert.equal(attempt?.runs.length, 2);
    assert.equal(attempt?.pendingRequest, undefined);
    assert.equal(attempt?.pendingResponse, undefined);

    const resumedRun = attempt!.runs.at(-1)!;
    await assert.rejects(
      runtime.execute({
        type: "execution.stop",
        projectId: PROJECT_ID,
        actionId: "stop-wrong-run",
        actionTs: ACTION_TS,
        expectedRevision: project.revision,
        itemId: "work-1",
        expectedItemVersion: project.document.items["work-1"]!.version,
        attemptId: attempt!.id,
        expectedAttemptVersion: attempt!.version,
        runId: "not-the-current-run",
        commandId: resumedRun.commandId,
      }),
      /runtime identity does not match the current attempt/u,
    );
    const execution = new MissionControlExecutionService(store);
    const stopping = await execution.execute({
      type: "execution.stop",
      projectId: PROJECT_ID,
      actionId: "stop-current-run",
      actionTs: ACTION_TS,
      expectedRevision: project.revision,
      itemId: "work-1",
      expectedItemVersion: project.document.items["work-1"]!.version,
      attemptId: attempt!.id,
      expectedAttemptVersion: attempt!.version,
      runId: resumedRun.runId,
      commandId: resumedRun.commandId,
    });
    assert.equal(currentAttempt(stopping)?.status, "cancelling");
    assert.equal(
      missionControlActiveWorkCount(stopping.project.document),
      1,
    );
    const repeatedStop = await execution.execute({
      type: "execution.stop",
      projectId: PROJECT_ID,
      actionId: "stop-current-run-again",
      actionTs: ACTION_TS,
      expectedRevision: stopping.project.revision,
      itemId: "work-1",
      expectedItemVersion:
        stopping.project.document.items["work-1"]!.version,
      attemptId: attempt!.id,
      expectedAttemptVersion: currentAttempt(stopping)!.version,
      runId: resumedRun.runId,
      commandId: resumedRun.commandId,
    });
    assert.equal(currentAttempt(repeatedStop)?.status, "cancelling");
    assert.equal(repeatedStop.effects.length, 0);
    await runtime.dispatchPending(PROJECT_ID);
    project = await projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project);
    assert.equal(attempt?.status, "cancelled");
    assert.equal(missionControlActiveWorkCount(project.document), 0);
    assert.equal(project.document.items["work-1"]?.phase, "needs_attention");
    assert.equal(
      project.document.items["work-1"]?.attentionReason,
      "operator_stopped",
    );

    await runtime.execute({
      type: "execution.retry",
      projectId: PROJECT_ID,
      actionId: "retry-work",
      actionTs: ACTION_TS,
      expectedRevision: project.revision,
      itemId: "work-1",
      expectedItemVersion: project.document.items["work-1"]!.version,
      attemptId: "attempt-2",
    });
    await runtime.dispatchPending(PROJECT_ID);
    project = await projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project);
    assert.equal(attempt?.id, "attempt-2");
    assert.equal(attempt?.generation, 2);
    assert.equal(attempt?.status, "running");
    assert.equal(
      project.document.items["work-1"]?.attempts[0]?.status,
      "cancelled",
    );

    runner.emitTerminal(
      resumedRun.commandId,
      resumedRun.runId,
      "run.completed",
    );
    await runtime.reconcile(PROJECT_ID);
    project = await projects.getProject(PROJECT_ID);
    assert.equal(currentAttempt(project)?.id, "attempt-2");
    assert.equal(currentAttempt(project)?.status, "running");
    assert.equal(
      project.document.history.at(-1)?.disposition,
      "stale",
    );

    runtime.close();
  },
);

contractTest(
  "runtime.mission-control-execution-authority",
  "pending outbox converges before and after dispatch without duplicate execution",
  async () => {
    const disconnected = await createPendingStart("disconnected");
    const disconnectedRuntime = new MissionControlExecutionRuntime(
      disconnected.store,
      new FailingRunner(new Error("runner transport disconnected")),
      { now: () => ACTION_TS },
    );
    await disconnectedRuntime.dispatchPending(PROJECT_ID);
    const disconnectedOutbox =
      await disconnected.store.listMissionControlOutbox(PROJECT_ID);
    assert.equal(disconnectedOutbox[0]?.status, "PENDING");
    assert.equal(disconnectedOutbox[0]?.attemptCount, 1);
    assert.equal(
      currentAttempt(
        await disconnected.projects.getProject(PROJECT_ID),
      )?.status,
      "starting",
    );
    disconnectedRuntime.close();

    const reconnectedRunner = new ControlledRunner();
    const reconnectedRuntime = new MissionControlExecutionRuntime(
      disconnected.store,
      reconnectedRunner,
      { now: () => ACTION_TS },
    );
    const reconnecting = reconnectedRuntime.reconcile(PROJECT_ID);
    await reconnectedRunner.waitForCommand("run.start");
    reconnectedRunner.acceptStart(
      reconnectedRunner.latestCommand("run.start")!.commandId,
    );
    await reconnecting;
    assert.equal(reconnectedRunner.commandCount("run.start"), 1);
    assert.equal(
      currentAttempt(
        await disconnected.projects.getProject(PROJECT_ID),
      )?.status,
      "running",
    );
    reconnectedRuntime.close();

    const rejected = await createPendingStart("rejected");
    const rejectedRuntime = new MissionControlExecutionRuntime(
      rejected.store,
      new FailingRunner(
        runnerError("RUN_PROFILE_NOT_FOUND", { profileId: "reference" }),
      ),
      { now: () => ACTION_TS },
    );
    await rejectedRuntime.dispatchPending(PROJECT_ID);
    const rejectedProject = await rejected.projects.getProject(PROJECT_ID);
    assert.equal(currentAttempt(rejectedProject)?.status, "failed");
    assert.equal(
      rejectedProject.document.items["work-1"]?.phase,
      "needs_attention",
    );
    assert.equal(
      rejectedProject.document.items["work-1"]?.attentionReason,
      "start_rejected",
    );
    rejectedRuntime.close();

    const beforeDispatch = await createPendingStart("before-dispatch");
    const beforeRunner = new ControlledRunner();
    const beforeRuntime = new MissionControlExecutionRuntime(
      beforeDispatch.store,
      beforeRunner,
      { now: () => ACTION_TS },
    );
    void beforeRuntime.reconcile(PROJECT_ID);
    await beforeRunner.waitForCommand("run.start");
    const beforeCommand = beforeRunner.latestCommand("run.start")!;
    beforeRunner.acceptStart(beforeCommand.commandId);
    await beforeRuntime.dispatchPending(PROJECT_ID);
    assert.equal(beforeRunner.commandCount("run.start"), 1);
    assert.equal(
      currentAttempt(await beforeDispatch.projects.getProject(PROJECT_ID))?.status,
      "running",
    );
    beforeRuntime.close();

    const afterDispatch = await createPendingStart("after-dispatch");
    const pendingEffect = (
      await afterDispatch.store.listMissionControlOutbox(PROJECT_ID)
    )[0]!;
    const afterRunner = new ControlledRunner();
    afterRunner.seedProjection({
      projectId: PROJECT_ID,
      itemId: "work-1",
      attemptId: "attempt-after-dispatch",
      commandId: pendingEffect.effectId,
      runId: "attempt-after-dispatch",
      sessionId: "session-after-dispatch",
      threadId: "session-after-dispatch",
      status: "RUNNING",
    });
    const afterRuntime = new MissionControlExecutionRuntime(
      afterDispatch.store,
      afterRunner,
      { now: () => ACTION_TS },
    );
    await afterRuntime.reconcile(PROJECT_ID);
    assert.equal(afterRunner.commandCount("run.start"), 0);
    assert.equal(
      currentAttempt(await afterDispatch.projects.getProject(PROJECT_ID))?.status,
      "running",
    );
    assert.equal(
      (await afterDispatch.store.listMissionControlOutbox(PROJECT_ID))[0]?.status,
      "DELIVERED",
    );
    afterRuntime.close();

    const orphaned = await createPendingStart("orphaned");
    const orphanRunner = new ControlledRunner();
    const orphanRuntime = new MissionControlExecutionRuntime(
      orphaned.store,
      orphanRunner,
      { now: () => ACTION_TS },
    );
    const startingOrphan = orphanRuntime.dispatchPending(PROJECT_ID);
    await orphanRunner.waitForCommand("run.start");
    orphanRunner.acceptStart(
      orphanRunner.latestCommand("run.start")!.commandId,
    );
    await startingOrphan;
    orphanRuntime.close();
    orphanRunner.deleteProjection("attempt-orphaned");

    const relaunched = new MissionControlExecutionRuntime(
      orphaned.store,
      orphanRunner,
      { now: () => ACTION_TS },
    );
    await relaunched.reconcile(PROJECT_ID);
    const orphanedProject = await orphaned.projects.getProject(PROJECT_ID);
    assert.equal(currentAttempt(orphanedProject)?.status, "orphaned");
    assert.equal(
      orphanedProject.document.items["work-1"]?.phase,
      "needs_attention",
    );
    assert.equal(
      orphanedProject.document.items["work-1"]?.attentionReason,
      "runner_orphaned",
    );
    relaunched.close();

    const cancelledAfterDispatch =
      await startControlledAttempt("cancel-after-dispatch");
    let cancelProject =
      await cancelledAfterDispatch.projects.getProject(PROJECT_ID);
    const cancelAttempt = currentAttempt(cancelProject)!;
    const cancelRun = cancelAttempt.runs.at(-1)!;
    await new MissionControlExecutionService(
      cancelledAfterDispatch.store,
    ).execute({
      type: "execution.stop",
      projectId: PROJECT_ID,
      actionId: "stop-before-relaunch",
      actionTs: ACTION_TS,
      expectedRevision: cancelProject.revision,
      itemId: "work-1",
      expectedItemVersion:
        cancelProject.document.items["work-1"]!.version,
      attemptId: cancelAttempt.id,
      expectedAttemptVersion: cancelAttempt.version,
      runId: cancelRun.runId,
      commandId: cancelRun.commandId,
    });
    cancelledAfterDispatch.runtime.close();
    cancelledAfterDispatch.runner.setCancelled(cancelRun.runId);
    const cancelRelaunch = new MissionControlExecutionRuntime(
      cancelledAfterDispatch.store,
      cancelledAfterDispatch.runner,
      { now: () => ACTION_TS },
    );
    await cancelRelaunch.reconcile(PROJECT_ID);
    cancelProject =
      await cancelledAfterDispatch.projects.getProject(PROJECT_ID);
    assert.equal(currentAttempt(cancelProject)?.status, "cancelled");
    assert.equal(
      cancelledAfterDispatch.runner.commandCount("run.cancel"),
      0,
    );
    const cancelOutbox =
      await cancelledAfterDispatch.store.listMissionControlOutbox(PROJECT_ID);
    assert.equal(
      cancelOutbox.find(
        (entry) =>
          entry.effectType === "mission-control.execution.cancel",
      )?.status,
      "DELIVERED",
    );
    cancelRelaunch.close();
  },
);

contractTest(
  "runtime.mission-control-execution-authority",
  "already-stopped and changed-run cancellation outcomes converge truthfully",
  async () => {
    const changed = await startControlledAttempt("changed-run");
    let project = await changed.projects.getProject(PROJECT_ID);
    let attempt = currentAttempt(project)!;
    const changedRun = attempt.runs.at(-1)!;
    changed.runner.failCancel(changedRun.runId, {
      activeRunId: "different-active-run",
      activeCommandId: "different-active-command",
    });
    await changed.runtime.execute({
      type: "execution.stop",
      projectId: PROJECT_ID,
      actionId: "stop-changed-run",
      actionTs: ACTION_TS,
      expectedRevision: project.revision,
      itemId: "work-1",
      expectedItemVersion: project.document.items["work-1"]!.version,
      attemptId: attempt.id,
      expectedAttemptVersion: attempt.version,
      runId: changedRun.runId,
      commandId: changedRun.commandId,
    });
    await changed.runtime.dispatchPending(PROJECT_ID);
    project = await changed.projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project)!;
    assert.equal(attempt.status, "orphaned");
    assert.equal(
      project.document.items["work-1"]?.attentionReason,
      "runtime_authority_changed",
    );
    assert.equal(
      attempt.terminalReasonCode,
      "MISSION_CONTROL_CANCEL_TARGET_CHANGED",
    );
    changed.runtime.close();

    const stopped = await startControlledAttempt("already-stopped");
    project = await stopped.projects.getProject(PROJECT_ID);
    attempt = currentAttempt(project)!;
    const stoppedRun = attempt.runs.at(-1)!;
    stopped.runner.setCancelled(stoppedRun.runId);
    stopped.runner.failCancel(stoppedRun.runId, {});
    await stopped.runtime.execute({
      type: "execution.stop",
      projectId: PROJECT_ID,
      actionId: "stop-already-stopped",
      actionTs: ACTION_TS,
      expectedRevision: project.revision,
      itemId: "work-1",
      expectedItemVersion: project.document.items["work-1"]!.version,
      attemptId: attempt.id,
      expectedAttemptVersion: attempt.version,
      runId: stoppedRun.runId,
      commandId: stoppedRun.commandId,
    });
    await stopped.runtime.dispatchPending(PROJECT_ID);
    project = await stopped.projects.getProject(PROJECT_ID);
    assert.equal(currentAttempt(project)?.status, "cancelled");
    assert.equal(
      project.document.items["work-1"]?.attentionReason,
      "operator_stopped",
    );
    stopped.runtime.close();
  },
);

async function createPendingStart(label: string) {
  const store = new InMemorySessionStore();
  const projects = new MissionControlProjectService(store);
  await projects.execute({
    type: "item.create",
    projectId: PROJECT_ID,
    actionId: `create-${label}`,
    actionTs: ACTION_TS,
    expectedRevision: 0,
    itemId: "work-1",
    title: label,
    instructions: "Recover this exact pending execution.",
    createdBy: "operator",
    order: 0,
  });
  await new MissionControlExecutionService(store).execute({
    type: "execution.start",
    projectId: PROJECT_ID,
    actionId: `start-${label}`,
    actionTs: ACTION_TS,
    expectedRevision: 1,
    itemId: "work-1",
    expectedItemVersion: 1,
    attemptId: `attempt-${label}`,
    initiatedBy: "operator",
    profileId: "reference",
    sessionId: `session-${label}`,
    threadId: `session-${label}`,
  });
  return { store, projects };
}

async function startControlledAttempt(label: string) {
  const pending = await createPendingStart(label);
  const runner = new ControlledRunner();
  const runtime = new MissionControlExecutionRuntime(pending.store, runner, {
    now: () => ACTION_TS,
  });
  const dispatching = runtime.dispatchPending(PROJECT_ID);
  await runner.waitForCommand("run.start");
  runner.acceptStart(runner.latestCommand("run.start")!.commandId);
  await dispatching;
  return { ...pending, runner, runtime };
}

function currentAttempt(
  project:
    | Awaited<ReturnType<MissionControlProjectService["getProject"]>>
    | MissionControlProjectMutationResultLike,
) {
  const item = project.document === undefined
    ? project.project.document.items["work-1"]
    : project.document.items["work-1"];
  return item?.attempts.find((attempt) => attempt.id === item.currentAttemptId);
}

type MissionControlProjectMutationResultLike = {
  project: {
    document: Awaited<
      ReturnType<MissionControlProjectService["getProject"]>
    >["document"];
  };
  document?: never;
};

interface ProjectionSeed {
  projectId: string;
  itemId: string;
  attemptId: string;
  commandId: string;
  runId: string;
  sessionId: string;
  threadId: string;
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  terminalReasonCode?: string | undefined;
  errorMessage?: string | undefined;
  wait?: {
    kind:
      | "approval"
      | "user_input"
      | "delegation"
      | "scheduler_wait"
      | "compaction_checkpoint"
      | "unknown";
    requestId: string;
    eventType?: string | undefined;
  } | undefined;
}

class ControlledRunner implements MissionControlRunnerCommandClient {
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly commands: Array<{
    commandId: string;
    type: RunnerCommandType;
    payload: unknown;
  }> = [];
  private readonly projections = new Map<string, ProjectionSeed>();
  private readonly pendingStarts = new Map<
    string,
    { payload: RunnerCommandPayloadByType["run.start"] }
  >();
  private readonly cancelFailures = new Map<
    string,
    Record<string, unknown>
  >();

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    commandId: string,
    type: TType,
    payload: RunnerCommandPayloadByType[TType],
    _metadata?: RunnerCommandMetadata,
  ): Promise<RunnerEvent> {
    this.commands.push({ commandId, type, payload });
    if (type === "run.start") {
      this.pendingStarts.set(commandId, {
        payload: payload as RunnerCommandPayloadByType["run.start"],
      });
      return new Promise<RunnerEvent>(() => {});
    }
    if (type === "operator.control") {
      const control =
        payload as RunnerCommandPayloadByType["operator.control"];
      const correlation = control.missionControl!;
      const sessionId =
        this.projections.get(correlation.attemptId)?.sessionId ??
        control.threadId;
      this.seedProjection({
        ...correlation,
        sessionId,
        threadId: control.threadId,
        status: "RUNNING",
      });
      return event({
        id: `event-${commandId}`,
        type: "operator.controlled",
        commandId,
        sessionId,
        threadId: control.threadId,
        runId: correlation.runId,
        payload: {
          sessionId,
          threadId: control.threadId,
          runId: correlation.runId,
          disposition: "accepted",
        },
      });
    }
    if (type === "run.cancel") {
      const cancel = payload as RunnerCommandPayloadByType["run.cancel"];
      const forcedFailure = this.cancelFailures.get(cancel.runId!);
      if (forcedFailure !== undefined) {
        throw runnerError("RUN_CANCEL_NOT_FOUND", forcedFailure);
      }
      const projection = this.projections.get(cancel.runId!);
      if (
        projection === undefined ||
        projection.commandId !== cancel.commandId
      ) {
        throw runnerError("RUN_CANCEL_NOT_FOUND", {
          sessionId: cancel.sessionId,
        });
      }
      projection.status = "FAILED";
      projection.terminalReasonCode = "RUN_CANCELLED";
      projection.errorMessage = "Operator cancelled the run.";
      return event({
        id: `event-${commandId}`,
        type: "run.cancelled",
        commandId,
        sessionId: cancel.sessionId,
        threadId: projection.threadId,
        runId: cancel.runId,
        payload: {
          sessionId: cancel.sessionId,
          runId: cancel.runId,
          result: terminalResult(cancel.sessionId, cancel.runId!, "CANCELLED"),
        },
      });
    }
    if (type === "operator.run") {
      const runId = (
        payload as RunnerCommandPayloadByType["operator.run"]
      ).runId;
      const projection = this.projections.get(runId);
      if (projection === undefined) {
        throw runnerError("OPERATOR_RUN_NOT_FOUND", { runId });
      }
      return event({
        id: `event-${commandId}`,
        type: "operator.run",
        commandId,
        sessionId: projection.sessionId,
        threadId: projection.threadId,
        runId,
        payload: { view: projectionView(projection) },
      });
    }
    throw new Error(`Unsupported controlled runner command: ${type}.`);
  }

  acceptStart(commandId: string): void {
    const pending = this.pendingStarts.get(commandId);
    assert.ok(pending);
    const correlation = pending.payload.turn.missionControl!;
    this.seedProjection({
      ...correlation,
      sessionId: pending.payload.turn.sessionId,
      threadId: pending.payload.turn.sessionId,
      status: "RUNNING",
    });
    this.emit(event({
      id: `started-${commandId}`,
      type: "run.started",
      commandId,
      sessionId: pending.payload.turn.sessionId,
      threadId: pending.payload.turn.sessionId,
      runId: correlation.runId,
      payload: {
        sessionId: pending.payload.turn.sessionId,
        runId: correlation.runId,
        eventType: pending.payload.turn.eventType,
      },
    }));
  }

  setWaiting(
    runId: string,
    wait: NonNullable<ProjectionSeed["wait"]>,
  ): void {
    const projection = this.projections.get(runId);
    assert.ok(projection);
    projection.status = "WAITING";
    projection.wait = wait;
  }

  seedProjection(projection: ProjectionSeed): void {
    this.projections.set(projection.runId, { ...projection });
  }

  deleteProjection(runId: string): void {
    this.projections.delete(runId);
  }

  failCancel(runId: string, details: Record<string, unknown>): void {
    this.cancelFailures.set(runId, details);
  }

  setCancelled(runId: string): void {
    const projection = this.projections.get(runId);
    assert.ok(projection);
    projection.status = "FAILED";
    projection.terminalReasonCode = "RUN_CANCELLED";
    projection.errorMessage = "Operator cancelled the run.";
  }

  emitTerminal(
    commandId: string,
    runId: string,
    type: "run.completed" | "run.failed",
  ): void {
    const projection = this.projections.get(runId);
    assert.ok(projection);
    projection.status = type === "run.completed" ? "COMPLETED" : "FAILED";
    this.emit(
      type === "run.completed"
        ? event({
            id: `late-${commandId}`,
            type,
            commandId,
            sessionId: projection.sessionId,
            threadId: projection.threadId,
            runId,
            payload: {
              result: terminalResult(
                projection.sessionId,
                runId,
                "COMPLETED",
              ),
            },
          })
        : event({
            id: `late-${commandId}`,
            type,
            commandId,
            sessionId: projection.sessionId,
            threadId: projection.threadId,
            runId,
            payload: {
              result: terminalResult(
                projection.sessionId,
                runId,
                "FAILED",
              ),
              error: { code: "RUN_FAILED", message: "Run failed." },
            },
          }),
    );
  }

  commandCount(type: RunnerCommandType): number {
    return this.commands.filter((command) => command.type === type).length;
  }

  latestCommand(type: RunnerCommandType) {
    return this.commands.filter((command) => command.type === type).at(-1);
  }

  async waitForCommand(type: RunnerCommandType): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (this.commandCount(type) > 0) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${type}.`);
  }

  private emit(value: RunnerEvent): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

class FailingRunner implements MissionControlRunnerCommandClient {
  constructor(private readonly failure: Error) {}

  onEvent(): () => void {
    return () => {};
  }

  async sendCommandWithId<TType extends RunnerCommandType>(
    _commandId: string,
    _type: TType,
    _payload: RunnerCommandPayloadByType[TType],
    _metadata?: RunnerCommandMetadata,
  ): Promise<RunnerEvent> {
    throw this.failure;
  }
}

function projectionView(projection: ProjectionSeed) {
  return {
    run: {
      runId: projection.runId,
      sessionId: projection.sessionId,
      eventType: "mission_control.work_item",
      status: projection.status,
      startedAt: ACTION_TS,
      ...(projection.status === "COMPLETED" || projection.status === "FAILED"
        ? { completedAt: ACTION_TS }
        : {}),
      ...(projection.errorMessage === undefined
        ? {}
        : {
            error: {
              code: projection.terminalReasonCode ?? "RUN_FAILED",
              message: projection.errorMessage,
            },
          }),
    },
    threadId: projection.threadId,
    missionControl: {
      projectId: projection.projectId,
      itemId: projection.itemId,
      attemptId: projection.attemptId,
      commandId: projection.commandId,
      runId: projection.runId,
    },
    diagnosis: {
      status: projection.status,
      actionable:
        projection.status === "WAITING" || projection.status === "FAILED",
      ...(projection.terminalReasonCode === undefined
        ? {}
        : { terminalReasonCode: projection.terminalReasonCode }),
      ...(projection.wait === undefined
        ? {}
        : {
            wait: {
              ...projection.wait,
              actionable: true,
              threadId: projection.threadId,
              enteredAt: ACTION_TS,
            },
          }),
    },
  };
}

function event<TType extends RunnerEvent["type"]>(
  value: Omit<Extract<RunnerEvent, { type: TType }>, "ts">,
): Extract<RunnerEvent, { type: TType }> {
  return { ...value, ts: ACTION_TS } as Extract<
    RunnerEvent,
    { type: TType }
  >;
}

function terminalResult(
  sessionId: string,
  runId: string,
  status: "COMPLETED" | "FAILED" | "CANCELLED",
) {
  return {
    assistantText: null,
    output: {
      status,
      sessionId,
      runId,
      errors: [],
      quality: {
        citationCoverage: 1,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      telemetry: {
        stepsExecuted: 0,
        toolCalls: 0,
        modelCalls: 0,
        durationMs: 0,
      },
    },
  };
}

function completedResult(sessionId: string, runId: string) {
  return {
    assistantText: null,
    output: {
      status: "COMPLETED" as const,
      sessionId,
      runId,
      errors: [],
      quality: {
        citationCoverage: 1,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      telemetry: {
        stepsExecuted: 0,
        toolCalls: 0,
        modelCalls: 0,
        durationMs: 0,
      },
    },
  };
}

function runnerError(code: string, details: Record<string, unknown>) {
  return Object.assign(new Error(code), { code, details });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for runner event.");
}
