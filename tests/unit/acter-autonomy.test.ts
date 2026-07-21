import assert from "node:assert/strict";

import type { StepContext, StepContractRegistry, StepIO, Transition } from "../../src/kestrel/contracts/execution.js";


import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import {
  createExecDispatchStep,
  createExecFinalizeStep,
  createExecWaitApprovalStep,
  createExecWaitUserStep,
  createExecWaitEffectStep,
} from "../../agents/reference-react/src/steps/execStates.js";
import { appendUserTurnToTranscript } from "../../src/runtime/modelTranscript.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import {
  createReferenceReactExecutionCheckpoint,
  ReferenceReactCommandProcessor,
} from "../../agents/reference-react/src/commandProcessor.js";
import { hashToolInput } from "../../agents/reference-react/src/memory/workingMemory.js";
import {
  createExecutionStepReducer,
} from "../../agents/reference-react/src/steps/acter.js";
import { handleAskUserAction } from "../../agents/reference-react/src/steps/acter/askUserHandler.js";
import { buildFilesystemInspectionActionKey } from "../../agents/reference-react/src/filesystemInspection.js";
import { detectReadOnlyResultDuplicate } from "../../src/runtime/readOnlyResultDuplicates.js";
import { readActiveWaitState } from "../../src/runtime/waitState.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { kestrelOneGitHubIssueCreateTool } from "../../tools/kestrelOne/githubActions.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { contractTest } from "../helpers/contract-test.js";

function buildExecConfig() {
  return {
    deliberationStepId: "agent.loop",
    loopStepId: "agent.loop",
    effectResultLookupTool: "effect_result_lookup",
    finalizeToolName: "FinalizeAnswer",
    capabilityManifestProvider: () => [
      {
        name: "free.weather.current",
        freshnessClass: "live" as const,
        capabilityClasses: ["weather.current"],
      },
    ],
    dispatchStepId: "agent.exec.dispatch",
    waitEffectStepId: "agent.exec.wait_effect",
    waitApprovalStepId: "agent.exec.wait_approval",
    waitUserStepId: "agent.exec.wait_user",
    collectStepId: "agent.exec.collect",
    finalizeStepId: "agent.exec.finalize",
  };
}

function buildContext(overrides: Partial<StepContext> = {}): StepContext {
  const context: StepContext = {
    runId: "run-1",
    session: {
      sessionId: "session-1",
      version: 1,
      state: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "free.weather.current",
            input: {
              city: "Seattle",
            },
          },
        },
      },
      currentStepAgent: "agent.exec.dispatch",
      updatedAt: new Date().toISOString(),
    },
    event: {
      id: "evt-1",
      type: "user.message",
      sessionId: "session-1",
      payload: {},
    },
    stepIndex: 2,
    memory: {
      working: {},
      episodicRef: "episodic:test",
      semanticRef: "semantic:test",
    },
    budget: {
      remainingMs: 10_000,
      tokensUsed: 0,
      toolCallsUsed: 0,
    },
    region: {
      pendingRegions: [],
    },
    ...overrides,
  };
  const payloadMode = context.event.payload.interactionMode;
  const agentState = context.session.state.agent as Record<string, unknown> | undefined;
  if (payloadMode === undefined && agentState?.interactionMode === undefined && agentState !== undefined) {
    agentState.interactionMode = "build";
  }
  return context;
}

function transcriptForTask(task: string) {
  return appendUserTurnToTranscript({
    transcript: { version: 1, windowId: 1, items: [] },
    message: task,
    stepIndex: 0,
  });
}

function approvedPlanState(sessionId = "session-1"): {
  plan: { path: string; status: "approved" };
  planDocument: { path: string; exists: true; content: string };
} {
  const path = `~/.kestrel/sessions/${sessionId}/PLAN.md`;
  return {
    plan: { path, status: "approved" },
    planDocument: {
      path,
      exists: true,
      content: "# Plan\n\nExecute the approved test plan.",
    },
  };
}

function stalePolicyRetryContext(): Record<string, unknown> {
  return {
    loopAttempt: 1,
    maxLoopAttempts: 4,
    failure: {
      code: "DECISION_POLICY_FAILED",
      message: "Previous action was rejected by compile policy.",
      details: {
        path: ".",
        reason: "workspace_root_mutation_noop_rejected",
        toolName: "fs.mkdir",
      },
      schemaCategory: "policy",
    },
  };
}

function assertReferenceWaitEffectContractAccepts(transition: Transition, context = buildContext()): void {
  const kestrel = new Kestrel({
    store: new InMemorySessionStore(),
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
  });
  registerAgentReferenceRuntime(kestrel);
  const registry = (kestrel as unknown as { stepContractRegistry: StepContractRegistry }).stepContractRegistry;
  assert.doesNotThrow(() =>
    registry.validate({
      stepName: "agent.exec.wait_effect",
      transition,
      context,
    }),
  );
}

function assertReferenceFinalizeContractAccepts(transition: Transition, context = buildContext()): void {
  const kestrel = new Kestrel({
    store: new InMemorySessionStore(),
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
  });
  registerAgentReferenceRuntime(kestrel);
  const registry = (kestrel as unknown as { stepContractRegistry: StepContractRegistry }).stepContractRegistry;
  assert.doesNotThrow(() =>
    registry.validate({
      stepName: "agent.exec.finalize",
      transition,
      context,
    }),
  );
}

function assertReferenceFinalizeContractRejects(transition: Transition, context = buildContext()): void {
  const kestrel = new Kestrel({
    store: new InMemorySessionStore(),
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({} as T)),
  });
  registerAgentReferenceRuntime(kestrel);
  const registry = (kestrel as unknown as { stepContractRegistry: StepContractRegistry }).stepContractRegistry;
  assert.throws(
    () =>
      registry.validate({
        stepName: "agent.exec.finalize",
        transition,
        context,
      }),
    /agent\.exec\.finalize WAITING transitions must be continuation handoff user waits/u,
  );
}

contractTest("runtime.hermetic", "exec.wait_effect clears stale retry feedback after successful durable write result evidence", async () => {
  const step = createExecWaitEffectStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "runtime" as const,
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        currentStepAgent: "agent.exec.wait_effect",
        updatedAt: new Date().toISOString(),
        state: {
          agent: {
            retryContext: stalePolicyRetryContext(),
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: {
                path: "src/app/page.tsx",
                content: "export default function Page() { return <main>Bookmarks</main>; }",
              },
            },
            exec: {
              pendingAction: {
                kind: "effect",
                actionId: "execute_tool_call",
                idempotencyKey: "effect-write-1",
              },
              pendingEffectKey: "effect-write-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "fs.write_text",
                input: {
                  path: "src/app/page.tsx",
                  content: "export default function Page() { return <main>Bookmarks</main>; }",
                },
                idempotencyKey: "effect-write-1",
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("model should not be called");
      },
      useTool: async <T>() => ({
        output: {
          path: "src/app/page.tsx",
          bytesWritten: 64,
        },
      }) as T,
    } as StepIO,
  );

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assert.equal(agent.retryContext, undefined);
});

contractTest("runtime.hermetic", "exec.wait_effect clears stale retry feedback after successful patch_text result evidence", async () => {
  const step = createExecWaitEffectStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.patch_text",
        freshnessClass: "runtime" as const,
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        currentStepAgent: "agent.exec.wait_effect",
        updatedAt: new Date().toISOString(),
        state: {
          agent: {
            retryContext: stalePolicyRetryContext(),
            nextAction: {
              kind: "tool",
              name: "fs.patch_text",
              input: {
                path: "src/app/page.tsx",
                patch: "@@\n-old\n+new\n",
              },
            },
            exec: {
              pendingAction: {
                kind: "effect",
                actionId: "execute_tool_call",
                idempotencyKey: "effect-patch-1",
              },
              pendingEffectKey: "effect-patch-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "fs.patch_text",
                input: {
                  path: "src/app/page.tsx",
                  patch: "@@\n-old\n+new\n",
                },
                idempotencyKey: "effect-patch-1",
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("model should not be called");
      },
      useTool: async <T>() => ({
        output: {
          path: "src/app/page.tsx",
          changed: true,
          status: "ok",
        },
      }) as T,
    } as StepIO,
  );

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assert.equal(agent.retryContext, undefined);
});

