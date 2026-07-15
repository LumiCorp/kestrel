import test from "node:test";
import assert from "node:assert/strict";

import {
  applyReferenceReactExecPatch,
  buildReferenceReactCommandBatchFromAction,
  createReferenceReactEffectCollectCheckpoint,
  createReferenceReactEffectDispatchCheckpoint,
  createReferenceReactExecutionCheckpoint,
  createReferenceReactFinalizeCheckpoint,
  createReferenceReactWaitCheckpoint,
  ReferenceReactCommandProcessor,
} from "../../agents/reference-react/src/commandProcessor.js";
import { createExecCollectStep, createExecDispatchStep } from "../../agents/reference-react/src/steps/execStates.js";

const snapshot = {
  runId: "run-1",
  sessionId: "session-1",
  stepIndex: 3,
  currentStepAgent: "agent.loop",
  nextStepAgent: "agent.exec.dispatch",
  reactState: {},
};

test("ReferenceReactCommandProcessor allows parallel read batches and records visible working plan", () => {
  const result = new ReferenceReactCommandProcessor().process(snapshot, {
    batchId: "batch-read",
    planningSummary: "Read the relevant files before editing.",
    commands: [
      {
        commandId: "cmd-1",
        kind: "tool",
        commandClass: "read",
        name: "fs.read_text",
        input: { path: "src/a.ts" },
      },
      {
        commandId: "cmd-2",
        kind: "tool",
        commandClass: "read",
        name: "fs.search_text",
        input: { pattern: "handler" },
      },
    ],
  });

  assert.equal(result.executionMode, "parallel_read_batch");
  assert.equal(result.transition.status, "RUNNING");
  assert.deepEqual(result.workingPlan.commandNames, ["fs.read_text", "fs.search_text"]);
  assert.equal(
    (result.transition.statePatch?.agent as Record<string, unknown>)["workingPlan"] !== undefined,
    true,
  );
});

test("ReferenceReactCommandProcessor rejects mixed side-effect batches", () => {
  assert.throws(
    () =>
      new ReferenceReactCommandProcessor().process(snapshot, {
        batchId: "batch-write",
        commands: [
          {
            commandId: "cmd-1",
            kind: "tool",
            commandClass: "write",
            name: "fs.write_text",
          },
          {
            commandId: "cmd-2",
            kind: "tool",
            commandClass: "effect",
            name: "tool_batch",
          },
        ],
      }),
    /only one side-effect command/u,
  );
});

test("ReferenceReactCommandProcessor turns waits into WAITING transitions", () => {
  const result = new ReferenceReactCommandProcessor().process(snapshot, {
    batchId: "batch-wait",
    commands: [
      {
        commandId: "cmd-1",
        kind: "wait",
        commandClass: "wait",
        name: "ask_user",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: { prompt: "Which target should I inspect next?" },
        },
      },
    ],
  });

  assert.equal(result.executionMode, "ordered_checkpoint");
  assert.equal(result.transition.status, "WAITING");
  assert.equal(result.transition.waitFor?.eventType, "user.reply");
});

test("buildReferenceReactCommandBatchFromAction keeps read batches parallel and side effects checkpointed", () => {
  const readBatch = buildReferenceReactCommandBatchFromAction({
    stepIndex: 4,
    toolExecutionClassByName: {
      "fs.read_text": "read_only",
      "fs.search_text": "read_only",
    },
    action: {
      kind: "tool_batch",
      items: [
        { name: "fs.read_text", input: { path: "src/a.ts" } },
        { name: "fs.search_text", input: { pattern: "handler" } },
      ],
    },
  });

  assert.equal(readBatch.commands.length, 2);
  assert.deepEqual(readBatch.commands.map((command) => command.commandClass), ["read", "read"]);

  const sideEffectBatch = buildReferenceReactCommandBatchFromAction({
    stepIndex: 5,
    toolExecutionClassByName: {
      "fs.write_text": "sandboxed_only",
      "dev.shell.run": "sandboxed_only",
    },
    action: {
      kind: "tool_batch",
      items: [
        { name: "fs.write_text", input: { path: "src/a.ts", text: "ok" } },
        { name: "dev.shell.run", input: { command: "pnpm test" } },
      ],
    },
  });

  assert.equal(sideEffectBatch.commands.length, 1);
  assert.equal(sideEffectBatch.commands[0]?.name, "tool_batch");
  assert.equal(sideEffectBatch.commands[0]?.commandClass, "effect");
});

