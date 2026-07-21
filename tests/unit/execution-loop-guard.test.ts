import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { readActiveWaitState } from "../../src/runtime/waitState.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


interface ReactActionFlowRow {
  step: string;
  workItemPhase?: string | undefined;
  actionName?: string | undefined;
  actionInputHash?: string | undefined;
  evidenceLedgerCount?: number | undefined;
}

function buildReactActionFlowTable(events: Array<Record<string, unknown>>): ReactActionFlowRow[] {
  const rows: ReactActionFlowRow[] = [];
  for (const event of events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      const entry = payload?.entry as Record<string, unknown> | undefined;
      const metadata = entry?.metadata as Record<string, unknown> | undefined;
      if (event.type !== "run.log" || entry?.eventName !== "state_transition" || metadata === undefined) {
        continue;
      }
      const next = metadata.next as Record<string, unknown> | undefined;
      const nextAction = next?.nextAction as Record<string, unknown> | undefined;
      rows.push({
        step: String(metadata.step ?? ""),
        ...(typeof nextAction?.name === "string" ? { actionName: nextAction.name } : {}),
        ...(typeof nextAction?.inputHash === "string" ? { actionInputHash: nextAction.inputHash } : {}),
        ...(typeof next?.evidenceLedgerCount === "number" ? { evidenceLedgerCount: next.evidenceLedgerCount } : {}),
      });
  }
  return rows;
}

contractTest("runtime.hermetic", "react action flow table exposes gather evidence stdin/read loops", () => {
  const rows = buildReactActionFlowTable([
    {
      type: "run.log",
      payload: {
        entry: {
          eventName: "state_transition",
          metadata: {
            step: "agent.loop",
            next: {
              nextAction: { name: "dev.process.write", inputHash: "{\"input\":\"move N\\n\"}" },
              evidenceLedgerCount: 5,
            },
          },
        },
      },
    },
    {
      type: "run.log",
      payload: {
        entry: {
          eventName: "state_transition",
          metadata: {
            step: "agent.loop",
            next: {
              nextAction: { name: "dev.process.read", inputHash: "{\"processId\":\"proc-1\"}" },
              evidenceLedgerCount: 7,
            },
          },
        },
      },
    },
  ]);

  assert.deepEqual(rows.map((row) => row.actionName), [
    "dev.process.write",
    "dev.process.read",
  ]);
});

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("Timed out waiting for condition.");
}

function createLoopStallResumeRuntime(
  store: InMemorySessionStore,
  intent: Record<string, unknown>,
): Kestrel {
  return new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      const metadata = request.metadata as Record<string, unknown> | undefined;
      if (metadata?.modelRole === "user_reply_intent") {
        return {
          output: intent,
        } as T;
      }
      return { ok: true } as T;
    }),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });
}

async function seedLoopVisitStallSession(
  store: InMemorySessionStore,
  sessionId: string,
  resumeStepAgent: string,
): Promise<void> {
  const blockedAction = {
    kind: "tool",
    name: "fs.list",
    input: {
      path: "app",
    },
  };
  const target = {
    kind: "path",
    label: "app",
    path: "app",
  };
  const diagnostic = {
    guardType: "NO_PROGRESS_REASONING_LOOP",
    stepAgent: resumeStepAgent,
    actionSignature: "tool:fs.list app",
  };
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      reason: "loop_visit_stall",
      resolution: "checkpoint_wait",
      question: "Reply continue to resume.",
      prompt: "Reply continue to resume.",
      resumeReply: "continue",
      target,
      diagnostic,
    },
  };
  await store.ensureSession(sessionId, resumeStepAgent);
  await store.commitStep({
    runId: `seed-${sessionId}`,
    event: {
      id: `seed-${sessionId}`,
      type: "system.meta_reasoning",
      sessionId,
      payload: {
        reason: "loop_visit_stall",
      },
    },
    sessionId,
    expectedVersion: 0,
    nextStepAgent: resumeStepAgent,
    statePatch: {
      agent: {
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "loop_visit_stall",
          resumeInstruction: "Reply continue to resume.",
          resumeStepAgent,
          resumeToken: `loop-visit-stall:${sessionId}`,
          metadata: waitFor.metadata,
          blockedAction,
        },
        wait: {
          ...waitFor,
          resumeStepAgent,
          resumeToken: `loop-visit-stall:${sessionId}`,
        },
        terminal: {
          status: "WAITING",
          reasonCode: "loop_visit_stall",
          finalStepAgent: resumeStepAgent,
          finalizedAt: new Date().toISOString(),
        },
        loopStall: {
          reason: "loop_visit_stall",
          resolution: "checkpoint_wait",
          target,
          diagnostic,
          blockedAction,
          resumeInstruction: "Reply continue to resume.",
          checkpointedAt: new Date().toISOString(),
        },
        nextAction: blockedAction,
        loopGuard: {
          history: [
            {
              step: resumeStepAgent,
              waitToken: "loop-visit-stall-token",
              pendingExecutionHash: "stale-pending-execution",
            },
          ],
        },
        exec: {
          waitingForUser: waitFor,
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });
}

contractTest("runtime.hermetic", "ExecutionEngine persists step-start telemetry while a buffered step is still running", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 40,
      maxStepVisits: 40,
    },
  });

  let releaseStep!: () => void;
  const blockedStep = new Promise<void>((resolve) => {
    releaseStep = resolve;
  });

  kestrel.registerStep("react.blocked", async () => {
    await blockedStep;
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const runPromise = kestrel.run({
    id: "evt-step-start-persisted",
    type: "user.message",
    sessionId: "session-step-start-persisted",
    payload: {},
    stepAgent: "react.blocked",
  });

  await waitFor(() =>
    store.getRunEvents().some((event) => event.type === "step.selected" && event.stepIndex === 0),
  );

  const inFlightRunEvents = store.getRunEvents();
  const startedEvent = inFlightRunEvents.find(
    (event) =>
      event.type === "step.started" &&
      event.stepIndex === 0 &&
      event.metadata?.step === "react.blocked",
  );
  assert.ok(startedEvent, "expected step.started to persist before the step resolves");

  const startedProgress = inFlightRunEvents.find(
    (event) =>
      event.type === "progress.stage" &&
      event.stepIndex === 0 &&
      event.metadata?.code === "STEP_STARTED",
  );
  assert.ok(startedProgress, "expected STEP_STARTED progress to persist before the step resolves");

  releaseStep();
  const output = await runPromise;
  assert.equal(output.status, "COMPLETED");
});

contractTest("runtime.hermetic", "ExecutionEngine logs compact React state handoff for every committed step", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        phase: "THINK",
        workItem: {
          version: "v1",
          phase: "gather_evidence",
          objective: "Collect source truth before deriving the artifact.",
          sourceTruthGoal: { target: "actual topology observations", requirements: [{ id: "source_truth_1", expectation: "actual topology observations", evidenceNeeded: "actual topology observations", sufficiencyChecks: [{ id: "source_truth_1_supported", criterion: "The cited evidence directly contains the named source facts for this requirement.", requiredFacts: ["The concrete source facts named by this requirement."], derivationUse: "Use these source facts to derive the requested artifact or final answer." , completionEvidence: "Current cited evidence proves this check is complete and no named required fact remains unresolved."}] }], completionCriteria: "The source-truth requirement has current supporting evidence." },
        },
        nextAction: undefined,
        evidenceLedger: [
          {
            id: "ev-1",
            version: "v1",
            createdAt: "2026-05-03T00:00:00.000Z",
            source: "agent.loop",
            kind: "policy_correction",
            status: "inconclusive",
            summary: "Missing source truth.",
            facts: {},
            nextUse: {
              requiresAction: "collect_source_truth",
            },
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-state-transition-log",
    type: "user.message",
    sessionId: "session-state-transition-log",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  const transitionLog = store.getRunLogs().find((entry) =>
    entry.eventName === "state_transition" &&
    entry.stepIndex === 0
  );
  assert.ok(transitionLog, "expected a state_transition run log");

  const metadata = transitionLog.metadata ?? {};
  assert.equal(metadata.step, "agent.loop");
  assert.deepEqual(metadata.changed, {
    phase: true,
    feedbackEvidence: false,
    nextAction: false,
    evidenceLedger: true,
  });

  const next = metadata.next as Record<string, unknown>;
  assert.deepEqual(next.latestEvidence, {
    id: "ev-1",
    kind: "policy_correction",
    status: "inconclusive",
    summary: "Missing source truth.",
    targetType: "",
    targetValue: "",
    requiresAction: "collect_source_truth",
    blocks: "",
  });

  const patch = metadata.patch as Record<string, unknown>;
  const reactKeys = patch.reactKeys as string[];
  for (const key of ["evidenceLedger", "nextAction", "phase", "workItem"]) {
    assert.equal(reactKeys.includes(key), true, `expected react patch keys to include ${key}`);
  }
});

contractTest("runtime.hermetic", "ExecutionEngine trips LOOP_GUARD_TRIGGERED before max-steps on repeated identical react state", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 40,
      maxStepVisits: 40,
    },
  });

  kestrel.registerStep("react.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "react.loop",
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "free.time.current",
          input: {
            timezone: "Etc/UTC",
          },
        },
        requiredCapabilities: ["time.current"],
        capabilityEvidence: {},
        observations: [
          {
            summary: "No new evidence yet.",
            goalMet: false,
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-guard",
    type: "user.message",
    sessionId: "session-loop-guard",
    payload: {},
    stepAgent: "react.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.telemetry.stepsExecuted < 20, true);
});