contractTest("runtime.hermetic", "exec.wait_effect clears stale retry feedback after failed durable write result evidence", async () => {
  const step = createExecWaitEffectStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "runtime" as const,
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        currentStepAgent: "agent.exec.wait_effect",
        updatedAt: new Date().toISOString(),
        state: {
          agent: {
            retryContext: stalePolicyRetryContext(),
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: {
                path: "src/app/page.tsx",
                content: "export default function Page() { return <main>Bookmarks</main>; }",
              },
            },
            exec: {
              pendingAction: {
                kind: "effect",
                actionId: "execute_tool_call",
                idempotencyKey: "effect-write-failed",
              },
              pendingEffectKey: "effect-write-failed",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "fs.write_text",
                input: {
                  path: "src/app/page.tsx",
                  content: "export default function Page() { return <main>Bookmarks</main>; }",
                },
                idempotencyKey: "effect-write-failed",
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("model should not be called");
      },
      useTool: async <T>() => ({
        output: {
          status: "FAILED",
          errorCode: "EIO",
          message: "write failed",
        },
      }) as T,
    } as StepIO,
  );

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assert.equal(agent.retryContext, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch escalates to approval when autonomy evidence is insufficient", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalled = false;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalled = true;
      throw new Error("tool should not be called");
    },
  };

  const transition = await step(
    buildContext({
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L1",
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.waitFor?.eventType, "user.approval");
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  assert.equal(exec.substate, "wait_approval");
  assert.equal(exec.pendingApproval !== undefined, true);
  assert.equal(lastCheckpoint.substate, "wait_approval");
  assert.equal(workingPlan.status, "waiting");
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "exec.dispatch does not use stale agent goal as autonomy evidence when transcript lacks a task", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalled = false;
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            goal: "Stale legacy task",
            modelTranscript: {
              version: 1,
              windowId: 1,
              items: [
                {
                  id: "mt_1_0001_assistant_text",
                  createdAt: "2026-07-06T12:00:00.000Z",
                  kind: "assistant_text",
                  content: "No user task survived.",
                },
              ],
            },
            ...approvedPlanState(),
            nextAction: {
              kind: "tool",
              name: "free.weather.current",
              input: {
                city: "Seattle",
              },
            },
          },
        },
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => {
        toolCalled = true;
        throw new Error("tool should not be called");
      },
    } satisfies StepIO,
  );

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.waitFor?.eventType, "user.approval");
  assert.deepEqual(transition.waitFor?.metadata?.missingEvidence, ["goal"]);
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "exec.dispatch returns stale missing nextAction state to loop feedback", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalled = false;

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            commandBatch: {
              batchId: "stale-batch",
              status: "ready",
              commands: [
                {
                  commandId: "stale-batch-0",
                  kind: "tool",
                  commandClass: "read",
                  name: "free.weather.current",
                  input: {
                    city: "Seattle",
                  },
                },
              ],
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => {
        toolCalled = true;
        throw new Error("tool should not be called");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  const retryContext = react.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(react.nextAction, undefined);
  assert.equal(react.commandBatch, undefined);
  assert.equal(react.phase, "LOOP");
  assert.equal(exec.substate, "dispatch");
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_PARSE_FAILED");
  assert.equal((failure.details as Record<string, unknown>).reason, "missing_compiled_next_action");
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "exec.dispatch returns unsupported nextAction kind to loop feedback", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalled = false;

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "unsupported_action",
              input: {},
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => {
        toolCalled = true;
        throw new Error("tool should not be called");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  const failure = lastActionResult.error as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(react.nextAction, undefined);
  assert.equal(react.commandBatch, undefined);
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(details.reason, "unsupported_compiled_next_action_kind");
  assert.equal(details.receivedKind, "unsupported_action");
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "direct Acter execution rejects malformed compiled nextAction", async () => {
  const step = createExecutionStepReducer({
    ...buildExecConfig(),
    acterStepId: "agent.exec.dispatch",
  });

  await assert.rejects(
    () => step(
      buildContext({
        session: {
          ...buildContext().session,
          state: {
            agent: {
              nextAction: {
                kind: "tool",
                name: "free.weather.current",
              },
            },
          },
        },
      }),
      {
        useModel: async () => {
          throw new Error("not expected");
        },
        useTool: async () => {
          throw new Error("tool should not be called");
        },
      },
    ),
    (error: unknown) => {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
      assert.equal(failure.details?.statePath, "state.agent.nextAction.input");
      assert.equal(failure.details?.reason, "invalid_compiled_next_action");
      return true;
    },
  );
});

contractTest("runtime.hermetic", "direct Acter execution reuses cached filesystem inspection evidence", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.list",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only" as const,
      },
    ],
  });
  const cachedOutput = {
    path: ".",
    entries: [{ path: "package.json", type: "file" }],
    entryCount: 1,
    empty: false,
  };
  let toolCalls = 0;
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.list",
              input: {
                path: ".",
              },
            },
            filesystemInspectionCache: [
              {
                key: buildFilesystemInspectionActionKey("fs.list", { path: "." }),
                toolName: "fs.list",
                input: { path: "." },
                output: cachedOutput,
                stepIndex: 1,
                updatedAt: "2026-05-27T00:00:00.000Z",
              },
            ],
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        toolCalls += 1;
        throw new Error("cached fs.list should not execute");
      },
    },
  );

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const latestEvidence = evidenceLedger.at(-1) as Record<string, unknown>;

  assert.equal(Object.hasOwn(agent, "evidenceLedger"), false);
  assert.equal(toolCalls, 0);
  assert.equal(transition.status, "RUNNING");
  assert.equal(lastActionResult.status, "cached");
  assert.equal(lastActionResult.reused, true);
  assert.equal((latestEvidence.facts as Record<string, unknown>).reused, true);
});

contractTest("runtime.hermetic", "direct Acter execution clears filesystem inspection cache before filesystem mutation", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: {
                path: "app/page.tsx",
                content: "export default function Page() { return null; }",
              },
            },
            filesystemInspectionCache: [
              {
                key: buildFilesystemInspectionActionKey("fs.list", { path: "." }),
                toolName: "fs.list",
                input: { path: "." },
                output: { path: ".", entries: [] },
                stepIndex: 1,
                updatedAt: "2026-05-27T00:00:00.000Z",
              },
            ],
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable fs.write_text dispatch should not execute inline");
      },
    },
  );

  const agent = transition.statePatch?.agent as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.deepEqual(agent.filesystemInspectionCache, []);
});

contractTest("runtime.hermetic", "exec.wait_approval records processor-owned approval denials", async () => {
  const config = {
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "dev.shell.run",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  };
  const dispatchStep = createExecDispatchStep(config);
  const waitApprovalStep = createExecWaitApprovalStep(config);

  const approvalWait = await dispatchStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                command: "pnpm test",
              },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          modeSystemV2Enabled: true,
          interactionMode: "build",
          actSubmode: "strict",
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("tool should not run before approval");
      },
    },
  );
  const approvalReact = approvalWait.statePatch?.agent as Record<string, unknown>;

  const denial = await waitApprovalStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: approvalReact,
        },
        currentStepAgent: "agent.exec.wait_approval",
      },
      event: {
        id: "evt-approval-deny",
        type: "user.approval",
        sessionId: "session-1",
        payload: {
          modeSystemV2Enabled: true,
          interactionMode: "build",
          actSubmode: "strict",
          message: "deny",
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("tool should not run after denial");
      },
    },
  );

  const react = denial.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;

  assert.equal(denial.status, "RUNNING");
  assert.equal(denial.nextStepAgent, "agent.exec.dispatch");
  assert.equal(lastActionResult, undefined);
  assert.equal(exec.pendingApproval, undefined);
  assert.equal(lastCheckpoint.substate, "dispatch");
  assert.equal(lastCheckpoint.currentStepAgent, "agent.exec.wait_approval");
  assert.equal(workingPlan.status, "dispatching");
});

contractTest("runtime.hermetic", "GitHub external confirmation resumes only the exact approved mutation", async () => {
  const definition = kestrelOneGitHubIssueCreateTool.definition;
  const toolInput = {
    repository: "acme/support",
    title: "Escalate the customer incident",
    body: "Created by the Kestrel agent after explicit approval.",
  };
  const config = {
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: definition.name,
        freshnessClass: definition.capability.freshnessClass,
        capabilityClasses: [...definition.capability.capabilityClasses],
        approvalCapabilities: [
          ...(definition.capability.approvalCapabilities ?? []),
        ],
        executionClass: definition.capability.executionClass,
      },
    ],
  };
  const dispatchStep = createExecDispatchStep(config);
  const waitApprovalStep = createExecWaitApprovalStep(config);
  const modePayload = {
    modeSystemV2Enabled: true,
    interactionMode: "build",
    actSubmode: "full_auto",
  };
  let inlineToolCalls = 0;

  const approvalWait = await dispatchStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: definition.name,
              input: toolInput,
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: modePayload,
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        inlineToolCalls += 1;
        throw new Error("GitHub mutation must not run before approval");
      },
    }
  );

  assert.equal(approvalWait.status, "WAITING");
  assert.equal(approvalWait.waitFor?.eventType, "user.approval");
  assert.equal(approvalWait.waitFor?.metadata?.toolName, definition.name);
  assert.deepEqual(approvalWait.waitFor?.metadata?.toolInput, toolInput);
  assert.equal(inlineToolCalls, 0);
  const waitingAgent = approvalWait.statePatch?.agent as Record<
    string,
    unknown
  >;
  const waitingExec = waitingAgent.exec as Record<string, unknown>;
  const pendingApproval = waitingExec.pendingApproval as Record<
    string,
    unknown
  >;
  assert.equal(pendingApproval.toolName, definition.name);
  assert.equal(
    pendingApproval.approvalId,
    approvalWait.waitFor?.metadata?.approvalId
  );

  const resumed = await waitApprovalStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: { agent: waitingAgent },
        currentStepAgent: "agent.exec.wait_approval",
      },
      event: {
        id: "evt-github-approval",
        type: "user.approval",
        sessionId: "session-1",
        payload: {
          ...modePayload,
          message: "approve",
          approvalId: pendingApproval.approvalId,
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        inlineToolCalls += 1;
        throw new Error("durable GitHub mutation must not run inline");
      },
    }
  );

  assert.equal(resumed.status, "RUNNING");
  assert.equal(resumed.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(resumed.effects?.length, 1);
  assert.equal(resumed.effects?.[0]?.type, "execute_tool_call");
  assert.deepEqual(resumed.effects?.[0]?.payload, {
    toolName: definition.name,
    toolInput,
  });
  const resumedAgent = resumed.statePatch?.agent as Record<string, unknown>;
  const resumedExec = resumedAgent.exec as Record<string, unknown>;
  assert.equal(resumedExec.pendingApproval, undefined);
  assert.deepEqual(resumedExec.pendingToolCall, {
    name: definition.name,
    input: toolInput,
    idempotencyKey: resumed.effects?.[0]?.idempotencyKey,
  });
  assert.equal(inlineToolCalls, 0);
});

contractTest("runtime.hermetic", "exec.wait_effect records processor-owned effect waits when result is unavailable", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string): Promise<T> => {
      assert.equal(name, "effect_result_lookup");
      return null as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
            },
          },
        },
        currentStepAgent: "agent.exec.wait_effect",
        updatedAt: new Date().toISOString(),
      },
    }),
    io,
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.waitFor?.eventType, "effect.result.available");
  assert.equal(exec.pendingEffectKey, "effect-1");
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(exec.substate, "wait_effect");
  assert.equal(lastCheckpoint.substate, "wait_effect");
  assert.equal(workingPlan.status, "waiting");
});