test("buildReferenceReactCommandBatchFromAction preserves planning_write tools as write checkpoints", () => {
  const batch = buildReferenceReactCommandBatchFromAction({
    stepIndex: 6,
    toolExecutionClassByName: {
      "planning.write_document": "planning_write",
    },
    action: {
      kind: "tool",
      name: "planning.write_document",
      input: {
        path: "PLAN.md",
        content: "# Plan\n",
      },
    },
  });

  assert.equal(batch.commands.length, 1);
  assert.equal(batch.commands[0]?.name, "planning.write_document");
  assert.equal(batch.commands[0]?.commandClass, "write");
});

test("createReferenceReactExecutionCheckpoint records processor-owned route state", () => {
  const transition = createReferenceReactExecutionCheckpoint({
    snapshot: {
      ...snapshot,
      currentStepAgent: "agent.exec.collect",
      nextStepAgent: "agent.loop",
      reactState: {
        exec: {
          pendingBatch: {
            items: [],
            nextIndex: 0,
          },
        },
      },
    },
    nextStepAgent: "agent.loop",
    substate: "collect",
    phase: "OBSERVE",
    clearPendingBatch: true,
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(react.phase, "OBSERVE");
  assert.equal(exec.substate, "collect");
  assert.equal(exec.pendingBatch, undefined);
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(lastCheckpoint.currentStepAgent, "agent.exec.collect");
  assert.equal(workingPlan.status, "collecting");
});

test("applyReferenceReactExecPatch centralizes pending exec state merges", () => {
  const patched = applyReferenceReactExecPatch(
    {
      phase: "ACT",
      exec: {
        substate: "dispatch",
        pendingEffectKey: "effect-1",
      },
    },
    {
      pendingEffectKey: undefined,
      pendingApproval: {
        approvalId: "approval-1",
      },
    },
  );

  assert.deepEqual(patched, {
    phase: "ACT",
    observations: [],
    assistantText: null,
    exec: {
      substate: "dispatch",
      pendingEffectKey: undefined,
      pendingApproval: {
        approvalId: "approval-1",
      },
    },
  });
});

test("createReferenceReactWaitCheckpoint records processor-owned user waits and region patch", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: { prompt: "Switch mode to continue." },
  };
  const transition = createReferenceReactWaitCheckpoint({
    reactState: { goal: "finish task" },
    currentStepAgent: "agent.exec.dispatch",
    nextStepAgent: "agent.exec.dispatch",
    stepIndex: 9,
    waitFor,
    substate: "wait_user",
    phase: "ACT",
    activeRegion: "region-1",
    reactPatch: {
      nextAction: {
        kind: "ask_user",
        prompt: "Switch mode to continue.",
        waitFor,
      },
    },
    execPatch: {},
    regionReactPatch: { lastActionResult: { kind: "ask_user" } },
    regionExecPatch: {},
    emitEvents: [{ type: "ui.prompt", payload: { text: "Switch mode to continue." } }],
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const regions = transition.statePatch?.regions as Record<string, unknown>;
  const region = regions["region-1"] as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.deepEqual(transition.waitFor, {
    ...waitFor,
    interaction: {
      version: "v1",
      kind: "user_input",
      eventType: "user.reply",
      prompt: "Switch mode to continue.",
    },
  });
  assert.equal(react.assistantText, "Switch mode to continue.");
  assert.equal((react.waitingFor as Record<string, unknown>)?.eventType, "user.reply");
  assert.equal(exec.substate, "wait_user");
  assert.equal(lastCheckpoint.substate, "wait_user");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 9);
  assert.equal(workingPlan.status, "waiting");
  assert.equal(workingPlan.expectedNextCommand, "agent.exec.dispatch");
  assert.equal(workingPlan.waitReason, "Switch mode to continue.");
  assert.equal(workingPlan.blocker, "Switch mode to continue.");
  assert.equal(workingPlan.lastUpdatedAtStepIndex, 9);
  assert.equal((region.exec as Record<string, unknown>).waitingForUser, undefined);
  assert.equal(transition.emitEvents?.[0]?.type, "ui.prompt");
});

test("createReferenceReactWaitCheckpoint does not create narration memory", () => {
  const transition = createReferenceReactWaitCheckpoint({
    memory: {
      working: {
        existing: true,
      },
      episodicRef: "episodic:existing",
      semanticRef: "semantic:existing",
    },
    reactState: { goal: "finish task" },
    currentStepAgent: "agent.exec.dispatch",
    nextStepAgent: "agent.exec.dispatch",
    stepIndex: 15,
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        prompt: "Approve fs.write_text?",
      },
    },
    substate: "wait_approval",
  });

  assert.equal(Object.hasOwn(transition.statePatch ?? {}, "memory"), false);
});