contractTest("runtime.hermetic", "ExecutionEngine keeps repeated validation feedback loop details mechanical", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 40,
      maxStepVisits: 40,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        nextAction: undefined,
        lastActionResult: {
          kind: "validation_feedback",
          status: "failed",
          errorCode: "DECISION_POLICY_FAILED",
          message: "Plan-mode handoff must wait for user confirmation before execution.",
          details: {
            path: "nextAction.finalizeReason",
            toolName: "FinalizeAnswer",
            requiredToolClass: "sandboxed_only",
          },
        },
        observations: [
          {
            kind: "validation_feedback",
            status: "failed",
            summary: "Plan-mode handoff must wait for user confirmation before execution.",
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-guard-rejection-details",
    type: "user.message",
    sessionId: "session-loop-guard-rejection-details",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "NO_PROGRESS_REASONING_LOOP");
  assert.equal(output.errors[0]?.details?.threshold, 3);
  assert.equal(output.errors[0]?.details?.loopClassification, undefined);
  assert.equal(output.errors[0]?.details?.lastRejection, undefined);
  assert.equal(output.errors[0]?.details?.recommendedOperatorAction, undefined);
  assert.equal(output.errors[0]?.details?.step, "agent.loop");
  assert.equal(typeof output.errors[0]?.details?.actionSignatureHash, "string");
  assert.equal(typeof output.errors[0]?.details?.latestEvidenceHash, "string");
});