contractTest("runtime.hermetic", "exec.wait_effect records processor-owned non-tool effect collection", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string): Promise<T> => {
      assert.equal(name, "effect_result_lookup");
      return { output: { ok: true } } as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "custom_effect",
            },
          },
        },
        currentStepAgent: "agent.exec.wait_effect",
        updatedAt: new Date().toISOString(),
      },
    }),
    io,
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assertReferenceWaitEffectContractAccepts(transition);
  assert.equal(lastActionResult.kind, "effect");
  assert.equal(lastActionResult.type, "custom_effect");
  assert.deepEqual(lastActionResult.result, { ok: true });
  assert.equal(exec.pendingEffectKey, undefined);
  assert.equal(exec.pendingEffectType, undefined);
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "exec.wait_effect routes completed filesystem writes through collect before loop", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const context = buildContext({
    session: {
      sessionId: "session-1",
      version: 1,
      state: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "fs.write_text",
            input: {
              path: "/app/news-japan.html",
              content: "<!doctype html>",
            },
          },
          exec: {
            pendingEffectKey: "effect-write-1",
            pendingEffectType: "execute_tool_call",
            pendingToolCall: {
              name: "fs.write_text",
              input: {
                path: "/app/news-japan.html",
                content: "<!doctype html>",
              },
            },
          },
        },
      },
      currentStepAgent: "agent.exec.wait_effect",
      updatedAt: new Date().toISOString(),
    },
  });

  const transition = await step(
    context,
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(name: string, input?: unknown): Promise<T> => {
        assert.equal(name, "effect_result_lookup");
        assert.deepEqual(input, { idempotencyKey: "effect-write-1" });
        return {
          output: {
            mode: "overwrite",
            path: "news-japan.html",
            bytesWritten: 4928,
          },
        } as T;
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assertReferenceWaitEffectContractAccepts(transition, context);
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  assert.equal(exec.pendingEffectKey, undefined);
  assert.equal(exec.pendingEffectType, undefined);
  assert.equal(exec.pendingToolCall, undefined);
  assert.equal(exec.substate, "collect");
  assert.equal(lastActionResult.kind, "tool");
  assert.equal(lastActionResult.name, "fs.write_text");
});

contractTest("runtime.hermetic", "exec.wait_effect settles completed dev.shell.run results before loop", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const context = buildContext({
    session: {
      sessionId: "session-1",
      version: 1,
      state: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "dev.shell.run",
            input: {
              command: "python fib_1000.py > fib.txt && wc -l fib.txt",
              workspaceRoot: "/tmp/kestrel-worktree",
            },
          },
          exec: {
            pendingEffectKey: "effect-shell-1",
            pendingEffectType: "execute_tool_call",
            pendingToolCall: {
              name: "dev.shell.run",
              input: {
                command: "python fib_1000.py > fib.txt && wc -l fib.txt",
                workspaceRoot: "/tmp/kestrel-worktree",
              },
            },
          },
        },
      },
      currentStepAgent: "agent.exec.wait_effect",
      updatedAt: new Date().toISOString(),
    },
  });

  const transition = await step(
    context,
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(name: string, input?: unknown): Promise<T> => {
        assert.equal(name, "effect_result_lookup");
        assert.deepEqual(input, { idempotencyKey: "effect-shell-1" });
        return {
          output: {
            status: "COMPLETED",
            exitCode: 0,
            text: "1000 fib.txt\n",
          },
        } as T;
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  assertReferenceWaitEffectContractAccepts(transition, context);
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const devShell = exec.devShell as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  const modelTranscript = react.modelTranscript as Record<string, unknown>;
  const transcriptItems = modelTranscript.items as Array<Record<string, unknown>>;
  const transcriptResult = [...transcriptItems].reverse().find((item) => item.kind === "tool_result");
  const transcriptOutput = transcriptResult?.toolOutput as Record<string, unknown>;
  assert.equal(exec.pendingEffectKey, undefined);
  assert.equal(exec.pendingEffectType, undefined);
  assert.equal(exec.pendingToolCall, undefined);
  assert.equal(exec.substate, "collect");
  assert.equal(lastActionResult.kind, "tool");
  assert.equal(lastActionResult.name, "dev.shell.run");
  assert.equal(devShell.status, "COMPLETED");
  assert.equal(transcriptResult?.toolName, "dev.shell.run");
  assert.match(String(transcriptOutput?.text), /Tool result: dev\.shell\.run/u);
  assert.match(String(transcriptOutput?.text), /1000 fib\.txt/u);
  assert.doesNotMatch(String(transcriptOutput?.text), /Tool result: effect_result_lookup/u);
});

contractTest("runtime.hermetic", "exec.wait_user resumes blocked mode-switch requests with transcript goal and effective interaction mode", async () => {
  const step = createExecWaitUserStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("not expected");
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Stale legacy task",
            modelTranscript: {
              version: 1,
              windowId: 1,
              items: [
                {
                  id: "mt_1_0001_user",
                  createdAt: "2026-07-06T12:00:00.000Z",
                  kind: "user",
                  content: "Build Chirp, a text-only microblogging app.",
                },
              ],
            },
            interactionMode: "plan",
            actSubmode: "safe",
            nextAction: {
              kind: "ask_user",
              prompt: "Switch to Build: Guarded and continue.",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  prompt: "Switch to Build: Guarded and continue.",
                  reason: "route_mode_blocked",
                  requiredToolClass: "sandboxed_only",
                },
              },
            },
            waitingFor: {
              kind: "user",
              eventType: "user.reply",
              reason: "route_mode_blocked",
              resumeInstruction: "Switch to Build and continue.",
              resumeStepAgent: "agent.exec.wait_user",
              metadata: {
                prompt: "Switch to Build: Guarded and continue.",
                reason: "route_mode_blocked",
                requiredToolClass: "sandboxed_only",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.wait_user",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.reply",
        sessionId: "session-1",
        payload: {
          message: "continue",
          interactionMode: "build",
          actSubmode: "safe",
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  assert.equal(lastActionResult.kind, "user_reply");
  assert.equal(lastActionResult.resumeGoal, "Build Chirp, a text-only microblogging app.");
  assert.equal(react.waitingFor, undefined);
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(lastCheckpoint.currentStepAgent, "agent.exec.wait_user");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "ask_user resume does not carry stale agent goal when transcript lacks a task", () => {
  const transition = handleAskUserAction({
    action: {
      kind: "ask_user",
      prompt: "Continue?",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
      },
    },
    config: {
      ...buildExecConfig(),
      acterStepId: "agent.exec.dispatch",
      deliberationStepId: "agent.loop",
      loopStepId: "agent.loop",
    },
    reactState: {
      goal: "Stale legacy task",
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_assistant_text",
            createdAt: "2026-07-06T12:00:00.000Z",
            kind: "assistant_text",
            content: "No user task survived.",
          },
        ],
      },
      waitingFor: {
        kind: "user",
        eventType: "user.reply",
      },
    },
    activeRegion: undefined,
    currentStepAgent: "agent.exec.dispatch",
    interactionMode: "build",
    stepIndex: 3,
    eventType: "user.reply",
    eventPayload: {
      message: "continue",
    },
    resolveDeliberationStep: () => "agent.loop",
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(lastActionResult.kind, "user_reply");
  assert.equal(lastActionResult.resumeGoal, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch records processor-owned ask_user waits", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            nextAction: {
              kind: "ask_user",
              prompt: "Which file should I inspect?",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  prompt: "Which file should I inspect?",
                },
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("not expected");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_user");
  assert.equal(transition.waitFor?.eventType, "user.reply");
  assert.equal(exec.substate, "wait_user");
  assert.equal(exec.waitingForUser, undefined);
  assert.equal(lastCheckpoint.substate, "wait_user");
  assert.equal(workingPlan.status, "waiting");
});

contractTest("runtime.hermetic", "exec.finalize converts handoff_to_build into a user reply wait", async () => {
  const step = createExecFinalizeStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Create a Python Pong game.",
            modelTranscript: transcriptForTask("Create a Python Pong game."),
            interactionMode: "plan",
            nextAction: {
              kind: "handoff_to_build",
              message: "I can build this next by creating a Python file and checking pygame.",
              continuation: {
                version: "continuation_offer_v1",
                kind: "implementation",
                objective: "Create a Python Pong game.",
                requiredToolClass: "sandboxed_only",
                requiredCapabilities: ["workspace.write"],
                requiredMode: "build",
                sourceRunId: "run-1",
              },
              data: {
                proposedNextAction: "Create the Pong game files.",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.finalize",
        updatedAt: new Date().toISOString(),
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("not expected");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const nextAction = react.nextAction as Record<string, unknown>;
  const metadata = transition.waitFor?.metadata as Record<string, unknown>;
  const activeWait = readActiveWaitState(react);
  const handoff = metadata.handoff as Record<string, unknown>;

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_user");
  assert.equal(transition.waitFor?.eventType, "user.reply");
  assert.equal(metadata.reason, "continuation_handoff");
  assert.equal(metadata.continuationId, "continuation:run-1");
  assert.equal(handoff.goal, "Create a Python Pong game.");
  assert.equal(handoff.proposedNextMode, "build");
  assert.equal(metadata.proposedNextAction, "Create the Pong game files.");
  assert.equal(handoff.proposedApproach, "I can build this next by creating a Python file and checking pygame.");
  assert.equal(handoff.readiness, "ready_to_build");
  assert.equal(metadata.resumeStepAgent, "agent.exec.wait_user");
  assert.equal(activeWait?.source, "waitingFor");
  assert.equal(activeWait?.eventType, "user.reply");
  assert.equal(activeWait?.resumeStepAgent, "agent.exec.wait_user");
  assert.equal(((activeWait?.metadata as Record<string, unknown> | undefined)?.handoff as Record<string, unknown> | undefined)?.goal, "Create a Python Pong game.");
  assert.equal(nextAction.kind, "ask_user");
  assert.equal(
    nextAction.prompt,
    [
      "I can build this next by creating a Python file and checking pygame.",
      "",
      "Would you like me to proceed with the next pass now?",
      "Reply naturally when you want me to start building.",
    ].join("\n"),
  );
  assert.equal((react.exec as Record<string, unknown>).substate, "wait_user");
  assertReferenceFinalizeContractAccepts(transition);
  assertReferenceFinalizeContractRejects({
    ...transition,
    waitFor: {
      ...transition.waitFor!,
      kind: "approval",
    },
  });
});

contractTest("runtime.hermetic", "exec.finalize commits switch_mode as a terminal mode-switch payload", async () => {
  const step = createExecFinalizeStep(buildExecConfig());
  let finalizedInput: unknown;
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-mode-switch",
        version: 1,
        state: {
          agent: {
            interactionMode: "chat",
            nextAction: {
              kind: "switch_mode",
              mode: "build",
              message: "Switched to Build mode.",
            },
          },
        },
        currentStepAgent: "agent.exec.finalize",
        updatedAt: new Date().toISOString(),
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async (name, input) => {
        assert.equal(name, "FinalizeAnswer");
        finalizedInput = input;
        return buildAgentToolSuccessResult({
          toolName: name,
          input,
          output: { finalized: true, payload: input },
        });
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const finalOutput = react.finalOutput as Record<string, unknown>;
  assert.equal(transition.status, "COMPLETED");
  assert.deepEqual(finalizedInput, {
    message: "Switched to Build mode.",
    data: { modeSwitch: { mode: "build" } },
  });
  assert.deepEqual(finalOutput, {
    finalized: true,
    payload: finalizedInput,
  });
  assert.equal(react.assistantText, "Switched to Build mode.");
});

contractTest("runtime.hermetic", "exec.wait_user clears stale waitingFor when action is no longer ask_user", async () => {
  const step = createExecWaitUserStep(buildExecConfig());
  let toolCalled = false;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalled = true;
      throw new Error("not expected");
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "free.weather.current",
              input: {
                city: "Seattle",
              },
            },
            waitingFor: {
              kind: "user",
              eventType: "user.reply",
              reason: "Please confirm before continuing.",
              resumeInstruction: "Please confirm before continuing.",
              metadata: {
                prompt: "Please confirm before continuing.",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.wait_user",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-2",
        type: "user.reply",
        sessionId: "session-1",
        payload: {
          message: "continue",
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal((transition.statePatch?.agent as Record<string, unknown>)?.exec !== undefined, true);
  assert.equal(((transition.statePatch?.agent as Record<string, unknown>)?.waitingFor), undefined);
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "exec.wait_user consumes plan handoff user reply without carrying stale wait state", async () => {
  const step = createExecWaitUserStep(buildExecConfig());
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      reason: "continuation_handoff",
      prompt: "Proceed with the implementation pass?",
    },
  };
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("not expected");
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            waitingFor: {
              kind: "user",
              eventType: "user.reply",
              reason: "continuation_handoff",
              resumeInstruction: "Resume after the user confirms the continuation handoff.",
              resumeStepAgent: "agent.exec.wait_user",
              metadata: waitFor.metadata,
            },
            nextAction: {
              kind: "ask_user",
              prompt: "Proceed with the implementation pass?",
              waitFor,
            },
          },
        },
        currentStepAgent: "agent.exec.wait_user",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-plan-handoff-reply",
        type: "user.reply",
        sessionId: "session-1",
        payload: {
          message: "continue",
        },
      },
    }),
    io,
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(react.waitingFor, undefined);
  assert.equal(react.nextAction, undefined);
  assert.equal(readActiveWaitState(react), undefined);
});