test("createReferenceReactWaitCheckpoint records processor-owned approval waits", () => {
  const waitFor = {
    kind: "approval" as const,
    eventType: "user.approval",
    metadata: {
      approvalId: "approval-1",
      prompt: "Approve fs.write_text?",
    },
  };
  const transition = createReferenceReactWaitCheckpoint({
    reactState: { goal: "edit file" },
    currentStepAgent: "agent.exec.dispatch",
    nextStepAgent: "agent.exec.dispatch",
    stepIndex: 10,
    waitFor,
    substate: "wait_approval",
    phase: "ACT",
    execPatch: {
      pendingApproval: {
        approvalId: "approval-1",
        toolName: "fs.write_text",
        toolClass: "sandboxed_only",
      },
    },
    emitEvents: [{ type: "ui.prompt", payload: { text: "Approve fs.write_text?" } }],
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.deepEqual(transition.waitFor, {
    ...waitFor,
    interaction: {
      version: "v1",
      kind: "approval",
      eventType: "user.approval",
      prompt: "Approve fs.write_text?",
    },
  });
  assert.equal(react.assistantText, "Approve fs.write_text?");
  assert.deepEqual(exec.pendingApproval, {
    approvalId: "approval-1",
    toolName: "fs.write_text",
    toolClass: "sandboxed_only",
  });
  assert.equal(exec.substate, "wait_approval");
  assert.equal(lastCheckpoint.substate, "wait_approval");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 10);
  assert.equal(workingPlan.currentChunk, "waiting for approval");
  assert.equal(workingPlan.status, "waiting");
});

test("createReferenceReactWaitCheckpoint records processor-owned effect waits", () => {
  const waitFor = {
    kind: "effect" as const,
    eventType: "effect.result.available",
    metadata: {
      idempotencyKey: "effect-1",
    },
  };
  const transition = createReferenceReactWaitCheckpoint({
    reactState: { phase: "ACT" },
    currentStepAgent: "agent.exec.wait_effect",
    nextStepAgent: "agent.exec.wait_effect",
    stepIndex: 11,
    waitFor,
    substate: "wait_effect",
    execPatch: {
      pendingEffectKey: "effect-1",
      pendingEffectType: "execute_tool_call",
    },
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.waitFor, waitFor);
  assert.equal(exec.pendingEffectKey, "effect-1");
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(exec.substate, "wait_effect");
  assert.equal(lastCheckpoint.substate, "wait_effect");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 11);
  assert.equal(workingPlan.currentChunk, "waiting for effect result");
  assert.equal(workingPlan.status, "waiting");
});

test("createReferenceReactEffectDispatchCheckpoint records processor-owned effect dispatch", () => {
  const transition = createReferenceReactEffectDispatchCheckpoint({
    reactState: { goal: "write file" },
    currentStepAgent: "agent.exec.dispatch",
    nextStepAgent: "agent.exec.dispatch",
    stepIndex: 12,
    phase: "ACT",
    execPatch: {
      pendingEffectKey: "effect-1",
      pendingEffectType: "execute_tool_call",
    },
    activeRegion: "region-1",
    regionExecPatch: {
      pendingEffectKey: "effect-1",
      pendingEffectType: "execute_tool_call",
    },
    effects: [
      {
        type: "execute_tool_call",
        payload: { toolName: "fs.write_text" },
        idempotencyKey: "effect-1",
        failurePolicy: "CONTINUE",
      },
    ],
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const regions = transition.statePatch?.regions as Record<string, unknown>;
  const region = regions["region-1"] as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.effects?.[0]?.type, "execute_tool_call");
  assert.equal(exec.pendingEffectKey, "effect-1");
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(lastCheckpoint.substate, "dispatch");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 12);
  assert.equal(workingPlan.currentChunk, "dispatching execution command");
  assert.equal(workingPlan.status, "dispatching");
  assert.equal((region.exec as Record<string, unknown>).pendingEffectKey, "effect-1");
});

test("createReferenceReactEffectCollectCheckpoint records processor-owned effect collection", () => {
  const transition = createReferenceReactEffectCollectCheckpoint({
    reactState: {
      exec: {
        pendingEffectKey: "effect-1",
        pendingEffectType: "custom_effect",
      },
    },
    currentStepAgent: "agent.exec.wait_effect",
    nextStepAgent: "agent.loop",
    stepIndex: 13,
    phase: "OBSERVE",
    reactPatch: {
      lastActionResult: {
        kind: "effect",
        type: "custom_effect",
        result: { ok: true },
      },
    },
    execPatch: {
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
    },
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(exec.pendingEffectKey, undefined);
  assert.equal(exec.pendingEffectType, undefined);
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 13);
  assert.equal(workingPlan.currentChunk, "collecting execution result");
  assert.equal(workingPlan.status, "collecting");
});

test("createReferenceReactFinalizeCheckpoint records processor-owned finalization", () => {
  const transition = createReferenceReactFinalizeCheckpoint({
    reactState: {
      exec: {
        pendingBatch: { items: [] },
      },
    },
    currentStepAgent: "agent.exec.finalize",
    stepIndex: 14,
    phase: "DONE",
    reactPatch: {
      finalOutput: { message: "done" },
      finalized: true,
    },
    execPatch: {
      pendingBatch: undefined,
    },
    emitEvents: [{ type: "agent.completed", payload: { output: { message: "done" } } }],
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "COMPLETED");
  assert.equal(transition.emitEvents?.[0]?.type, "agent.completed");
  assert.deepEqual(react.finalOutput, { message: "done" });
  assert.equal(react.finalized, true);
  assert.equal(exec.pendingBatch, undefined);
  assert.equal(lastCheckpoint.substate, "finalize");
  assert.equal(lastCheckpoint.updatedAtStepIndex, 14);
  assert.equal(workingPlan.currentChunk, "finalizing response");
  assert.equal(workingPlan.status, "finalizing");
});

test("exec dispatch consumes a ready command batch before executing the selected action", async () => {
  const action = {
    kind: "tool" as const,
    name: "fs.read_text",
    input: { path: "src/a.ts" },
  };
  const commandBatch = {
    ...buildReferenceReactCommandBatchFromAction({
      stepIndex: 2,
      toolExecutionClassByName: { "fs.read_text": "read_only" },
      action,
    }),
    status: "ready",
    sourceStepAgent: "agent.loop",
    targetStepAgent: "agent.exec.dispatch",
    createdAtStepIndex: 2,
  };
  const step = createExecDispatchStep({
    loopStepId: "agent.loop",
    effectResultLookupTool: "effect.lookup",
    finalizeToolName: "FinalizeAnswer",
    dispatchStepId: "agent.exec.dispatch",
    waitEffectStepId: "agent.exec.wait_effect",
    waitApprovalStepId: "agent.exec.wait_approval",
    waitUserStepId: "agent.exec.wait_user",
    collectStepId: "agent.exec.collect",
    finalizeStepId: "agent.exec.finalize",
    capabilityManifestProvider: () => [
      {
        name: "fs.read_text",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  });

  const transition = await step(
    {
      runId: "run-1",
      stepIndex: 3,
      session: {
        sessionId: "session-1",
        state: {
          agent: {
            nextAction: action,
            commandBatch,
          },
        },
      },
      event: { type: "user.message", payload: {} },
      memory: {},
    } as never,
    {
      useTool: async (name: string, input: unknown) => ({ ok: true, name, input }),
    } as never,
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const processedBatch = react.commandBatch as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(processedBatch.status, "processed");
  assert.equal(processorState.batchId, commandBatch.batchId);
  assert.equal(processorState.executionMode, "parallel_read_batch");
  assert.equal(Array.isArray(transition.emitEvents), true);
  assert.equal(transition.emitEvents?.some((event) => event.type === "decision.executed"), true);
});

test("exec collect routes completed batches through processor checkpoints", async () => {
  const step = createExecCollectStep({
    loopStepId: "agent.loop",
    effectResultLookupTool: "effect.lookup",
    finalizeToolName: "FinalizeAnswer",
    dispatchStepId: "agent.exec.dispatch",
    waitEffectStepId: "agent.exec.wait_effect",
    waitApprovalStepId: "agent.exec.wait_approval",
    waitUserStepId: "agent.exec.wait_user",
    collectStepId: "agent.exec.collect",
    finalizeStepId: "agent.exec.finalize",
    capabilityManifestProvider: () => [],
  });

  const transition = await step(
    {
      runId: "run-1",
      stepIndex: 7,
      session: {
        sessionId: "session-1",
        state: {
          agent: {
            phase: "ACT",
            exec: {
              pendingBatch: {
                items: [{ name: "fs.read_text", input: { path: "a.ts" } }],
                nextIndex: 1,
              },
            },
          },
        },
      },
      event: { type: "runtime.tick", payload: {} },
      memory: {},
    } as never,
    {} as never,
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const processorState = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = processorState.lastCheckpoint as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(react.phase, "LOOP");
  assert.equal(exec.pendingBatch, undefined);
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(lastCheckpoint.nextStepAgent, "agent.loop");
});