contractTest("runtime.hermetic", "ExecutionEngine completes visible-todo finalize loops with documented residual gap", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      evidenceLedger: [
        {
          id: "ev-build",
          status: "passed",
          summary: "Build and lint passed.",
        },
      ],
      agent: {
        interactionMode: "build",
        visibleTodos: {
          objective: "Build the app.",
          items: [
            {
              id: "build",
              text: "Run build",
              status: "done",
            },
            {
              id: "browser-e2e",
              text: "Exercise browser E2E",
              status: "blocked",
              note: "Browser E2E was not directly exercised.",
            },
          ],
        },
        lastAction: {
          kind: "finalize",
          finalizeReason: "goal_satisfied",
          input: {
            message: "Done. Browser E2E was not directly exercised.",
            data: {
              openGap: "Browser E2E was not directly exercised.",
              residualTodoIds: ["browser-e2e"],
            },
          },
        },
        lastActionResult: {
          kind: "tool",
          status: "ok",
          toolName: "dev.shell.run",
        },
        retryContext: {
          failure: {
            code: "DECISION_POLICY_FAILED",
            details: {
              reason: "visible_todo_finalize_continuation",
              openVisibleTodoItemId: "browser-e2e",
              openVisibleTodoItemStatus: "blocked",
            },
          },
        },
        observations: [
          {
            summary: "Build and lint passed.",
            goalMet: true,
          },
        ],
        decisionTrace: [
          {
            eventType: "decision.redirected",
            phase: "agent.loop",
            decisionCode: "visible_todo_finalize_continuation",
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-visible-todo-residual-gap-loop",
    type: "user.message",
    sessionId: "session-visible-todo-residual-gap-loop",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-visible-todo-residual-gap-loop");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = react.terminal as Record<string, unknown>;
  const finalOutput = react.finalOutput as Record<string, unknown>;
  const finalData = finalOutput.data as Record<string, unknown>;
  const visibleTodos = react.visibleTodos as Record<string, unknown>;
  const items = visibleTodos.items as Record<string, unknown>[];

  assert.equal(terminal.reasonCode, "goal_satisfied");
  assert.equal(finalData.documentedResidualGapFinalized, true);
  assert.deepEqual(finalData.residualTodoIds, ["browser-e2e"]);
  assert.equal(items[1]?.status, "blocked");
});

contractTest("runtime.hermetic", "ExecutionEngine does not complete residual-gap finalize loops on partial post-tool verification", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        visibleTodos: {
          objective: "Build the app.",
          items: [
            {
              id: "build",
              text: "Run build",
              status: "done",
            },
            {
              id: "browser-e2e",
              text: "Exercise browser E2E",
              status: "blocked",
              note: "Browser E2E was not directly exercised.",
            },
          ],
        },
        lastAction: {
          kind: "finalize",
          finalizeReason: "goal_satisfied",
          input: {
            message: "Done. Browser E2E was not directly exercised.",
            data: {
              openGap: "Browser E2E was not directly exercised.",
              residualTodoIds: ["browser-e2e"],
            },
          },
        },
        postToolVerification: {
          resultQuality: "partial",
          newFactsCount: 0,
          newCapabilities: [],
        },
        retryContext: {
          failure: {
            code: "DECISION_POLICY_FAILED",
            details: {
              reason: "visible_todo_finalize_continuation",
              openVisibleTodoItemId: "browser-e2e",
              openVisibleTodoItemStatus: "blocked",
            },
          },
        },
        decisionTrace: [
          {
            eventType: "decision.redirected",
            phase: "agent.loop",
            decisionCode: "visible_todo_finalize_continuation",
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-visible-todo-residual-gap-partial-verification-loop",
    type: "user.message",
    sessionId: "session-visible-todo-residual-gap-partial-verification-loop",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.notEqual(output.status, "COMPLETED");

  const session = await store.getSession("session-visible-todo-residual-gap-partial-verification-loop");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const finalOutput = react.finalOutput as Record<string, unknown> | undefined;
  const finalData = finalOutput?.data as Record<string, unknown> | undefined;

  assert.notEqual(finalData?.documentedResidualGapFinalized, true);
});

contractTest("runtime.hermetic", "ExecutionEngine pauses and asks for operator guidance on missing filesystem path loops", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 100,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "./ghost-file.txt",
          },
        },
        lastActionResult: {
          kind: "tool",
          status: "failed",
          errorCode: "TOOL_INPUT_INVALID",
          message: "Path does not exist: ./ghost-file.txt",
          details: {
            path: "./ghost-file.txt",
            toolName: "fs.read_text",
          },
        },
        observations: [
          {
            summary: "Checking file contents.",
            goalMet: false,
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-guard-missing-path",
    type: "user.message",
    sessionId: "session-loop-guard-missing-path",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.waitFor?.eventType, "user.reply");
  assert.equal((output.waitFor?.metadata as Record<string, unknown>)?.reason, "tool_input_invalid");

  const session = await store.getSession("session-loop-guard-missing-path");
  const terminal = (session?.state?.agent as Record<string, unknown> | undefined) as Record<string, unknown>;
  const runState = (terminal?.terminal ?? {}) as Record<string, unknown>;
  assert.equal(runState.status, "WAITING");
  assert.equal(runState.reasonCode, "tool_input_invalid");
  assert.equal((terminal.waitingFor as Record<string, unknown> | undefined)?.reason, "tool_input_invalid");
  assert.equal(readActiveWaitState(terminal)?.source, "waitingFor");
});

contractTest("runtime.hermetic", "ExecutionEngine resumes loop visit stalls on high-confidence continue while clearing canonical wait state before the resumed step", async () => {
  const store = new InMemorySessionStore();
  await seedLoopVisitStallSession(store, "loop-stall-resume-session", "loop.resume");
  let observedReact: Record<string, unknown> | undefined;
  const kestrel = createLoopStallResumeRuntime(store, {
    kind: "continue",
    proceed: true,
    confidence: "high",
  });
  kestrel.registerStep("loop.resume", async (ctx) => {
    observedReact = (ctx.session.state.agent ?? {}) as Record<string, unknown>;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          ...observedReact,
          finalOutput: {
            message: "resumed",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-loop-stall-resume",
    type: "user.reply",
    sessionId: "loop-stall-resume-session",
    payload: {
      message: "continue",
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(
    ((observedReact?.waitingFor as Record<string, unknown> | undefined)?.reason),
    undefined,
  );
  assert.equal(((observedReact?.terminal ?? {}) as Record<string, unknown>).status, undefined);
  assert.deepEqual(((observedReact?.loopGuard ?? {}) as Record<string, unknown>).history, []);
  const loopStall = observedReact?.loopStall as Record<string, unknown> | undefined;
  assert.equal(loopStall?.status, "resumed");
  assert.deepEqual(loopStall?.blockedAction, {
    kind: "tool",
    name: "fs.list",
    input: {
      path: "app",
    },
  });
  assert.equal(loopStall?.resumeInstruction, "Reply continue to resume.");
  assert.equal((loopStall?.diagnostic as Record<string, unknown> | undefined)?.actionSignature, "tool:fs.list app");
  assert.equal((loopStall?.target as Record<string, unknown> | undefined)?.label, "app");
  assert.equal(readActiveWaitState(observedReact), undefined);
});

contractTest("runtime.hermetic", "ExecutionEngine replans exec loop stalls instead of replaying stale dispatch actions", async () => {
  const store = new InMemorySessionStore();
  await seedLoopVisitStallSession(store, "loop-stall-dispatch-resume-session", "agent.exec.dispatch");
  let observedReact: Record<string, unknown> | undefined;
  const kestrel = createLoopStallResumeRuntime(store, {
    kind: "continue",
    proceed: true,
    confidence: "high",
  });
  kestrel.registerStep("agent.loop", async (ctx) => {
    observedReact = (ctx.session.state.agent ?? {}) as Record<string, unknown>;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          ...observedReact,
          finalOutput: {
            message: "replanned",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-loop-stall-dispatch-resume",
    type: "user.reply",
    sessionId: "loop-stall-dispatch-resume-session",
    payload: {
      message: "continue",
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.finalStep, "agent.loop");
  assert.equal(observedReact?.nextAction, undefined);
  assert.equal(((observedReact?.exec ?? {}) as Record<string, unknown>).pendingToolCall, undefined);
  const loopStall = observedReact?.loopStall as Record<string, unknown> | undefined;
  assert.equal((loopStall ?? {}).storedResumeStepAgent, "agent.exec.dispatch");
  assert.equal(loopStall?.status, "resumed");
  assert.deepEqual(loopStall?.blockedAction, {
    kind: "tool",
    name: "fs.list",
    input: {
      path: "app",
    },
  });
});

contractTest("runtime.hermetic", "ExecutionEngine does not auto-resume loop visit stalls on ambiguous replies", async () => {
  const store = new InMemorySessionStore();
  await seedLoopVisitStallSession(store, "loop-stall-ambiguous-session", "loop.resume");
  let resumeStepCalled = false;
  const kestrel = createLoopStallResumeRuntime(store, {
    kind: "unrelated",
    proceed: false,
    confidence: "low",
  });
  kestrel.registerStep("loop.resume", async () => {
    resumeStepCalled = true;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          finalOutput: {
            message: "handled ambiguous reply",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-loop-stall-ambiguous",
    type: "user.reply",
    sessionId: "loop-stall-ambiguous-session",
    payload: {
      message: "what do you mean?",
    },
  });

  assert.equal(output.status, "WAITING");
  assert.equal(resumeStepCalled, false);
  const session = await store.getSession("loop-stall-ambiguous-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.notDeepEqual(((react.loopGuard ?? {}) as Record<string, unknown>).history, []);
  assert.notEqual((react.loopStall as Record<string, unknown> | undefined)?.status, "resumed");
  assert.equal(readActiveWaitState(react)?.source, "waitingFor");
});

contractTest("runtime.hermetic", "ExecutionEngine requires explicit loop-stall continuation wording", async () => {
  const store = new InMemorySessionStore();
  await seedLoopVisitStallSession(store, "loop-stall-non-continuation-session", "loop.resume");
  let resumeStepCalled = false;
  const kestrel = createLoopStallResumeRuntime(store, {
    kind: "continue",
    proceed: true,
    confidence: "high",
  });
  kestrel.registerStep("loop.resume", async () => {
    resumeStepCalled = true;
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          finalOutput: {
            message: "resumed",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-loop-stall-non-continuation",
    type: "user.reply",
    sessionId: "loop-stall-non-continuation-session",
    payload: {
      message: "stop copy edits and inspect the rendered app",
    },
  });

  assert.equal(output.status, "WAITING");
  assert.equal(resumeStepCalled, false);
  const session = await store.getSession("loop-stall-non-continuation-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.notEqual((react.loopStall as Record<string, unknown> | undefined)?.status, "resumed");
  assert.equal(readActiveWaitState(react)?.source, "waitingFor");
});

contractTest("runtime.hermetic", "ExecutionEngine loop-guards repeated validation loops when a concrete target exists", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 100,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "./ghost-file.txt",
          },
        },
        lastActionResult: {
          kind: "tool",
          status: "failed",
          errorCode: "TOOL_INPUT_INVALID",
          message: "Could not load source",
          details: {
            reason: "tool error",
            toolName: "fs.read_text",
          },
        },
        observations: [
          {
            summary: "Checking file contents.",
            goalMet: false,
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-guard-missing-path-no-path",
    type: "user.message",
    sessionId: "session-loop-guard-missing-path-no-path",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
});

contractTest("runtime.hermetic", "ExecutionEngine checkpoints repeated no-progress dispatch control states", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 50,
      maxStepVisits: 50,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const react = (ctx.session.state.agent ?? {}) as Record<string, unknown>;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        agent: {
          ...react,
          goal: "Work from the session note until finished",
          requiredCapabilities: ["filesystem.read"],
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "docs/runbook.md",
            },
          },
          observations: [
            {
              summary: "Inspected workspace prompt files.",
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = (ctx.session.state.agent ?? {}) as Record<string, unknown>;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...react,
          lastActionResult: {
            kind: "tool",
            status: "ok",
            name: "fs.read_text",
            toolName: "fs.read_text",
            inputHash: "same-plan-prompt-read",
            input: {
              path: "docs/runbook.md",
            },
            outputSummary: "Read the run prompt.",
          },
          observations: [
            {
              summary: "Inspected workspace prompt files.",
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-identical-dispatch-loop",
    type: "user.message",
    sessionId: "session-identical-dispatch-loop",
    payload: {
      message: "Work from the session note until finished",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.length, 0);
  assert.equal((output.waitFor?.metadata as Record<string, unknown>)?.reason, "loop_visit_stall");
  assert.equal((output.waitFor?.metadata as Record<string, unknown>)?.resolution, "checkpoint_wait");
  const diagnostic = (output.waitFor?.metadata as Record<string, unknown>)?.diagnostic as
    | Record<string, unknown>
    | undefined;
  assert.equal(diagnostic?.guardType, "NO_PROGRESS_REASONING_LOOP");
  assert.equal(diagnostic?.stepAgent, "agent.exec.dispatch");
  assert.equal(diagnostic?.toolName, "fs.read_text");

  const session = await store.getSession("session-identical-dispatch-loop");
  const agent = session?.state.agent as Record<string, unknown> | undefined;
  const loopStall = agent?.loopStall as Record<string, unknown> | undefined;
  assert.equal(loopStall?.reason, "loop_visit_stall");
  assert.equal(readActiveWaitState(agent)?.resumeStepAgent, "agent.loop");
  assert.equal((loopStall?.diagnostic as Record<string, unknown> | undefined)?.guardType, "NO_PROGRESS_REASONING_LOOP");
  assert.equal(loopStall?.resumeInstruction, (output.waitFor?.metadata as Record<string, unknown>)?.question);
  assert.equal((loopStall?.blockedAction as Record<string, unknown> | undefined)?.name, "fs.read_text");
  assert.deepEqual(
    ((readActiveWaitState(agent)?.blockedAction as Record<string, unknown> | undefined)?.input),
    {
      path: "docs/runbook.md",
    },
  );
  assert.ok(
    store.getRunEvents().some((event) =>
      event.runId === output.runId &&
      event.type === "loop.guard_triggered" &&
      (event.metadata as Record<string, unknown> | undefined)?.details !== undefined
    ),
  );
});

contractTest("runtime.hermetic", "ExecutionEngine does not treat pending tool batch advancement as no-progress dispatch looping", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  let nextIndex = 0;
  kestrel.registerStep("agent.exec.dispatch", async () => {
    nextIndex += 1;
    if (nextIndex > 4) {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: {
            phase: "OBSERVE",
          },
        },
      };
    }

    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        agent: {
          phase: "ACT",
          nextAction: {
            kind: "tool_batch",
            items: [
              { name: "fs.list", input: { path: "/app" } },
              { name: "fs.read_text", input: { path: "/app/maze_solver.py" } },
              { name: "fs.read_text", input: { path: "/app/maze_map.txt" } },
              { name: "dev.shell.run", input: { command: "test -s /app/maze_map.txt" } },
            ],
          },
          capabilityEvidence: {},
          exec: {
            pendingBatch: {
              items: [
                { name: "fs.list", input: { path: "/app" } },
                { name: "fs.read_text", input: { path: "/app/maze_solver.py" } },
                { name: "fs.read_text", input: { path: "/app/maze_map.txt" } },
                { name: "dev.shell.run", input: { command: "test -s /app/maze_map.txt" } },
              ],
              nextIndex,
              completedItems: [],
            },
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-pending-tool-batch-progress",
    type: "user.message",
    sessionId: "session-pending-tool-batch-progress",
    payload: {},
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(nextIndex, 5);
});

contractTest("runtime.hermetic", "ExecutionEngine treats deliberator policy retries as distinct reasoning progress", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  let deliberatorVisits = 0;
  kestrel.registerStep("agent.loop", async () => {
    deliberatorVisits += 1;
    if (deliberatorVisits < 3) {
      return {
        status: "RUNNING",
        nextStepAgent: "agent.loop",
        statePatch: {
          agent: {
            nextAction: undefined,
            requiredCapabilities: [],
            capabilityEvidence: {},
            observations: [
              {
                summary: "No new executable action yet.",
                goalMet: false,
              },
            ],
          },
        },
      };
    }

    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          nextAction: undefined,
          requiredCapabilities: [],
          capabilityEvidence: {},
          observations: [
            {
              summary: "No new executable action yet.",
              goalMet: false,
            },
          ],
          phase: "PLAN",
          decisionTrace: [
            {
              eventType: "decision.redirected",
              phase: "deliberator",
              decisionCode: "work_item_action_mismatch_retry",
              metadata: {
                reason: "work_item_action_mismatch",
                toolName: "fs.read_text",
                workItemPhase: "verify_artifact",
                allowedToolNames: ["fs.write_text"],
              },
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-thinker-policy-redirect-progress",
    type: "user.message",
    sessionId: "session-thinker-policy-redirect-progress",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(deliberatorVisits, 3);
});

contractTest("runtime.hermetic", "ExecutionEngine treats deliberator work item updates as no-action reasoning progress", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  let deliberatorWorkItemVisits = 0;
  kestrel.registerStep("agent.loop", async () => {
    deliberatorWorkItemVisits += 1;
    if (deliberatorWorkItemVisits < 3) {
      return {
        status: "RUNNING",
        nextStepAgent: "agent.loop",
        statePatch: {
          agent: {
            nextAction: undefined,
            capabilityEvidence: {},
            observations: [
              {
                summary: "Deliberator is preserving strategy.",
                goalMet: false,
              },
            ],
          },
        },
      };
    }

    return {
      status: "RUNNING",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          nextAction: undefined,
          capabilityEvidence: {},
          observations: [
            {
              summary: "Deliberator is preserving strategy.",
              goalMet: false,
            },
          ],
              evidenceLedger: [
                {
                  id: `ev-work-item-progress-${deliberatorWorkItemVisits}`,
                  version: "v1",
                  createdAt: "2026-05-03T00:00:00.000Z",
                  source: "deliberator",
                  kind: "artifact_verification",
                  status: "failed",
                  summary: `Artifact verification is still incomplete after visit ${deliberatorWorkItemVisits}.`,
                  target: {
                    type: "path",
                    value: "/app/output.txt",
                    normalizedValue: "/app/output.txt",
                  },
                  facts: {
                    verificationStatus: "failed",
                  },
                },
              ],
        },
      },
    };
  });

  kestrel.registerStep("react.done", async () => ({
    status: "COMPLETED",
    statePatch: {},
  }));

  const output = await kestrel.run({
    id: "evt-planner-work-item-progress",
    type: "user.message",
    sessionId: "session-planner-work-item-progress",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(deliberatorWorkItemVisits, 3);
});

contractTest("runtime.hermetic", "ExecutionEngine allows repeated identical react.route states until max-steps continuation", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 2,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        executionLane: "tooling",
        selectedLane: "tooling",
        routeDecision: {
          executionLane: "tooling",
          selectedLane: "tooling",
          needsTools: true,
          requiredToolClasses: ["read_only"],
          reasonCode: "read_only_tooling",
          confidence: 0.98,
          blockedByMode: false,
        },
        observations: [
          {
            summary: "Routed to tooling.",
            goalMet: false,
          },
        ],
        capabilityEvidence: {},
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-route-loop-guard",
    type: "user.message",
    sessionId: "session-route-loop-guard",
    payload: {
      message: "need tools",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.length, 0);
  assert.equal(output.waitFor?.eventType, "user.reply");
  assert.equal((output.waitFor?.metadata as Record<string, unknown>)?.reason, "max_steps_continuation");
});

contractTest("runtime.hermetic", "ExecutionEngine records normalized tool input in run events", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      validateInput: async (_name, input) => ({
        ...(input as Record<string, unknown>),
        domainAllow: ["local12.com", "fox19.com"],
      }),
      call: async () => ({ ok: true }) as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("internet.search", {
      query: "crosby deal",
      domainAllow: "local12.com, fox19.com",
    });
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-tool-input-events",
    type: "user.message",
    sessionId: "session-tool-input-events",
    payload: {},
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  const validated = runEvents.find((event) => event.type === "tool.validated");
  assert.deepEqual(validated?.metadata?.toolInput, {
    domainAllow: ["local12.com", "fox19.com"],
    query: "crosby deal",
  });
  assert.equal(typeof validated?.metadata?.toolInputHash, "string");
  const enqueued = runEvents.find((event) => event.type === "tool.queue.enqueued");
  assert.deepEqual(enqueued?.metadata?.toolInput, {
    domainAllow: ["local12.com", "fox19.com"],
    query: "crosby deal",
  });
});

contractTest("runtime.hermetic", "ExecutionEngine records decision model request telemetry with requested model metadata", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() =>
      ({
        output: { ok: true },
        toolIntents: [],
        provider: {
          name: "openrouter",
          model: "openai/gpt-4.1",
          endpoint: "chat",
        },
      }) as T,
    ),
  });

  kestrel.registerStep("agent.loop", async (_ctx, io) => {
      await io.useModel({
        model: "openai/gpt-4.1",
        input: {
          goal: "decide",
          transcript: {
            version: "transcript-v1",
            items: [
              {
                kind: "tool_result",
                toolName: "dev.process.read",
                visibleOutput: "No new output from process proc-live; status RUNNING.",
              },
            ],
          },
        },
      responseFormat: "json",
      providerOptions: {
        openrouter: {
          endpoint: "chat",
          responseSchemaName: "kestrel_agent_action",
        },
      },
      metadata: {
        phase: "deliberator",
        stepAgent: "deliberator",
        requestedModel: "openai/gpt-4.1",
        modelRole: "decision",
      },
    });
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-model-request-telemetry",
    type: "user.message",
    sessionId: "session-model-request-telemetry",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  const requested = runEvents.find((event) => event.type === "model.requested");
  assert.equal(requested?.metadata?.stepAgent, "deliberator");
  assert.equal(requested?.metadata?.phase, "deliberator");
  assert.equal(requested?.metadata?.requestedModel, "openai/gpt-4.1");
  assert.equal(requested?.metadata?.provider, "openrouter");
  assert.equal(requested?.metadata?.modelRole, "decision");
  const promptSummary = requested?.metadata?.promptSummary as Record<string, unknown> | undefined;
  const snapshot = promptSummary?.modelInputSnapshot as Record<string, unknown> | undefined;
  assert.deepEqual(snapshot?.inputKeys, ["goal", "transcript"]);
  const payloadSections = snapshot?.payloadSections as Record<string, Record<string, unknown>> | undefined;
  assert.equal(payloadSections?.goal?.type, "string");
  assert.equal(payloadSections?.transcript?.type, "object");
  assert.equal(typeof payloadSections?.transcript?.serializedLength, "number");
  const completed = runEvents.find((event) => event.type === "model.completed");
  assert.equal(completed?.metadata?.requestedModel, "openai/gpt-4.1");
  assert.equal(completed?.metadata?.provider, "openrouter");
  assert.equal(completed?.metadata?.modelRole, "decision");
  const requestedLog = store.getRunLogs().find((entry) =>
    entry.runId === output.runId && entry.eventName === "model_requested"
  );
  assert.equal(requestedLog?.metadata?.stepAgent, "deliberator");
  const logPromptSummary = requestedLog?.metadata?.promptSummary as Record<string, unknown> | undefined;
  const logSnapshot = logPromptSummary?.modelInputSnapshot as Record<string, unknown> | undefined;
  assert.deepEqual(logSnapshot?.inputKeys, ["goal", "transcript"]);
});

contractTest("runtime.hermetic", "ExecutionEngine writes full model prompt dumps to disk when enabled", async () => {
  const previousHome = process.env.KESTREL_HOME;
  const previousDump = process.env.KESTREL_MODEL_PROMPT_DUMP;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-model-prompt-dump-"));
  process.env.KESTREL_HOME = tempDir;
  process.env.KESTREL_MODEL_PROMPT_DUMP = "1";
  try {
    const store = new InMemorySessionStore();
    const kestrel = new Kestrel({
      store,
      toolGateway: {
        call: async () => null as never,
      },
      modelGateway: new RetryingModelGateway(async <T>() =>
        ({
          output: { ok: true },
          toolIntents: [],
          reasoning: {
            visible: [{ format: "summary", text: "provider-visible-secret" }],
            continuation: [{ provider: "openai", kind: "encrypted_content", value: "provider-opaque-secret" }],
          },
          provider: {
            name: "openrouter",
            model: "openai/gpt-4.1",
            endpoint: "chat",
          },
        }) as T,
      ),
    });

    kestrel.registerStep("agent.loop", async (_ctx, io) => {
      await io.useModel({
        model: "openai/gpt-4.1",
        input: {
          goal: "decide",
          transcript: {
            version: "transcript-v1",
            items: [
              {
                kind: "tool_result",
                toolName: "internet.search",
                visibleOutput: "Retained sources: [{\"url\":\"https://example.com/story\"}]",
              },
            ],
          },
        },
        responseFormat: "json",
        reasoning: {
          mode: "summary",
          continuation: [{ provider: "openai", kind: "encrypted_content", value: "request-opaque-secret" }],
        },
        providerOptions: {
          openrouter: {
            endpoint: "chat",
            responseSchemaName: "kestrel_agent_action",
          },
        },
        metadata: {
          phase: "deliberator",
          stepAgent: "deliberator",
          requestedModel: "openai/gpt-4.1",
          modelRole: "decision",
        },
      });
      return {
        status: "COMPLETED",
        statePatch: {},
      };
    });

    const output = await kestrel.run({
      id: "evt-model-request-prompt-dump",
      type: "user.message",
      sessionId: "session-model-request-prompt-dump",
      payload: {},
      stepAgent: "agent.loop",
    });

    assert.equal(output.status, "COMPLETED");
    const requested = store.getRunEvents().find((event) =>
      event.runId === output.runId && event.type === "model.requested"
    );
    const promptDump = requested?.metadata?.promptDump as Record<string, unknown> | undefined;
    assert.equal(typeof promptDump?.jsonPath, "string");
    assert.equal(promptDump?.currentTurnSummaryPath, undefined);
    const dumpJson = JSON.parse(await readFile(String(promptDump?.jsonPath), "utf8")) as Record<string, unknown>;
    assert.equal(dumpJson.sessionId, "session-model-request-prompt-dump");
    assert.equal(dumpJson.runId, output.runId);
    assert.equal((dumpJson.request as Record<string, unknown>)?.model, "openai/gpt-4.1");
    const requestInput = ((dumpJson.request as Record<string, unknown>)?.input as Record<string, unknown>);
    const transcript = requestInput?.transcript as Record<string, unknown> | undefined;
    assert.equal(transcript?.version, "transcript-v1");
    const modelResult = dumpJson.modelResult as Record<string, unknown> | undefined;
    const response = modelResult?.response as Record<string, unknown> | undefined;
    const outputResponse = response?.output as Record<string, unknown> | undefined;
    assert.equal(modelResult?.status, "COMPLETED");
    assert.equal(outputResponse?.ok, true);
    const serializedDump = JSON.stringify(dumpJson);
    assert.equal(serializedDump.includes("request-opaque-secret"), false);
    assert.equal(serializedDump.includes("provider-opaque-secret"), false);
    assert.equal(serializedDump.includes("provider-visible-secret"), false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    if (previousDump === undefined) {
      delete process.env.KESTREL_MODEL_PROMPT_DUMP;
    } else {
      process.env.KESTREL_MODEL_PROMPT_DUMP = previousDump;
    }
  }
});

contractTest("runtime.hermetic", "ExecutionEngine excludes maintenance model calls from the action model-call budget", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return { ok: true } as T;
    }),
    guardrails: {
      maxModelCallsPerRun: 1,
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (_ctx, io) => {
    await io.useModel({
      model: "mock",
      input: { prompt: "compact once" },
      metadata: { modelBudgetClass: "maintenance", phase: "agent.compaction" },
    });
    await io.useModel({
      model: "mock",
      input: { prompt: "compact twice" },
      metadata: { modelBudgetClass: "maintenance", phase: "agent.compaction" },
    });
    await io.useModel({
      model: "mock",
      input: { prompt: "act once" },
    });
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-maintenance-budget",
    type: "user.message",
    sessionId: "session-maintenance-budget",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.ok(modelCalls >= 3);
  assert.equal(output.telemetry.modelCalls, 3);
  assert.equal(output.telemetry.actionModelCalls, 1);
  assert.equal(output.telemetry.maintenanceModelCalls, 2);
  const requested = store.getRunEvents().filter((event) =>
    event.runId === output.runId && event.type === "model.requested"
  );
  assert.deepEqual(
    requested.map((event) => event.metadata?.modelBudgetClass),
    ["maintenance", "maintenance", "action"],
  );
});

contractTest("runtime.hermetic", "ExecutionEngine refuses too-late deliberator model calls before emitting model start", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return { ok: true } as T;
    }),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (_ctx, io) => {
    await io.useModel({
      input: {
        transcript: {
          version: "transcript-v1",
          items: [
            {
              kind: "correction",
              content: "Near-deadline missing artifact.",
            },
          ],
        },
      },
      responseFormat: "json",
      metadata: {
        phase: "deliberator",
        stepAgent: "agent.loop",
        modelRole: "decision",
      },
    });
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-late-deliberator-deadline",
    type: "user.message",
    sessionId: "session-late-deliberator-deadline",
    payload: {
      metadata: {
        externalDeadlineMs: Date.now() + 1000,
      },
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED");
  assert.equal(modelCalls, 0);
  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  assert.equal(runEvents.some((event) => event.type === "model.requested"), false);
  assert.equal(
    runEvents.some((event) => {
      const update = event.metadata?.update as
        | Record<string, unknown>
        | undefined;
      return update?.code === "MODEL_CALL_STARTED" && update?.stepAgent === "agent.loop";
    }),
    false,
  );
});

contractTest("runtime.hermetic", "ExecutionEngine clamps dev.shell.run timeout to preserve external closeout budget", async () => {
  const store = new InMemorySessionStore();
  let seenInput: Record<string, unknown> | undefined;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async <T>(_name: string, input: unknown) => {
        seenInput = input as Record<string, unknown>;
        return {
          status: "COMPLETED",
          stdout: "trained\n",
          text: "trained\n",
          truncated: false,
          exitCode: 0,
        } as T;
      },
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxToolCallsPerRun: 10,
      maxModelCallsPerRun: 10,
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("dev.shell.run", {
      workspaceRoot: "/app",
      cwd: "/app",
      command: "python3 train.py",
      timeoutMs: 240_000,
    });
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-tool-deadline-clamp",
    type: "user.message",
    sessionId: "session-tool-deadline-clamp",
    payload: {
      metadata: {
        externalDeadlineMs: Date.now() + 95_000,
      },
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(seenInput?.command, "python3 train.py");
  assert.equal(typeof seenInput?.timeoutMs, "number");
  assert.ok((seenInput.timeoutMs as number) <= 35_000);
  assert.ok((seenInput.timeoutMs as number) > 30_000);

  const validated = store.getRunEvents().find((event) =>
    event.runId === output.runId && event.type === "tool.validated"
  );
  assert.equal(validated?.metadata?.requestedTimeoutMs, 240_000);
  assert.equal(validated?.metadata?.deadlineAdjustedTimeoutMs, seenInput.timeoutMs);
  assert.equal(
    (validated?.metadata?.toolInput as Record<string, unknown>).timeoutMs,
    seenInput.timeoutMs,
  );
});

contractTest("runtime.hermetic", "ExecutionEngine returns dev.shell.run deadline exhaustion as tool evidence without dispatch", async () => {
  const store = new InMemorySessionStore();
  let toolCalls = 0;
  let observedResult: Record<string, unknown> | undefined;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => {
        toolCalls += 1;
        return null as never;
      },
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxToolCallsPerRun: 10,
      maxModelCallsPerRun: 10,
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    observedResult = (await io.useTool!("dev.shell.run", {
      workspaceRoot: "/app",
      cwd: "/app",
      command: "python3 train.py",
      timeoutMs: 240_000,
    })).auditRecord.output as Record<string, unknown>;
    return {
      status: "COMPLETED",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-tool-deadline-exhausted",
    type: "user.message",
    sessionId: "session-tool-deadline-exhausted",
    payload: {
      metadata: {
        externalDeadlineMs: Date.now() + 61_000,
      },
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls, 0);
  assert.equal(observedResult?.status, "FAILED");
  assert.equal(observedResult?.exitCode, 124);
  assert.match(String(observedResult?.failureReason ?? ""), /Not enough external runtime budget/u);

  const validated = store.getRunEvents().find((event) =>
    event.runId === output.runId && event.type === "tool.validated"
  );
  assert.equal(validated?.metadata?.toolDeadlineAdmission, "deadline_exhausted");
  assert.equal(validated?.metadata?.requestedTimeoutMs, 240_000);
});

contractTest("runtime.hermetic", "ExecutionEngine canonicalizes active dev.process.write process identity for loop guard evidence", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 10,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? ctx.session.state.count : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          exec: {
            devShell: {
              activeProcessId: "proc-maze",
            },
          },
          nextAction: {
            kind: "tool",
            name: "dev.process.write",
            input: {
              processId: "stale-proc",
              input: "move N\n",
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Repeating maze input ${count + 1}.`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-dev-shell-input-loop-guard-canonical-session",
    type: "user.message",
    sessionId: "session-dev-shell-input-loop-guard-canonical-session",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "REPEATED_SAME_TOOL_CYCLE");
  assert.equal(
    output.errors[0]?.details?.toolInputHash,
    "{\"input\":\"move N\\n\",\"processId\":\"proc-maze\"}",
  );
});

contractTest("runtime.hermetic", "ExecutionEngine does not treat active dev.process.read output collection as redundant retrieval pivot", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 4,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-active-read-not-retrieval-pivot", "agent.loop");
  await store.commitStep({
    runId: "seed-run",
    event: {
      id: "seed-event",
      type: "user.message",
      sessionId: "session-active-read-not-retrieval-pivot",
      payload: {},
    },
    sessionId: "session-active-read-not-retrieval-pivot",
    expectedVersion: 0,
    stepIndex: 0,
    nextStepAgent: "agent.loop",
    effects: [],
    emitEvents: [],
    statePatch: {
      agent: {
        exec: {
          devShell: {
            activeProcessId: "proc-maze",
            lastCommandLifecycle: "active_streaming",
          },
        },
        lastActionResult: {
          toolName: "dev.process.read",
          processId: "proc-maze",
          status: "RUNNING",
          chunk: "\nmove E\n> moved\n",
        },
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "prior-read-1",
              evidenceHash: "{}",
              observationMarker: "prior active read 1",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"dev.process.read\"}",
              cycleKind: "reasoning",
              toolActionName: "dev.process.read",
              toolActionInputHash: "{\"processId\":\"proc-maze\"}",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
              retrievalToolName: "dev.process.read",
              retrievalInput: {
                toolName: "dev.process.read",
                primaryText: "maze shell",
                comparableFields: {
                  processId: "proc maze",
                },
              },
              retrievalOutput: {
                topUrls: [],
                topDomains: [],
                topSignals: ["shell-maze | running"],
              },
            },
            {
              stepName: "agent.loop",
              fingerprint: "prior-read-2",
              evidenceHash: "{}",
              observationMarker: "prior active read 2",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"dev.process.read\"}",
              cycleKind: "reasoning",
              toolActionName: "dev.process.read",
              toolActionInputHash: "{\"processId\":\"proc-maze\"}",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
              retrievalToolName: "dev.process.read",
              retrievalInput: {
                toolName: "dev.process.read",
                primaryText: "maze shell",
                comparableFields: {
                  processId: "proc maze",
                },
              },
              retrievalOutput: {
                topUrls: [],
                topDomains: [],
                topSignals: ["shell-maze | running"],
              },
            },
          ],
        },
      },
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "react.done",
    statePatch: {
      agent: {
        exec: {
          devShell: {
            activeProcessId: "proc-maze",
            lastCommandLifecycle: "active_streaming",
          },
        },
        nextAction: {
          kind: "tool",
          name: "dev.process.read",
          input: {
            processId: "proc-maze",
          },
        },
        requiredCapabilities: ["dev.shell"],
        capabilityEvidence: {},
        observations: [
          {
            summary: "Collecting active foreground output.",
            goalMet: false,
          },
        ],
      },
    },
  }));

  kestrel.registerStep("react.done", async () => ({
    status: "COMPLETED",
    statePatch: {},
  }));

  const output = await kestrel.run({
    id: "evt-active-read-not-retrieval-pivot",
    type: "user.message",
    sessionId: "session-active-read-not-retrieval-pivot",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);
});

contractTest("runtime.hermetic", "ExecutionEngine does not persist or replay decisionTrace after emission", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("react.trace.once", async (ctx) => {
    const cycle = typeof ctx.session.state.cycle === "number" ? ctx.session.state.cycle : 0;
    return {
      status: cycle === 0 ? "RUNNING" : "COMPLETED",
      nextStepAgent: cycle === 0 ? "react.trace.once" : undefined,
      statePatch: {
        cycle: cycle + 1,
        agent: {
          observations: [
            {
              summary: `cycle-${cycle + 1}`,
              goalMet: cycle > 0,
            },
          ],
          ...(cycle === 0
            ? {
                decisionTrace: [
                  {
                    eventType: "tool.result_summarized",
                    phase: "acter",
                    decisionCode: "tool_result_summarized",
                    metadata: {
                      toolName: "internet.search",
                      artifactId: "artifact-1",
                    },
                  },
                ],
              }
            : {}),
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-trace-once",
    type: "user.message",
    sessionId: "session-trace-once",
    payload: {},
    stepAgent: "react.trace.once",
  });

  assert.equal(output.status, "COMPLETED");
  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  const summarized = runEvents.filter((event) => event.type === "tool.result_summarized");
  assert.equal(summarized.length, 1);
  const session = await store.getSession("session-trace-once");
  const reactState = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal("decisionTrace" in reactState, false);
});

contractTest("runtime.hermetic", "ExecutionEngine trips LOOP_GUARD_TRIGGERED before max-steps on repeated same-tool loop cycles", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: "internet.news",
            input: {
              query: "news headlines for Cincinnati",
            },
          },
          requiredCapabilities: ["news.search"],
          capabilityEvidence: {
            "news.search": {
              tool: "internet.news",
              stepIndex: 1,
            },
          },
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-same-tool-loop-guard",
    type: "user.message",
    sessionId: "session-same-tool-loop-guard",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "REPEATED_SAME_TOOL_CYCLE");
  assert.equal(output.errors[0]?.details?.step, "agent.loop");
  assert.equal(output.errors[0]?.details?.toolName, "internet.news");
  assert.equal(typeof output.errors[0]?.details?.toolInputHash, "string");
  assert.equal(typeof output.errors[0]?.details?.actionSignatureHash, "string");
  assert.equal(typeof output.errors[0]?.details?.latestEvidenceHash, "string");
  assert.equal(output.telemetry.stepsExecuted < 20, true);
});

const repeatedFilesystemInspectionCases = [
  { toolName: "fs.read_text", input: { path: "app/page.tsx" } },
  { toolName: "fs.list", input: { path: "." } },
  { toolName: "fs.search_text", input: { path: ".", query: "newsletter" } },
] as const;

const assertRepeatedFilesystemInspectionLoopGuard = async (
  row: (typeof repeatedFilesystemInspectionCases)[number],
) => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 5,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: row.toolName,
          input: row.input,
        },
        observations: [
          {
            summary: `Repeated filesystem inspection through ${row.toolName}.`,
            goalMet: false,
          },
        ],
      },
    },
  }));

    const output = await kestrel.run({
      id: `evt-filesystem-loop-${row.toolName}`,
      type: "user.message",
      sessionId: `session-filesystem-loop-${row.toolName}`,
      payload: {},
      stepAgent: "agent.loop",
    });

    assert.equal(output.status, "FAILED");
    assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
    assert.equal(
      store.getRunEvents().some((event) => event.type === "loop.guard_triggered"),
      true,
    );
};

contractTest("runtime.hermetic", "ExecutionEngine loop-guards repeated filesystem inspection for fs.read_text", () =>
  assertRepeatedFilesystemInspectionLoopGuard(repeatedFilesystemInspectionCases[0]));
contractTest("runtime.hermetic", "ExecutionEngine loop-guards repeated filesystem inspection for fs.list", () =>
  assertRepeatedFilesystemInspectionLoopGuard(repeatedFilesystemInspectionCases[1]));
contractTest("runtime.hermetic", "ExecutionEngine loop-guards repeated filesystem inspection for fs.search_text", () =>
  assertRepeatedFilesystemInspectionLoopGuard(repeatedFilesystemInspectionCases[2]));

contractTest("runtime.hermetic", "ExecutionEngine ignores volatile capability evidence metadata when enforcing repeated same-tool guard", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: "dev.process.read",
            input: {
              processId: "proc-1",
            },
          },
          requiredCapabilities: ["dev.shell"],
          capabilityEvidence: {
            "dev.shell": {
              tool: "dev.process.read",
              stepIndex: count + 1,
              ts: new Date(1_700_000_000_000 + count * 1000).toISOString(),
            },
          },
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-same-tool-loop-guard-volatile-evidence",
    type: "user.message",
    sessionId: "session-same-tool-loop-guard-volatile-evidence",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "REPEATED_SAME_TOOL_CYCLE");
  assert.equal((output.errors[0]?.details?.repeats as number | undefined) ?? 0, 3);
  assert.equal(output.telemetry.stepsExecuted < 20, true);
});

contractTest("runtime.hermetic", "ExecutionEngine counts only loop decisions for repeated same-tool loop guard", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => ({ ok: true }) as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 10,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: "internet.news",
            input: {
              query: "news headlines for Cincinnati",
            },
          },
          requiredCapabilities: ["news.search"],
          capabilityEvidence: {
            "news.search": {
              tool: "internet.news",
              stepIndex: 1,
            },
          },
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent as Record<string, unknown> | undefined) ?? {}),
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-same-tool-loop-guard-loop-only",
    type: "user.message",
    sessionId: "session-same-tool-loop-guard-loop-only",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "REPEATED_SAME_TOOL_CYCLE");
  assert.equal((output.errors[0]?.details?.repeats as number | undefined) ?? 0, 3);
  assert.equal(output.telemetry.stepsExecuted >= 5, true);
});

contractTest("runtime.hermetic", "ExecutionEngine ignores legacy loop history entries without stepName for repeated same-tool guard", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => ({ ok: true }) as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 4,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-legacy-same-tool-loop-guard", "agent.loop");
  await store.commitStep({
    runId: "seed-run",
    event: {
      id: "seed-event",
      type: "user.message",
      sessionId: "session-legacy-same-tool-loop-guard",
      payload: {},
    },
    sessionId: "session-legacy-same-tool-loop-guard",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        loopGuard: {
          history: [
            {
              fingerprint: "legacy-fingerprint-1",
              evidenceHash: "{\"news.search\":{\"stepIndex\":1,\"tool\":\"internet.news\"}}",
              observationMarker: "legacy loop cycle 1",
              waitToken: "",
              pendingExecutionHash: "",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              cycleKind: "reasoning",
              toolActionName: "internet.news",
              toolActionInputHash: "{\"query\":\"news headlines for Cincinnati\"}",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
            {
              fingerprint: "legacy-fingerprint-2",
              evidenceHash: "{\"news.search\":{\"stepIndex\":1,\"tool\":\"internet.news\"}}",
              observationMarker: "legacy loop cycle 2",
              waitToken: "",
              pendingExecutionHash: "",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              cycleKind: "reasoning",
              toolActionName: "internet.news",
              toolActionInputHash: "{\"query\":\"news headlines for Cincinnati\"}",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async () => ({
    status: "RUNNING",
    nextStepAgent: "react.done",
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "news headlines for Cincinnati",
          },
        },
        requiredCapabilities: ["news.search"],
        capabilityEvidence: {
          "news.search": {
            tool: "internet.news",
            stepIndex: 1,
          },
        },
        observations: [
          {
            summary: "Current loop cycle",
            goalMet: false,
          },
        ],
      },
    },
  }));

  kestrel.registerStep("react.done", async () => ({
    status: "COMPLETED",
    statePatch: {},
  }));

  const output = await kestrel.run({
    id: "evt-legacy-same-tool-loop-guard",
    type: "user.message",
    sessionId: "session-legacy-same-tool-loop-guard",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);
});

contractTest("runtime.hermetic", "ExecutionEngine trips LOOP_GUARD_TRIGGERED on repeated low-yield web extraction for the same hashed input", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: count % 2 === 0 ? "internet.extract" : "internet.extract",
            input: {
              url: "https://www.poemhunter.com/poem/evil-tree/",
            },
          },
          postToolVerification: {
            webExtractionRetrySummary: {
              objectiveKey: "compare poems",
              searchFallbackUsed: false,
              clusters: [
                {
                  key: "compare poems:poemhunter.com/poem",
                  sourceCluster: "poemhunter.com/poem",
                  attempts: 2,
                  lowYieldAttempts: 2,
                  consecutiveLowYield: 2,
                  lastToolName: "internet.extract",
                  lastQuality: "low",
                  lastIssues: ["selector_unresolved", "truncated_content"],
                  searchFallbackUsed: false,
                },
              ],
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-low-yield-web-loop-guard",
    type: "user.message",
    sessionId: "session-low-yield-web-loop-guard",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.errors[0]?.details?.guardType, "REPEATED_SAME_TOOL_CYCLE");
  assert.equal(output.telemetry.stepsExecuted < 20, true);
});

contractTest("runtime.hermetic", "ExecutionEngine does not trip low-yield web extraction guard when the cluster repeats with different hashed inputs", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 4,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: "internet.extract",
            input: {
              url: `https://www.clevelandmagazine.com/articles/story-${count + 1}`,
            },
          },
          postToolVerification: {
            webExtractionRetrySummary: {
              objectiveKey: "review cleveland magazine article coverage",
              searchFallbackUsed: false,
              clusters: [
                {
                  key: "review cleveland magazine article coverage:clevelandmagazine.com/articles",
                  sourceCluster: "clevelandmagazine.com/articles",
                  attempts: 2,
                  lowYieldAttempts: 2,
                  consecutiveLowYield: 2,
                  lastToolName: "internet.extract",
                  lastQuality: "low",
                  lastIssues: ["truncated_content"],
                  searchFallbackUsed: false,
                },
              ],
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-low-yield-web-loop-guard-distinct-inputs",
    type: "user.message",
    sessionId: "session-low-yield-web-loop-guard-distinct-inputs",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.notEqual(output.errors[0]?.details?.guardType, "REPEATED_LOW_YIELD_WEB_EXTRACTION");
});

contractTest("runtime.hermetic", "ExecutionEngine completes with partial output instead of requesting continuation for stalled research", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 5,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    const toolName =
      count % 3 === 0
        ? "internet.search"
        : count % 3 === 1
          ? "internet.news"
          : "internet.research";
    const toolInput = {
      query: "Tesla xAI legal conflict",
      page: count + 1,
    };
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        count: count + 1,
        agent: {
          goal: "Investigate Tesla and xAI legal conflict",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Investigate Tesla and xAI legal conflict",
            candidateTools: ["internet.search", "internet.news", "internet.research"],
            confidence: 0.9,
            workflowIntent: {
              kind: "research",
            },
          },
          plan: {
            intent: "Investigate Tesla and xAI legal conflict",
          },
          nextAction: {
            kind: "tool",
            name: toolName,
            input: toolInput,
          },
          postToolVerification: {
            evidenceRecoverySummary: {
              objectiveKey: "investigate tesla and xai legal conflict",
              family: "news_research",
              attempts: count + 1,
              lowSignalAttempts: count + 1,
              consecutiveLowSignal: count + 1,
              broadenedSearchUsed: true,
              targetedFetchUsed: false,
              latest: {
                family: "news_research",
                toolName: "internet.news",
                quality: "low",
                lowSignal: true,
                issues: ["repeated_payload", "low_signal_mix"],
                resultsCount: 3,
                domainDiversity: 2,
                payloadFingerprint: "repeat-fp",
                repeatedFingerprintCount: count + 1,
                candidateUrls: [
                  "https://example.com/story-1",
                  "https://example.com/story-2",
                ],
              },
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
          lastActionResult: {
            kind: "tool",
            name: toolName,
            input: toolInput,
          },
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent as Record<string, unknown> | undefined) ?? {}),
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-stalled-research-partial",
    type: "user.message",
    sessionId: "session-stalled-research-partial",
    payload: {
      message: "Investigate Tesla and xAI legal conflict",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.waitFor, undefined);
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-stalled-research-partial");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  const finalOutput = (react.finalOutput ?? {}) as Record<string, unknown>;
  assert.equal(terminal.reasonCode, "research_stalled_partial");
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.researchStalled, true);
  assert.equal(
    (finalOutput.data as Record<string, unknown> | undefined)?.retrievalToolFamily,
    "internet.search_like",
  );
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.lowSignalState, "elevated");
  assert.match(String(finalOutput.message ?? ""), /Evidence gap:/u);
  assert.match(String(finalOutput.message ?? ""), /low-yield retrieval/u);
});

contractTest("runtime.hermetic", "ExecutionEngine does not treat source.fetch as low-yield internet extraction churn", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 4,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const count = typeof (ctx.session.state.count as number | undefined) === "number"
      ? (ctx.session.state.count as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        count: count + 1,
        agent: {
          nextAction: {
            kind: "tool",
            name: "source.fetch",
            input: {
              url: `https://www.poemhunter.com/poem/evil-tree/${count + 1}`,
              maxChars: 4000,
            },
          },
          postToolVerification: {
            webExtractionRetrySummary: {
              objectiveKey: "compare poems",
              searchFallbackUsed: false,
              clusters: [
                {
                  key: "compare poems:poemhunter.com/poem",
                  sourceCluster: "poemhunter.com/poem",
                  attempts: 2,
                  lowYieldAttempts: 2,
                  consecutiveLowYield: 2,
                  lastToolName: "internet.extract",
                  lastQuality: "low",
                  lastIssues: ["selector_unresolved", "truncated_content"],
                  searchFallbackUsed: false,
                },
              ],
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${count + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-source-fetch-no-low-yield-loop-guard",
    type: "user.message",
    sessionId: "session-source-fetch-no-low-yield-loop-guard",
    payload: {},
    stepAgent: "agent.loop",
  });

  assert.notEqual(output.status, "COMPLETED");
  assert.notEqual(output.errors[0]?.details?.guardType, "REPEATED_LOW_YIELD_WEB_EXTRACTION");
});

contractTest("runtime.hermetic", "ExecutionEngine converts qualifying dispatch reuse stalls into research_stalled_partial completion", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-dispatch-stall-research-partial", "agent.exec.dispatch");
  await store.commitStep({
    runId: "seed-dispatch-stall-partial",
    event: {
      id: "seed-dispatch-stall-partial",
      type: "user.message",
      sessionId: "session-dispatch-stall-research-partial",
      payload: {
        message: "give me the top us news headlines",
      },
    },
    sessionId: "session-dispatch-stall-research-partial",
    expectedVersion: 0,
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        goal: "give me the top us news headlines",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "give me the top us news headlines",
          candidateTools: ["internet.news", "internet.news"],
          confidence: 0.9,
          workflowIntent: {
            kind: "research",
          },
        },
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "top us news headlines today",
            region: "us",
            limit: 20,
          },
        },
        capabilityEvidence: {
          "news.headlines": {
            tool: "internet.news",
            stepIndex: 12,
            ts: "2026-03-17T17:45:35.170Z",
          },
          "news.search": {
            tool: "internet.news",
            stepIndex: 24,
            ts: "2026-03-17T17:46:37.667Z",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "give me the top us news headlines",
            family: "news_research",
            attempts: 5,
            lowSignalAttempts: 5,
            consecutiveLowSignal: 5,
            broadenedSearchUsed: true,
            targetedFetchUsed: true,
            latest: {
              family: "news_research",
              toolName: "internet.news",
              quality: "low",
              lowSignal: true,
              issues: ["low_signal_mix", "repeated_payload"],
              resultsCount: 5,
              domainDiversity: 2,
              payloadFingerprint: "fp-stalled",
              repeatedFingerprintCount: 3,
              candidateUrls: [
                "https://example.com/story-1",
                "https://example.com/story-2",
              ],
            },
          },
        },
        observations: [
          {
            summary: "Existing evidence is insufficient.",
            goalMet: false,
          },
        ],
        exec: {
          substate: "collect",
          dispatchReuseGuard: {
            runId: "placeholder-run",
            toolName: "internet.news",
            inputHash: "58339a11030b4881",
            consecutiveReuseCount: 1,
          },
        },
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":1}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need broader headlines before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":2}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need broader headlines before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":3}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need broader headlines before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.exec.dispatch", async () => {
    throw createRuntimeFailure(
      "AGENT_DISPATCH_STALL_DETECTED",
      "Execution dispatch detected repeated deduped tool reuse without new evidence and aborted to prevent a loop.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "runtime",
        recoverable: true,
        toolName: "internet.news",
        inputHash: "58339a11030b4881",
        consecutiveReuseCount: 2,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-dispatch-stall-research-partial",
    type: "system.meta_reasoning",
    sessionId: "session-dispatch-stall-research-partial",
    payload: {
      reason: "resume_stalled_research_dispatch",
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-dispatch-stall-research-partial");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const nextAction = (react.nextAction ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  const finalOutput = (react.finalOutput ?? {}) as Record<string, unknown>;
  assert.equal(nextAction.finalizeReason, "tool_unavailable");
  assert.equal(((nextAction.supportEvidence as Record<string, unknown>)?.reason), "research_stalled_partial");
  assert.equal(
    ((nextAction.supportEvidence as Record<string, unknown>)?.retrievalToolFamily),
    "internet.search_like",
  );
  assert.equal(((nextAction.supportEvidence as Record<string, unknown>)?.lowSignalState), "exhausted");
  assert.equal(terminal.reasonCode, "research_stalled_partial");
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.researchStalled, true);
  assert.equal(
    (finalOutput.data as Record<string, unknown> | undefined)?.retrievalToolFamily,
    "internet.search_like",
  );
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.objective, "give me the top us news headlines");
  assert.match(String(finalOutput.message ?? ""), /Evidence gap:/u);
});

contractTest("runtime.hermetic", "ExecutionEngine preserves dispatch stall failures when research stall thresholds are not met", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-dispatch-stall-unrecovered", "agent.exec.dispatch");
  await store.commitStep({
    runId: "seed-dispatch-stall-unrecovered",
    event: {
      id: "seed-dispatch-stall-unrecovered",
      type: "user.message",
      sessionId: "session-dispatch-stall-unrecovered",
      payload: {
        message: "give me the top us news headlines",
      },
    },
    sessionId: "session-dispatch-stall-unrecovered",
    expectedVersion: 0,
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        goal: "give me the top us news headlines",
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "top us news headlines today",
            region: "us",
            limit: 20,
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "give me the top us news headlines",
            family: "news_research",
            attempts: 1,
            lowSignalAttempts: 1,
            consecutiveLowSignal: 1,
            broadenedSearchUsed: false,
            targetedFetchUsed: false,
            latest: {
              family: "news_research",
              toolName: "internet.news",
              quality: "low",
              lowSignal: true,
              issues: ["low_signal_mix"],
              resultsCount: 5,
              domainDiversity: 2,
              payloadFingerprint: "fp-failed",
              repeatedFingerprintCount: 1,
              candidateUrls: ["https://example.com/story-1"],
            },
          },
        },
        observations: [
          {
            summary: "Initial low-signal result.",
            goalMet: false,
          },
        ],
        exec: {
          dispatchReuseGuard: {
            runId: "placeholder-run",
            toolName: "internet.news",
            inputHash: "58339a11030b4881",
            consecutiveReuseCount: 1,
          },
        },
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":1}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need broader headlines before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.exec.dispatch", async () => {
    throw createRuntimeFailure(
      "REACT_DISPATCH_STALL_DETECTED",
      "Execution dispatch detected repeated deduped tool reuse without new evidence and aborted to prevent a loop.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "runtime",
        recoverable: true,
        toolName: "internet.news",
        inputHash: "58339a11030b4881",
        consecutiveReuseCount: 2,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-dispatch-stall-unrecovered",
    type: "system.meta_reasoning",
    sessionId: "session-dispatch-stall-unrecovered",
    payload: {
      reason: "resume_unrecovered_dispatch_stall",
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "REACT_DISPATCH_STALL_DETECTED");
});

contractTest("runtime.hermetic", "ExecutionEngine converts qualifying MAX_STEP_VISITS_EXCEEDED research loops into research_stalled_partial completion", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 2,
    },
  });

  await store.ensureSession("session-max-step-visits-research-stall", "agent.exec.dispatch");
  await store.commitStep({
    runId: "seed-max-step-visits-research-stall",
    event: {
      id: "seed-max-step-visits-research-stall",
      type: "user.message",
      sessionId: "session-max-step-visits-research-stall",
      payload: {
        message: "Find top US news headlines with sources",
      },
    },
    sessionId: "session-max-step-visits-research-stall",
    expectedVersion: 0,
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        goal: "Find top US news headlines with sources",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "Find top US news headlines with sources",
          candidateTools: ["internet.news", "internet.news"],
          confidence: 0.9,
          workflowIntent: {
            kind: "research",
          },
        },
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "top us news headlines today",
            region: "us",
            limit: 20,
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "Find top US news headlines with sources",
            family: "news_research",
            attempts: 5,
            lowSignalAttempts: 5,
            consecutiveLowSignal: 5,
            broadenedSearchUsed: true,
            targetedFetchUsed: true,
            latest: {
              family: "news_research",
              toolName: "internet.news",
              quality: "low",
              lowSignal: true,
              issues: ["low_signal_mix", "repeated_payload"],
              resultsCount: 5,
              domainDiversity: 2,
              payloadFingerprint: "fp-stalled-max-step-visits",
              repeatedFingerprintCount: 3,
              candidateUrls: ["https://example.com/story-1"],
            },
          },
        },
        capabilityEvidence: {
          "news.headlines": {
            tool: "internet.news",
            stepIndex: 12,
            ts: "2026-03-17T17:45:35.170Z",
          },
        },
        observations: [
          {
            summary: "Existing evidence remains low-signal.",
            goalMet: false,
          },
        ],
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":1}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need better source quality before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":2}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need better source quality before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":3}",
              evidenceHash: "{\"news.headlines\":{\"stepIndex\":12}}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "Need better source quality before responding.",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent as Record<string, unknown> | undefined) ?? {}),
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-max-step-visits-research-stall",
    type: "system.meta_reasoning",
    sessionId: "session-max-step-visits-research-stall",
    payload: {
      reason: "resume_stalled_research",
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-max-step-visits-research-stall");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  const finalOutput = (react.finalOutput ?? {}) as Record<string, unknown>;
  assert.equal(terminal.reasonCode, "research_stalled_partial");
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.researchStalled, true);
  assert.equal(
    (finalOutput.data as Record<string, unknown> | undefined)?.retrievalToolFamily,
    "internet.search_like",
  );
  assert.equal((finalOutput.data as Record<string, unknown> | undefined)?.lowSignalState, "exhausted");
  assert.equal(
    (finalOutput.data as Record<string, unknown> | undefined)?.objective,
    "Find top US news headlines with sources",
  );

  const events = store.getRunEvents();
  const detected = events.find((event) => event.type === "loop.stall_detected");
  const converted = events.find((event) => event.type === "loop.stall_converted");
  assert.equal(detected?.metadata?.guardType, "MAX_STEP_VISITS_EXCEEDED");
  assert.equal(detected?.metadata?.stepAgent, "agent.exec.dispatch");
  assert.equal(detected?.metadata?.toolName, "internet.news");
  assert.equal(converted?.metadata?.resolution, "research_stalled_partial");
});

contractTest("runtime.hermetic", "ExecutionEngine checkpoints repeated filesystem loop visit stalls with a concrete target", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 1,
    },
  });

  await store.ensureSession("session-loop-stall-concrete-target", "agent.loop");
  await store.commitStep({
    runId: "seed-loop-stall-concrete-target",
    event: {
      id: "seed-loop-stall-concrete-target",
      type: "user.message",
      sessionId: "session-loop-stall-concrete-target",
      payload: {
        message: "Inspect this worktree",
      },
    },
    sessionId: "session-loop-stall-concrete-target",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "Inspect this worktree",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "~/.kestrel/sessions/reference-session-1/session-note.md",
          },
        },
        observations: [
          {
            summary: "Inspecting the session plan file.",
            goalMet: false,
          },
        ],
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "target-1",
              evidenceHash: "same-evidence",
              observationMarker: "Inspecting the session plan file.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"fs.read_text\"}",
              cycleKind: "reasoning",
              toolActionName: "fs.read_text",
              toolActionInputHash: "path-hash",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
            {
              stepName: "agent.loop",
              fingerprint: "target-2",
              evidenceHash: "same-evidence",
              observationMarker: "Inspecting the session plan file.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"fs.read_text\"}",
              cycleKind: "reasoning",
              toolActionName: "fs.read_text",
              toolActionInputHash: "path-hash",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
            {
              stepName: "agent.loop",
              fingerprint: "target-3",
              evidenceHash: "same-evidence",
              observationMarker: "Inspecting the session plan file.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"fs.read_text\"}",
              cycleKind: "reasoning",
              toolActionName: "fs.read_text",
              toolActionInputHash: "path-hash",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent as Record<string, unknown> | undefined) ?? {}),
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-stall-concrete-target",
    type: "system.meta_reasoning",
    sessionId: "session-loop-stall-concrete-target",
    payload: {
      reason: "resume_loop_stall",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.length, 0);
  assert.equal(output.waitFor?.metadata?.resolution, "checkpoint_wait");
  assert.equal((output.waitFor?.metadata?.target as Record<string, unknown> | undefined)?.field, "path");

  const events = store.getRunEvents();
  const converted = events.find((event) => event.type === "loop.stall_converted");
  assert.equal(converted?.metadata?.resolution, "checkpoint_wait");
  assert.equal(converted?.metadata?.toolName, "fs.read_text");
});

contractTest("runtime.hermetic", "ExecutionEngine asks for narrowing on broad repeated loop visit stalls", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 1,
    },
  });

  await store.ensureSession("session-loop-stall-broad", "agent.loop");
  await store.commitStep({
    runId: "seed-loop-stall-broad",
    event: {
      id: "seed-loop-stall-broad",
      type: "user.message",
      sessionId: "session-loop-stall-broad",
      payload: {
        message: "Keep inspecting everything",
      },
    },
    sessionId: "session-loop-stall-broad",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "Keep inspecting everything",
        observations: [
          {
            summary: "The inspection is still broad.",
            goalMet: false,
          },
        ],
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "broad-1",
              evidenceHash: "same-evidence",
              observationMarker: "The inspection is still broad.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"no_action\"}",
              cycleKind: "reasoning",
              toolActionName: "",
              toolActionInputHash: "",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
            {
              stepName: "agent.loop",
              fingerprint: "broad-2",
              evidenceHash: "same-evidence",
              observationMarker: "The inspection is still broad.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"no_action\"}",
              cycleKind: "reasoning",
              toolActionName: "",
              toolActionInputHash: "",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
            {
              stepName: "agent.loop",
              fingerprint: "broad-3",
              evidenceHash: "same-evidence",
              observationMarker: "The inspection is still broad.",
              waitToken: "",
              pendingExecutionHash: "{}",
              actionSignature: "{\"kind\":\"no_action\"}",
              cycleKind: "reasoning",
              toolActionName: "",
              toolActionInputHash: "",
              toolActionSourceCluster: "",
              toolActionLowYield: false,
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent as Record<string, unknown> | undefined) ?? {}),
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-loop-stall-broad",
    type: "system.meta_reasoning",
    sessionId: "session-loop-stall-broad",
    payload: {
      reason: "resume_broad_loop_stall",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.errors.length, 0);
  assert.equal(output.waitFor?.metadata?.resolution, "clarification_wait");
  assert.match(String(output.waitFor?.metadata?.question ?? ""), /narrower slice/u);
});

contractTest("runtime.hermetic", "ExecutionEngine preserves MAX_STEP_VISITS_EXCEEDED failures for non-research loops", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 2,
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.exec.dispatch",
    statePatch: {
      agent: {
        goal: "Tell me the current UTC time",
        nextAction: {
          kind: "tool",
          name: "free.time.current",
          input: {
            timezone: "Etc/UTC",
          },
        },
        observations: [
          {
            summary: "Looping without research retrieval context.",
            goalMet: false,
          },
        ],
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-max-step-visits-non-research",
    type: "user.message",
    sessionId: "session-max-step-visits-non-research",
    payload: {
      message: "Tell me the current UTC time",
    },
    stepAgent: "agent.exec.dispatch",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "MAX_STEP_VISITS_EXCEEDED");
});