contractTest("runtime.hermetic", "reference react execution checkpoint clears stale exec user waits", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      reason: "stale_wait",
    },
  };

  const transition = createReferenceReactExecutionCheckpoint({
    snapshot: {
      runId: "run-1",
      sessionId: "session-1",
      stepIndex: 1,
      currentStepAgent: "agent.exec.wait_user",
      nextStepAgent: "agent.exec.dispatch",
      reactState: {
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "stale_wait",
          resumeInstruction: "Resume stale wait.",
          resumeStepAgent: "agent.exec.wait_user",
          metadata: waitFor.metadata,
        },
      },
    },
    nextStepAgent: "agent.exec.dispatch",
    substate: "dispatch",
  });

  const react = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(readActiveWaitState(react), undefined);
  assert.equal(react.waitingFor, undefined);
});

contractTest("runtime.hermetic", "reference react non-wait command batches clear stale ask-user wait actions", () => {
  const waitFor = {
    kind: "user" as const,
    eventType: "user.reply",
    metadata: {
      reason: "stale_wait",
    },
  };
  const processor = new ReferenceReactCommandProcessor();

  const result = processor.process(
    {
      runId: "run-1",
      sessionId: "session-1",
      stepIndex: 1,
      currentStepAgent: "agent.exec.dispatch",
      nextStepAgent: "agent.exec.dispatch",
      reactState: {
        nextAction: {
          kind: "ask_user",
          prompt: "Old prompt?",
          waitFor,
        },
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "stale_wait",
          resumeInstruction: "Resume stale wait.",
          resumeStepAgent: "agent.exec.wait_user",
          metadata: waitFor.metadata,
        },
        exec: {
          waitingForUser: waitFor,
        },
      },
    },
    {
      batchId: "batch-1",
      commands: [
        {
          commandId: "command-1",
          kind: "tool",
          commandClass: "read",
          name: "free.time.current",
          input: {},
        },
      ],
    },
  );

  const react = result.transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(result.transition.status, "RUNNING");
  assert.equal(readActiveWaitState(react), undefined);
  assert.equal(react.nextAction, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch emits blocked acter waits with prompt metadata", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "dev.shell.run",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("not expected");
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            modeSystemV2Enabled: true,
            goal: "Run a development shell command",
            modelTranscript: transcriptForTask("Run a development shell command"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: ".",
                command: "pnpm test",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
          interactionMode: "plan",
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.waitFor?.eventType, "user.reply");
  const metadata = (transition.waitFor?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.reason, "acter_mode_blocked");
  assert.equal(metadata.requiredToolClass, "external_side_effect");
  assert.equal(metadata.toolName, "dev.shell.run");
  assert.match(String(metadata.prompt ?? ""), /resume automatically/u);
  assert.doesNotMatch(String(metadata.prompt ?? ""), /\bcontinue\b/u);
});

contractTest("runtime.hermetic", "exec.dispatch reports capability-blocked tools with explicit policy metadata", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "task.propose",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["runtime.project.task_queue"],
        approvalCapabilities: ["project.task_queue.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("not expected");
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            modeSystemV2Enabled: true,
            goal: "Propose a Mission Control task",
            modelTranscript: transcriptForTask("Propose a Mission Control task"),
            nextAction: {
              kind: "tool",
              name: "task.propose",
              input: {
                sessionId: "session-1",
                title: "Scaffold work",
                instructions: "Create the scaffold.",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          interactionMode: "build",
          modeSystemV2Enabled: true,
          executionPolicy: {
            toolClassPolicy: {
              external_side_effect: true,
            },
            capabilityPolicy: {
              "shell.exec": true,
              "project.task_queue.write": false,
            },
          },
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "WAITING");
  assert.equal(transition.waitFor?.eventType, "user.reply");
  const metadata = (transition.waitFor?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.reasonCode, "capability_policy_blocked");
  assert.equal(metadata.blockedCapability, "project.task_queue.write");
  assert.equal(metadata.toolName, "task.propose");
  assert.match(String(metadata.prompt ?? ""), /blocks capability 'project\.task_queue\.write'/u);
});

contractTest("runtime.hermetic", "exec.dispatch reuses cached tool outcomes instead of repeating the same call", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalls = 0;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalls += 1;
      throw new Error("tool should have been deduped");
    },
  };

  const input = { city: "Seattle" };
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Get current weather",
            modelTranscript: transcriptForTask("Get current weather"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "free.weather.current",
              input,
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
      memory: {
        working: {
          toolOutcomeCache: [
            {
              toolName: "free.weather.current",
              inputHash: hashToolInput("free.weather.current", input),
              status: "success",
              summary: "Cached Seattle weather",
              stepIndex: 1,
              reusable: true,
              capabilityClasses: ["weather.current"],
              output: {
                status: "ok",
                summary: "Cached Seattle weather",
              },
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const traces = (react.decisionTrace ?? []) as Array<Record<string, unknown>>;
  assert.equal(traces.some((trace) => trace.eventType === "decision.deduped"), true);
  assert.deepEqual(react.latestEvidenceDelta, {
    kind: "duplicate_cached_result",
    toolName: "free.weather.current",
    cachedStepIndex: 1,
  });
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  assert.equal(postToolVerification.resultQuality, "ok");
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
  assert.equal(toolCalls, 0);
});

contractTest("runtime.hermetic", "exec.dispatch does not infer dev.process.read processId from active process state", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "dev.process.read",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  let capturedInput: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(_name: string, input: unknown): Promise<T> => {
      capturedInput = input as Record<string, unknown>;
      return {
        status: "RUNNING",
        processId: "proc-123",
        chunk: "ready",
        truncated: false,
      } as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.process.read",
              input: {},
            },
            exec: {
              devShell: {
                status: "RUNNING",
                activeProcessId: "proc-123",
              },
            },
          },
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(capturedInput, undefined);
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const pendingToolCall = (exec.pendingToolCall ?? {}) as Record<string, unknown>;
  const pendingInput = (pendingToolCall.input ?? {}) as Record<string, unknown>;
  assert.equal(pendingInput.processId, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch does not infer dev.process.write processId from active process state", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "dev.process.write",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  let capturedInput: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(_name: string, input: unknown): Promise<T> => {
      capturedInput = input as Record<string, unknown>;
      return {
        status: "RUNNING",
        processId: "proc-123",
        chunk: "next",
        truncated: false,
      } as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.process.write",
              input: {
                data: "move N\nmove E\n",
              },
            },
            exec: {
              devShell: {
                status: "RUNNING",
                activeProcessId: "proc-123",
              },
            },
          },
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(capturedInput, undefined);
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const pendingToolCall = (exec.pendingToolCall ?? {}) as Record<string, unknown>;
  const pendingInput = (pendingToolCall.input ?? {}) as Record<string, unknown>;
  assert.equal(pendingInput.processId, undefined);
  assert.equal(pendingInput.data, "move N\nmove E\n");
});

contractTest("runtime.hermetic", "exec.wait_effect records running dev.shell process state", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: ".",
                command: "./interactive.sh",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.shell.run",
                input: {
                  workspaceRoot: ".",
                  command: "./interactive.sh",
                },
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            workspaceRoot: ".",
            command: "./interactive.sh",
          },
          output: {
            status: "RUNNING",
            processId: "proc-live",
            chunk: "ready\n",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "RUNNING",
            processId: "proc-live",
            chunk: "ready\n",
            truncated: false,
          },
        } as T),
    },
  );

  assert.equal(transition.status, "RUNNING");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const devShell = (postToolVerification.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShell.processId, "proc-live");
  assert.equal(devShell.activeProcessId, "proc-live");
  assert.equal(devShell.activeProcessPresent, true);
  assert.equal(devShell.status, "RUNNING");
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.activeProcessId, "proc-live");
  assert.deepEqual(devShellState.liveProcessIds, ["proc-live"]);
});

contractTest("runtime.hermetic", "exec.wait_effect records dev.process.write input and keeps process live", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.process.write",
              input: {
                processId: "proc-live",
                input: "move N\nmove E\n",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.process.write",
                input: {
                  processId: "proc-live",
                  input: "move N\nmove E\n",
                },
              },
              devShell: {
                status: "RUNNING",
                activeProcessId: "proc-live",
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.process.write",
          toolInput: {
            processId: "proc-live",
            input: "move N\nmove E\n",
          },
          output: {
            status: "RUNNING",
            processId: "proc-live",
            chunk: "ok\n",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "RUNNING",
            processId: "proc-live",
            chunk: "ok\n",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.activeProcessId, "proc-live");
  assert.deepEqual(devShellState.lastProcessInput, {
    processId: "proc-live",
    chars: "move N\nmove E\n",
  });
  const processes = devShellState.processes as Record<string, Record<string, unknown>>;
  assert.equal(processes["proc-live"]?.lastStdinPreview, "move N\nmove E\n");
  assert.equal(typeof processes["proc-live"]?.lastStdinAt, "string");
});

contractTest("runtime.hermetic", "exec.wait_effect records settled dev.shell process completion", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.process.read",
              input: {
                processId: "proc-live",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.process.read",
                input: {
                  processId: "proc-live",
                },
              },
              devShell: {
                status: "RUNNING",
                activeProcessId: "proc-live",
                liveProcessIds: ["proc-live"],
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.process.read",
          toolInput: {
            processId: "proc-live",
          },
          output: {
            status: "COMPLETED",
            processId: "proc-live",
            exitCode: 0,
            chunk: "done\n",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "COMPLETED",
            processId: "proc-live",
            exitCode: 0,
            chunk: "done\n",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const devShell = (postToolVerification.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShell.activeProcessPresent, false);
  assert.equal(devShell.processId, "proc-live");
  assert.equal(devShell.completedExitCode, 0);
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.activeProcessId, undefined);
  assert.deepEqual(devShellState.liveProcessIds, []);
  assert.equal(devShellState.lastCompletedExitCode, 0);
});

contractTest("runtime.hermetic", "exec.wait_effect preserves live process state when a helper exec completes without processId", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: ".",
                command: "echo helper",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.shell.run",
                input: {
                  workspaceRoot: ".",
                  command: "echo helper",
                },
              },
              devShell: {
                status: "RUNNING",
                activeProcessId: "proc-interactive",
                liveProcessIds: ["proc-interactive"],
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            workspaceRoot: ".",
            command: "echo helper",
          },
          output: {
            status: "COMPLETED",
            exitCode: 0,
            chunk: "helper\n",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "COMPLETED",
            exitCode: 0,
            chunk: "helper\n",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.activeProcessId, "proc-interactive");
  assert.deepEqual(devShellState.liveProcessIds, ["proc-interactive"]);
  assert.equal(devShellState.lastCompletedExitCode, 0);
});

contractTest("runtime.hermetic", "exec.wait_effect records helper tactic failure as ledger evidence", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Collect source truth with helper/controller tactics.",
              sourceTruthGoal: { target: "helper/controller observations", requirements: [{ id: "source_truth_1", expectation: "helper/controller observations", evidenceNeeded: "helper/controller observations", sufficiencyChecks: [{ id: "source_truth_1_supported", criterion: "The cited evidence directly contains the named source facts for this requirement.", requiredFacts: ["The concrete source facts named by this requirement."], derivationUse: "Use these source facts to derive the requested artifact or final answer." , completionEvidence: "Current cited evidence proves this check is complete and no named required fact remains unresolved."}] }], completionCriteria: "The source-truth requirement has current supporting evidence." },
            },
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: "/workspace",
                cwd: "/workspace",
                command: "python3 helper.py",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.shell.run",
                input: {
                  workspaceRoot: "/workspace",
                  cwd: "/workspace",
                  command: "python3 helper.py",
                },
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            workspaceRoot: "/workspace",
            cwd: "/workspace",
            command: "python3 helper.py",
          },
          output: {
            status: "FAILED",
            exitCode: 1,
            chunk: [
              "Traceback (most recent call last):",
              "  File \"/workspace/helper.py\", line 7, in <module>",
              "NameError: name 'self' is not defined",
              "__KESTREL_CMD_DONE__:proc-helper:1",
            ].join("\n"),
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "FAILED",
            exitCode: 1,
            chunk: [
              "Traceback (most recent call last):",
              "  File \"/workspace/helper.py\", line 7, in <module>",
              "NameError: name 'self' is not defined",
              "__KESTREL_CMD_DONE__:proc-helper:1",
            ].join("\n"),
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.helperFailure, undefined);
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const processEvidence = evidenceLedger.find((entry) => entry.kind === "process_result");
  assert.equal(processEvidence?.status, "failed");
  assert.equal((processEvidence?.facts as Record<string, unknown> | undefined)?.command, "python3 helper.py");
});

contractTest("runtime.hermetic", "exec.wait_effect treats failed artifact check commands as process evidence", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "verify_artifact",
              objective: "Verify required artifact",
              artifact: {
                target: "/workspace/out.txt",
                requirements: [
                  {
                    id: "artifact-content",
                    expectation: "Artifact matches the task requirements.",
                    source: "task_text",
                  },
                ],
              },
            },
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: "/workspace",
                cwd: "/workspace",
                command: "./run_controller.sh",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.shell.run",
                input: {
                  workspaceRoot: "/workspace",
                  cwd: "/workspace",
                  command: "./run_controller.sh",
                },
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            workspaceRoot: "/workspace",
            cwd: "/workspace",
            command: "./run_controller.sh",
          },
          output: {
            command: "./run_controller.sh",
            cwd: "/workspace",
            workspaceRoot: "/workspace",
            status: "FAILED",
            exitCode: 126,
            chunk: "/bin/bash: line 1: ./run_controller.sh: Permission denied\n__KESTREL_CMD_DONE__:proc-helper:126",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            command: "./run_controller.sh",
            cwd: "/workspace",
            workspaceRoot: "/workspace",
            status: "FAILED",
            exitCode: 126,
            chunk: "/bin/bash: line 1: ./run_controller.sh: Permission denied\n__KESTREL_CMD_DONE__:proc-helper:126",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.helperFailure, undefined);
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const processEvidence = evidenceLedger.find((entry) => entry.kind === "process_result");
  assert.equal((processEvidence?.facts as Record<string, unknown> | undefined)?.commandRole, "general_evidence");
});

contractTest("runtime.hermetic", "exec.dispatch treats inline missing artifact reads as recoverable verify_artifact evidence", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.read_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.read"],
        executionClass: "read_only" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "verify_artifact",
              objective: "Verify required artifact",
              sourcePath: "helper.py",
              producerCommand: "python3 helper.py",
              artifact: {
                target: "/app/result.txt",
                requirements: [
                  {
                    id: "artifact_exists",
                    expectation: "Artifact exists at the required path.",
                    source: "task_text",
                  },
                ],
              },
            },
            nextAction: {
              kind: "tool",
              name: "fs.read_text",
              input: { path: "/app/result.txt" },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("Path does not exist: /app/result.txt");
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(transition.effects?.length ?? 0, 0);
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const artifactEvidence = evidenceLedger.find((entry) => entry.kind === "file_content");
  assert.equal(artifactEvidence?.status, "failed");
  assert.equal((artifactEvidence?.target as Record<string, unknown> | undefined)?.value, "/app/result.txt");
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "exec.dispatch queues filesystem writes with continue failure policy", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Author helper source as an evidence-collection tactic.",
              sourceTruthGoal: { target: "helper source for source-truth collection", requirements: [{ id: "source_truth_1", expectation: "helper source for source-truth collection", evidenceNeeded: "helper source for source-truth collection", sufficiencyChecks: [{ id: "source_truth_1_supported", criterion: "The cited evidence directly contains the named source facts for this requirement.", requiredFacts: ["The concrete source facts named by this requirement."], derivationUse: "Use these source facts to derive the requested artifact or final answer." , completionEvidence: "Current cited evidence proves this check is complete and no named required fact remains unresolved."}] }], completionCriteria: "The source-truth requirement has current supporting evidence." },
            },
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "/dev/null", content: "print('bad target')\n" },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.effects?.[0]?.failurePolicy, "CONTINUE");
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(exec.substate, "wait_effect");
  assert.equal(lastCheckpoint.substate, "wait_effect");
  assert.equal(workingPlan.status, "dispatching");
});

contractTest("runtime.hermetic", "exec.dispatch leaves first filesystem mutation to runtime managed worktree auto-provisioning", async () => {
  const proposalCalls: unknown[] = [];
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async (request) => {
      proposalCalls.push(request);
      return {
        sessionId: "session-1",
        sourceWorkspaceRoot: "/repo",
        sourceRepoRoot: "/repo",
        worktreeRoot: "/home/.kestrel/worktrees/repo/task",
        baseHead: "abc123",
        triggeringTool: "fs.write_text",
        taskKey: "add-hero",
      };
    },
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  const toolCalls: string[] = [];

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "app/page.tsx", content: "<section>Hero</section>" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(name: string): Promise<T> => {
        toolCalls.push(name);
        throw new Error(`tool should not run before worktree approval: ${name}`);
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.waitFor, undefined);
  assert.equal(proposalCalls.length, 0);
  assert.deepEqual(toolCalls, []);
  assert.equal(transition.effects?.length ?? 0, 1);
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  assert.equal(exec.pendingApproval, undefined);
  assert.equal(exec.pendingEffectType, "execute_tool_call");
});

contractTest("runtime.hermetic", "exec.dispatch leaves filesystem mutation batches to runtime managed worktree auto-provisioning", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should be handled by runtime auto-provisioning");
    },
    capabilityManifestProvider: () => [
      {
        name: "fs.read_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.read"],
        executionClass: "read_only" as const,
      },
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  const toolCalls: string[] = [];

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool_batch",
              items: [
                { name: "fs.read_text", input: { path: "app/page.tsx" } },
                { name: "fs.write_text", input: { path: "app/page.tsx", content: "<section>Hero</section>" } },
              ],
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(name: string): Promise<T> => {
        toolCalls.push(name);
        throw new Error(`tool should not run before runtime worktree provisioning: ${name}`);
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.waitFor, undefined);
  assert.equal(proposalCalled, false);
  assert.deepEqual(toolCalls, []);
  assert.equal(transition.effects?.length ?? 0, 1);
  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const pendingBatch = exec.pendingBatch as Record<string, unknown>;
  const pendingItem = pendingBatch.pendingItem as Record<string, unknown>;
  assert.equal(exec.pendingApproval, undefined);
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(pendingBatch.executionMode, "durable");
  assert.equal(pendingItem.name, "fs.read_text");
});

contractTest("runtime.hermetic", "exec.dispatch does not request managed worktree approval for dev shell auto-provision tools", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should be handled by runtime auto-provisioning");
    },
    capabilityManifestProvider: () => [
      {
        name: "dev.shell.run",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: { workspaceRoot: ".", command: "npm test" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(proposalCalled, false);
  assert.notEqual(transition.waitFor?.metadata?.purpose, "managed_worktree");
});

contractTest("runtime.hermetic", "exec.dispatch treats exec_command as the auto-provisioned dev shell alias", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should be handled by runtime auto-provisioning");
    },
    capabilityManifestProvider: () => [
      {
        name: "exec_command",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "exec_command",
              input: { command: "pwd" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(proposalCalled, false);
  assert.notEqual(transition.waitFor?.metadata?.purpose, "managed_worktree");
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
});

contractTest("runtime.hermetic", "exec.dispatch does not request managed worktree approval for dev process auto-provision tools", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should be handled by runtime auto-provisioning");
    },
    capabilityManifestProvider: () => [
      {
        name: "dev.process.start",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "dev.process.start",
              input: { workspaceRoot: ".", command: "npm test" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(proposalCalled, false);
  assert.notEqual(transition.waitFor?.metadata?.purpose, "managed_worktree");
});

contractTest("runtime.hermetic", "exec.dispatch skips managed worktree approval for ephemeral workspace mutations", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should not be requested for ephemeral workspace");
    },
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "/app/maze_controller.py", content: "print('ok')\n" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceId: "terminal-bench",
            workspaceRoot: "/app",
            managedWorktreeRequired: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(proposalCalled, false);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.effects?.[0]?.type, "execute_tool_call");
});

contractTest("runtime.hermetic", "exec.dispatch ignores caller-supplied managedWorktree when no session binding exists", async () => {
  let proposalCalled = false;
  let toolCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      return {
        sessionId: "session-1",
        sourceWorkspaceRoot: "/repo",
        sourceRepoRoot: "/repo",
        worktreeRoot: "/home/.kestrel/worktrees/repo/task",
        baseHead: "abc123",
        triggeringTool: "fs.write_text",
        taskKey: "add-hero",
      };
    },
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "app/page.tsx", content: "<section>Hero</section>" },
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            managedWorktree: true,
            workspaceRoot: "/repo",
            worktreeBinding: {
              status: "bound",
              worktreeRoot: "/repo",
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        toolCalled = true;
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.waitFor, undefined);
  assert.equal(proposalCalled, false);
  assert.equal(toolCalled, false);
});

contractTest("runtime.hermetic", "exec.dispatch does not request managed worktree approval for code.execute in the default build path", async () => {
  let proposalCalled = false;
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async () => {
      proposalCalled = true;
      throw new Error("proposal should not be requested for explicit source-workspace execution");
    },
    capabilityManifestProvider: () => [
      {
        name: "code.execute",
        freshnessClass: "static" as const,
        capabilityClasses: ["code.execute"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool_batch",
              items: [
                {
                  name: "code.execute",
                  input: { code: "print('ok')" },
                },
              ],
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
            managedWorktreeRequired: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable tool should not run inline");
      },
    },
  );

  assert.equal(proposalCalled, false);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.waitFor, undefined);
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.effects?.[0]?.type, "execute_tool_call");
});

contractTest("runtime.hermetic", "exec.wait_approval denial for explicit managed worktree opt-in returns to deliberation", async () => {
  const execConfig = {
    ...buildExecConfig(),
    managedWorktreeProposalProvider: async (request: { triggeringTool: string }) => ({
      sessionId: "session-1",
      sourceWorkspaceRoot: "/repo",
      sourceRepoRoot: "/repo",
      worktreeRoot: "/home/.kestrel/worktrees/repo/task",
      baseHead: "abc123",
      triggeringTool: request.triggeringTool,
      taskKey: "add-hero",
    }),
    capabilityManifestProvider: () => [
      {
        name: "code.execute",
        freshnessClass: "static" as const,
        capabilityClasses: ["code.execute"],
        executionClass: "external_side_effect" as const,
      },
    ],
  };
  const dispatchStep = createExecDispatchStep(execConfig);
  const waitApprovalStep = createExecWaitApprovalStep(execConfig);
  const wait = await dispatchStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool_batch",
              items: [
                {
                  name: "code.execute",
                  input: { code: "print('ok')" },
                },
              ],
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          workspace: {
            workspaceRoot: "/repo",
            managedWorktreeRequired: true,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("tool should not run before approval");
      },
    },
  );
  const waitReact = wait.statePatch?.agent as Record<string, unknown>;

  const denial = await waitApprovalStep(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: waitReact,
        },
        currentStepAgent: "agent.exec.wait_approval",
      },
      event: {
        id: "evt-worktree-deny",
        type: "user.approval",
        sessionId: "session-1",
        payload: {
          message: "deny",
          workspace: {
            workspaceRoot: "/repo",
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("tool should not run after denial");
      },
    },
  );

  const react = denial.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const lastActionResult = react.lastActionResult as Record<string, unknown>;
  assert.equal(denial.status, "RUNNING");
  assert.equal(denial.nextStepAgent, "agent.loop");
  assert.equal(lastActionResult.kind, "approval_denial");
  assert.equal(lastActionResult.status, "denied");
  assert.equal(lastActionResult.purpose, "managed_worktree");
  assert.equal(exec.pendingApproval, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch routes durable tool batches through processor-owned effect dispatch", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            nextAction: {
              kind: "tool_batch",
              items: [
                { name: "fs.write_text", input: { path: "/tmp/a.txt", content: "a" } },
                { name: "fs.write_text", input: { path: "/tmp/b.txt", content: "b" } },
              ],
            },
          },
        },
      },
      event: {
        ...buildContext().event,
        payload: {
          modeSystemV2Enabled: true,
          interactionMode: "build",
          actSubmode: "full_auto",
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable batch should not run inline");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const pendingBatch = exec.pendingBatch as Record<string, unknown>;
  const pendingItem = pendingBatch.pendingItem as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.effects?.[0]?.type, "execute_tool_call");
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(exec.substate, "wait_effect");
  assert.equal(pendingBatch.executionMode, "durable");
  assert.equal(pendingItem.name, "fs.write_text");
  assert.equal(lastCheckpoint.substate, "wait_effect");
  assert.equal(workingPlan.status, "dispatching");
});

contractTest("runtime.hermetic", "exec.dispatch continues durable pending batch without a new nextAction", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.write_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.write"],
        executionClass: "sandboxed_only" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            exec: {
              pendingBatch: {
                executionMode: "durable",
                items: [
                  { name: "fs.write_text", input: { path: "/tmp/a.txt", content: "a" } },
                ],
                nextIndex: 0,
                checkpointSize: 5,
                completedItems: [],
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async () => {
        throw new Error("durable pending batch should not run inline");
      },
    },
  );

  const react = transition.statePatch?.agent as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const pendingBatch = exec.pendingBatch as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  assert.equal(transition.effects?.[0]?.type, "execute_tool_call");
  assert.equal(exec.pendingEffectType, "execute_tool_call");
  assert.equal(exec.substate, "wait_effect");
  assert.equal(pendingBatch.executionMode, "durable");
  assert.equal(react.nextAction, undefined);
});

contractTest("runtime.hermetic", "exec.wait_effect records failed artifact reads instead of terminating verification", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "verify_artifact",
              objective: "Verify required artifact",
              sourcePath: "helper.py",
              producerCommand: "python3 helper.py",
              artifact: {
                target: "/app/result.txt",
                requirements: [
                  {
                    id: "artifact_exists",
                    expectation: "Artifact exists at the required path.",
                    source: "task_text",
                  },
                ],
              },
            },
            nextAction: {
              kind: "tool",
              name: "fs.read_text",
              input: { path: "/app/result.txt" },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "fs.read_text",
                input: { path: "/app/result.txt" },
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          status: "FAILED",
          output: undefined,
          error: {
            code: "EFFECT_EXECUTION_FAILED",
            message: "Path does not exist: /app/result.txt",
            details: {
              path: "/app/result.txt",
              recoverable: true,
            },
          },
        } as T),
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const lastAction = react.lastActionResult as Record<string, unknown>;
  const output = lastAction.output as Record<string, unknown>;
  assert.equal(output.status, "FAILED");
  assert.equal(output.path, "/app/result.txt");
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const artifactEvidence = evidenceLedger.find((entry) => entry.kind === "file_content");
  assert.equal(artifactEvidence?.status, "failed");
  assert.equal((artifactEvidence?.target as Record<string, unknown> | undefined)?.value, "/app/result.txt");
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "exec.wait_effect records durable batch filesystem failures as failed evidence", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Gather source facts and produce /app/result.txt.",
              sourceTruthGoal: {
                target: "Source facts needed for /app/result.txt",
                requirements: [{
                  id: "source_truth_1",
                  expectation: "Source facts needed for /app/result.txt",
                  evidenceNeeded: "Controller output or durable file evidence.",
                  sufficiencyChecks: [{
                    id: "source_truth_1_supported",
                    criterion: "Controller output supports the artifact.",
                    requiredFacts: ["The controller can produce the artifact."],
                    derivationUse: "Use these facts to create /app/result.txt.",
                    completionEvidence: "Controller output or artifact write proves progress.",
                  }],
                }],
                completionCriteria: "Source facts support the required artifact.",
                preferredEvidenceArtifact: "/app/result.txt",
              },
            },
            nextAction: {
              kind: "tool_batch",
              items: [
                { name: "fs.read_text", input: { path: "/app/result.txt" } },
                { name: "dev.shell.run", input: { command: "python3 /app/controller.py", cwd: "/app" } },
              ],
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingBatch: {
                executionMode: "durable",
                items: [
                  { name: "fs.read_text", input: { path: "/app/result.txt" } },
                  { name: "dev.shell.run", input: { command: "python3 /app/controller.py", cwd: "/app" } },
                ],
                nextIndex: 0,
                completedItems: [],
                checkpointSize: 1,
                pendingItem: {
                  name: "fs.read_text",
                  input: { path: "/app/result.txt" },
                  idempotencyKey: "effect-1",
                },
              },
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          status: "FAILED",
          error: {
            code: "EFFECT_EXECUTION_FAILED",
            message: "Path does not exist: /app/result.txt",
            details: {
              path: "/app/result.txt",
              recoverable: true,
            },
          },
        } as T),
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.collect");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const fileEvidence = evidenceLedger.find((entry) => entry.kind === "file_content");
  assert.equal(fileEvidence?.status, "failed");
  assert.equal((fileEvidence?.target as Record<string, unknown> | undefined)?.value, "/app/result.txt");
  const lastAction = react.lastActionResult as Record<string, unknown>;
  const items = lastAction.items as Array<Record<string, unknown>>;
  const output = items[0]?.output as Record<string, unknown>;
  assert.equal(output.status, "FAILED");
  assert.equal(output.path, "/app/result.txt");
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "exec.dispatch records recoverable read-only batch filesystem failures as failed evidence", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.list",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.read"],
        executionClass: "read_only" as const,
      },
      {
        name: "fs.read_text",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.read"],
        executionClass: "read_only" as const,
      },
    ],
  });

  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Inspect whether /app/result.txt exists.",
              sourceTruthGoal: {
                target: "Required output /app/result.txt",
                requirements: [{
                  id: "source_truth_1",
                  expectation: "Check the required output path.",
                  evidenceNeeded: "A direct read result for /app/result.txt.",
                  sufficiencyChecks: [{
                    id: "source_truth_1_supported",
                    criterion: "The latest tool result reports the required output path state.",
                    requiredFacts: ["Whether /app/result.txt exists."],
                    derivationUse: "Use this to decide whether the artifact must be created.",
                    completionEvidence: "The direct read result is recorded.",
                  }],
                }],
                completionCriteria: "The artifact path state is known.",
                preferredEvidenceArtifact: "/app/result.txt",
              },
            },
            nextAction: {
              kind: "tool_batch",
              items: [
                { name: "fs.list", input: { path: "/app", maxDepth: 1 } },
                { name: "fs.read_text", input: { path: "/app/result.txt" } },
              ],
            },
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(name: string): Promise<T> => {
        if (name === "fs.list") {
          return {
            path: "/app",
            entries: [{ name: "controller.py", type: "file" }],
            truncated: false,
          } as T;
        }
        throw new Error("Path does not exist: /app/result.txt");
      },
    },
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  const lastAction = react.lastActionResult as Record<string, unknown>;
  assert.equal(lastAction.kind, "tool_batch");
  const items = lastAction.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  const failedOutput = items[1]?.output as Record<string, unknown>;
  assert.equal(failedOutput.status, "FAILED");
  assert.equal(failedOutput.path, "/app/result.txt");
  assert.equal(failedOutput.recoverable, true);
  assert.match(String(failedOutput.message), /Path does not exist: \/app\/result\.txt/u);

  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  const fileEvidence = evidenceLedger.find((entry) =>
    entry.kind === "file_content" &&
    (entry.target as Record<string, unknown> | undefined)?.value === "/app/result.txt"
  );
  assert.equal(fileEvidence?.status, "failed");
  assert.equal(exec.substate, "collect");
  assert.equal(lastCheckpoint.substate, "collect");
  assert.equal(workingPlan.status, "collecting");
});

contractTest("runtime.hermetic", "exec.dispatch still throws non-recoverable read-only batch tool failures", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "free.weather.current",
        freshnessClass: "live" as const,
        capabilityClasses: ["weather.current"],
        executionClass: "read_only" as const,
      },
    ],
  });

  await assert.rejects(
    () => step(
      buildContext({
        session: {
          ...buildContext().session,
          state: {
            agent: {
              nextAction: {
                kind: "tool_batch",
                items: [
                  { name: "free.weather.current", input: { city: "Seattle" } },
                ],
              },
            },
          },
        },
      }),
      {
        useModel: async () => {
          throw new Error("not expected");
        },
        useTool: async () => {
          throw new Error("provider unavailable");
        },
      },
    ),
    /provider unavailable/u,
  );
});

contractTest("runtime.hermetic", "exec.wait_effect records helper outcome after empty helper read without entering repair", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Collect source truth with helper/controller tactics.",
              sourceTruthGoal: { target: "helper/controller observations", requirements: [{ id: "source_truth_1", expectation: "helper/controller observations", evidenceNeeded: "helper/controller observations", sufficiencyChecks: [{ id: "source_truth_1_supported", criterion: "The cited evidence directly contains the named source facts for this requirement.", requiredFacts: ["The concrete source facts named by this requirement."], derivationUse: "Use these source facts to derive the requested artifact or final answer." , completionEvidence: "Current cited evidence proves this check is complete and no named required fact remains unresolved."}] }], completionCriteria: "The source-truth requirement has current supporting evidence." },
            },
            nextAction: {
              kind: "tool",
              name: "dev.process.read",
              input: {
                processId: "proc-helper",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.process.read",
                input: {
                  processId: "proc-helper",
                },
              },
              devShell: {
                liveProcessIds: ["proc-helper"],
                processes: {
                  "proc-helper": {
                    processId: "proc-helper",
                    command: "python3 helper.py",
                    cwd: "/workspace",
                    workspaceRoot: "/workspace",
                    status: "RUNNING",
                    startedAt: "2026-05-01T00:00:00.000Z",
                  },
                },
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.process.read",
          toolInput: {
            processId: "proc-helper",
          },
          output: {
            processId: "proc-helper",
            status: "RUNNING",
            chunk: "",
            chunkBytes: 0,
            updatedAt: "2026-05-01T00:00:05.000Z",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            processId: "proc-helper",
            status: "RUNNING",
            chunk: "",
            chunkBytes: 0,
            updatedAt: "2026-05-01T00:00:05.000Z",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const verificationDevShell = (postToolVerification.devShell ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(devShellState.helperOutcome, undefined);
  assert.equal(devShellState.helperStall, undefined);
  assert.equal(devShellState.helperFailure, undefined);
  assert.equal(verificationDevShell.helperOutcome, undefined);
  assert.equal(verificationDevShell.helperStall, undefined);
  const evidenceLedger = transition.statePatch?.evidenceLedger as Array<Record<string, unknown>>;
  assert.equal(evidenceLedger.some((entry) => entry.kind === "helper_outcome"), false);
  const processEvidence = evidenceLedger.find((entry) => entry.kind === "process_state");
  assert.equal(processEvidence?.status, "running");
  assert.equal((processEvidence?.facts as Record<string, unknown> | undefined)?.processId, "proc-helper");
  assert.equal(react.workItem, undefined);
});

contractTest("runtime.hermetic", "exec.wait_effect leaves stale helper diagnostics non-authoritative after successful helper exec", async () => {
  const step = createExecWaitEffectStep(buildExecConfig());
  const transition = await step(
    buildContext({
      session: {
        ...buildContext().session,
        state: {
          agent: {
            workItem: {
              version: "v1",
              phase: "gather_evidence",
              objective: "Collect source truth with helper/controller tactics.",
              sourceTruthGoal: { target: "helper/controller observations", requirements: [{ id: "source_truth_1", expectation: "helper/controller observations", evidenceNeeded: "helper/controller observations", sufficiencyChecks: [{ id: "source_truth_1_supported", criterion: "The cited evidence directly contains the named source facts for this requirement.", requiredFacts: ["The concrete source facts named by this requirement."], derivationUse: "Use these source facts to derive the requested artifact or final answer." , completionEvidence: "Current cited evidence proves this check is complete and no named required fact remains unresolved."}] }], completionCriteria: "The source-truth requirement has current supporting evidence." },
            },
            nextAction: {
              kind: "tool",
              name: "dev.shell.run",
              input: {
                workspaceRoot: "/workspace",
                command: "python3 helper.py",
              },
            },
            exec: {
              pendingEffectKey: "effect-1",
              pendingEffectType: "execute_tool_call",
              pendingToolCall: {
                name: "dev.shell.run",
                input: {
                  workspaceRoot: "/workspace",
                  command: "python3 helper.py",
                },
              },
              devShell: {
                helperFailure: {
                  command: "python3 helper.py",
                  exitCode: 1,
                  errorPreview: "NameError",
                },
              },
            },
          },
        },
      },
      event: {
        id: "evt-effect",
        type: "effect.result",
        sessionId: "session-1",
        payload: {
          toolName: "dev.shell.run",
          toolInput: {
            workspaceRoot: "/workspace",
            command: "python3 helper.py",
          },
          output: {
            status: "COMPLETED",
            exitCode: 0,
            chunk: "ok\n",
            truncated: false,
          },
        },
      },
    }),
    {
      useModel: async () => {
        throw new Error("not expected");
      },
      useTool: async <T>(): Promise<T> => ({
          output: {
            status: "COMPLETED",
            exitCode: 0,
            chunk: "ok\n",
            truncated: false,
          },
        } as T),
    },
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = (react.exec ?? {}) as Record<string, unknown>;
  const devShellState = (exec.devShell ?? {}) as Record<string, unknown>;
  assert.equal(react.workItem, undefined);
  assert.equal(devShellState.helperFailure, undefined);
});

contractTest("runtime.hermetic", "exec.dispatch does not reuse cached filesystem outcomes", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "fs.list",
        freshnessClass: "static" as const,
        capabilityClasses: ["fs.list"],
        executionClass: "read_only" as const,
      },
    ],
  });
  let toolCalls = 0;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalls += 1;
      return {
        path: ".",
        entries: [],
      } as T;
    },
  };

  const input = { path: "." };
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Inspect workspace files",
            modelTranscript: transcriptForTask("Inspect workspace files"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "fs.list",
              input,
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
      memory: {
        working: {
          toolOutcomeCache: [
            {
              toolName: "fs.list",
              inputHash: hashToolInput("fs.list", input),
              status: "success",
              summary: "Cached workspace listing",
              stepIndex: 1,
              reusable: true,
              capabilityClasses: ["fs.list"],
              output: {
                path: ".",
                entries: [{ name: "stale.txt", type: "file" }],
              },
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const traces = (react.decisionTrace ?? []) as Array<Record<string, unknown>>;
  assert.equal(traces.some((trace) => trace.eventType === "decision.deduped"), false);
  assert.equal(toolCalls, 1);
});

contractTest("runtime.hermetic", "exec.dispatch does not reuse cached external side-effect outcomes", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "dev.process.read",
        freshnessClass: "volatile" as const,
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect" as const,
      },
    ],
  });
  let toolCalls = 0;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalls += 1;
      return {
        processId: "proc-1",
        status: "RUNNING",
        chunk: "",
        truncated: false,
      } as T;
    },
  };

  const input = { processId: "proc-1" };
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Read shell process output",
            modelTranscript: transcriptForTask("Read shell process output"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "dev.process.read",
              input,
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
          interactionMode: "build",
          actSubmode: "full_auto",
        },
      },
      memory: {
        working: {
          toolOutcomeCache: [
            {
              toolName: "dev.process.read",
              inputHash: hashToolInput("dev.process.read", input),
              status: "success",
              summary: "Cached shell status",
              stepIndex: 1,
              reusable: true,
              capabilityClasses: ["dev.shell", "host.shell"],
              output: {
                processId: "proc-1",
                status: "RUNNING",
                chunk: "",
                truncated: false,
              },
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.wait_effect");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const traces = (react.decisionTrace ?? []) as Array<Record<string, unknown>>;
  assert.equal(traces.some((trace) => trace.eventType === "decision.deduped"), false);
  assert.equal(toolCalls, 0);
});

contractTest("runtime.hermetic", "exec.dispatch derives broadened search from prior low-signal cached research", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("tool should not be called");
    },
  };

  const input = { query: "Cincinnati Ohio church former members spiritual abuse" };
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Cults and high-control religious groups in Cincinnati",
            modelTranscript: transcriptForTask("Cults and high-control religious groups in Cincinnati"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "internet.search",
              input,
            },
            postToolVerification: {
              evidenceRecoverySummary: {
                objectiveKey: "cults and high-control religious groups in cincinnati",
                family: "news_research",
                attempts: 1,
                lowSignalAttempts: 1,
                consecutiveLowSignal: 1,
                broadenedSearchUsed: false,
                targetedFetchUsed: false,
                latest: {
                  family: "news_research",
                  toolName: "internet.search",
                  quality: "low",
                  lowSignal: true,
                  issues: ["low_domain_diversity"],
                  resultsCount: 3,
                  domainDiversity: 1,
                  payloadFingerprint: "fp-search",
                  repeatedFingerprintCount: 1,
                  candidateUrls: ["https://example.com/article"],
                },
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
      memory: {
        working: {
          toolOutcomeCache: [
            {
              toolName: "internet.search",
              inputHash: hashToolInput("internet.search", input),
              status: "success",
              summary: "Cached search result",
              stepIndex: 1,
              reusable: true,
              output: {
                query: input.query,
                results: [
                  {
                    title: "Example result",
                    url: "https://example.com/article-2",
                    source: "Example",
                  },
                ],
              },
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const evidenceRecoverySummary = (postToolVerification.evidenceRecoverySummary ?? {}) as Record<string, unknown>;
  assert.equal(postToolVerification.recoveryStage, "broaden_search");
  assert.equal(evidenceRecoverySummary.broadenedSearchUsed, true);
});

contractTest("runtime.hermetic", "exec.dispatch does not derive broadened search after prior high-yield research", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("tool should not be called");
    },
  };

  const input = { query: "Cincinnati Ohio church former members spiritual abuse" };
  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Cults and high-control religious groups in Cincinnati",
            modelTranscript: transcriptForTask("Cults and high-control religious groups in Cincinnati"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "internet.search",
              input,
            },
            postToolVerification: {
              evidenceRecoverySummary: {
                objectiveKey: "cults and high-control religious groups in cincinnati",
                family: "news_research",
                attempts: 1,
                lowSignalAttempts: 0,
                consecutiveLowSignal: 0,
                broadenedSearchUsed: false,
                targetedFetchUsed: false,
                latest: {
                  family: "news_research",
                  toolName: "internet.search",
                  quality: "high",
                  lowSignal: false,
                  issues: [],
                  resultsCount: 8,
                  domainDiversity: 6,
                  payloadFingerprint: "fp-search-good",
                  repeatedFingerprintCount: 1,
                  candidateUrls: ["https://example.com/article"],
                },
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
      memory: {
        working: {
          toolOutcomeCache: [
            {
              toolName: "internet.search",
              inputHash: hashToolInput("internet.search", input),
              status: "success",
              summary: "Cached search result",
              stepIndex: 1,
              reusable: true,
              output: {
                query: input.query,
                results: [
                  {
                    title: "Example result",
                    url: "https://example.com/article-2",
                    source: "Example",
                  },
                ],
              },
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const evidenceRecoverySummary = (postToolVerification.evidenceRecoverySummary ?? {}) as Record<string, unknown>;
  assert.equal(postToolVerification.recoveryStage, undefined);
  assert.equal(evidenceRecoverySummary.broadenedSearchUsed, false);
});

contractTest("runtime.hermetic", "exec.dispatch does not reuse lastActionResult when input hash is missing", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  let toolCalls = 0;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      toolCalls += 1;
      return {
        status: "ok",
        summary: "Fresh Cincinnati weather",
      } as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            goal: "Get current weather",
            modelTranscript: transcriptForTask("Get current weather"),
            ...approvedPlanState(),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "free.weather.current",
              input: {
                city: "Cincinnati",
              },
            },
            lastActionResult: {
              kind: "tool",
              name: "free.weather.current",
              output: {
                status: "ok",
                summary: "Prior Ohio weather response",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      event: {
        id: "evt-1",
        type: "user.message",
        sessionId: "session-1",
        payload: {
          autonomyLevel: "L4",
        },
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const traces = (react.decisionTrace ?? []) as Array<Record<string, unknown>>;
  assert.equal(traces.some((trace) => trace.eventType === "decision.deduped"), false);
  assert.equal(toolCalls, 1);
});

contractTest("runtime.hermetic", "exec.dispatch marks duplicate_executed_result for repeated fresh web output", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const repeatedOutput = {
    results: [
      {
        title: "Supplier controls overview",
        url: "https://example.com/controls",
        source: "Example",
      },
    ],
  };
  const duplicateSeed = detectReadOnlyResultDuplicate({
    toolName: "internet.search",
    output: repeatedOutput,
    ledger: [],
  });
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => repeatedOutput as T,
  };

  const input = { q: "supplier onboarding controls overview" };
  const transition = await step(
    buildContext({
      stepIndex: 6,
      session: {
        sessionId: "session-dup-exec",
        version: 1,
        state: {
          agent: {
            goal: "Track supplier onboarding controls coverage",
            modelTranscript: transcriptForTask("Track supplier onboarding controls coverage"),
            ...approvedPlanState("session-dup-exec"),
            decisionVerification: {
              missingCapabilities: [],
            },
            nextAction: {
              kind: "tool",
              name: "internet.search",
              input,
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        working: {
          readOnlyResultDuplicateLedger: [
            {
              fingerprint: duplicateSeed?.fingerprint ?? "missing",
              family: "web_search_results",
              toolName: "internet.search",
              canonicalSource: duplicateSeed?.canonicalSource,
              canonicalUrl: "https://example.com/controls",
              count: 1,
              firstSeenStep: 2,
              lastSeenStep: 2,
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        episodicRef: "episodic:test",
        semanticRef: "semantic:test",
      },
    }),
    io,
  );

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  assert.deepEqual(react.latestEvidenceDelta, {
    kind: "duplicate_executed_result",
    toolName: "internet.search",
    duplicateCount: 2,
    matchedPriorStep: 2,
  });
  const postToolVerification = (react.postToolVerification ?? {}) as Record<string, unknown>;
  const duplicateResult = (postToolVerification.duplicateResult ?? {}) as Record<string, unknown>;
  assert.equal(duplicateResult.kind, "duplicate_executed_result");
  assert.equal(duplicateResult.duplicateCount, 2);
});

contractTest("runtime.hermetic", "exec.dispatch fails fast on repeated deduped tool reuse with no progress", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(): Promise<T> => {
      throw new Error("tool should not be called");
    },
  };

  const input = { city: "Seattle" };
  const transition = await step(
    buildContext({
          session: {
            sessionId: "session-1",
            version: 1,
            state: {
              agent: {
                goal: "Get current weather",
                modelTranscript: transcriptForTask("Get current weather"),
                ...approvedPlanState(),
                decisionVerification: {
                  missingCapabilities: [],
                },
                nextAction: {
                  kind: "tool",
                  name: "free.weather.current",
                  input,
                },
                exec: {
                  dispatchReuseGuard: {
                    runId: "run-1",
                    toolName: "free.weather.current",
                    inputHash: hashToolInput("free.weather.current", input),
                    consecutiveReuseCount: 1,
                  },
                },
              },
            },
            currentStepAgent: "agent.exec.dispatch",
            updatedAt: new Date().toISOString(),
          },
          event: {
            id: "evt-1",
            type: "user.message",
            sessionId: "session-1",
            payload: {
              autonomyLevel: "L4",
            },
          },
          memory: {
            working: {
              toolOutcomeCache: [
                {
                  toolName: "free.weather.current",
                  inputHash: hashToolInput("free.weather.current", input),
                  status: "success",
                  summary: "Cached Seattle weather",
                  stepIndex: 1,
                  reusable: true,
                  capabilityClasses: ["weather.current"],
                  output: {
                    status: "ok",
                    summary: "Cached Seattle weather",
                  },
                  updatedAt: new Date().toISOString(),
                },
              ],
            },
            episodicRef: "episodic:test",
            semanticRef: "semantic:test",
          },
    }),
    io,
  );
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  assert.equal(retryContext.failure !== undefined, true);
});

contractTest("runtime.hermetic", "exec.dispatch strips unadvertised internet.search domain filters before tool execution", async () => {
  const step = createExecDispatchStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "internet.search",
        freshnessClass: "live" as const,
        capabilityClasses: ["web.search", "reference.search"],
        executionClass: "read_only" as const,
      },
    ],
  });

  let capturedInput: unknown;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(_name: string, input: unknown): Promise<T> => {
      capturedInput = input;
      return {
        status: "ok",
        results: [],
      } as T;
    },
  };

  const transition = await step(
    buildContext({
      session: {
        sessionId: "session-1",
        version: 1,
        state: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "internet.search",
              input: {
                query: "crosby deal",
                domainAllow: "local12.com, fox19.com",
                domainDeny: "facebook.com",
              },
            },
          },
        },
        currentStepAgent: "agent.exec.dispatch",
        updatedAt: new Date().toISOString(),
      },
    }),
    io,
  );

  assert.equal(transition.status, "RUNNING");
  assert.deepEqual(capturedInput, {
    query: "crosby deal",
  });
});
