import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { createAgentLoopStep } from "../../agents/reference-react/src/steps/deliberator.js";
import {
  compileAgentAction,
  DecisionCompileError,
  type CompileAgentActionInput,
} from "../../agents/reference-react/src/decision/compileIntent.js";
import { providerToolAliasForCanonicalName } from "../../agents/reference-react/src/modelToolCallActions.js";
import type { StepContext, StepIO } from "../../src/kestrel/contracts/execution.js";
import type { ModelRequest, ModelResponse, ModelToolIntent, ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

import { normalizeContinuationOffer, type ContinuationOfferV1 } from "../../src/runtime/continuationOffer.js";
import { createRuntimeContinuationState } from "../../src/runtime/continuationState.js";
import { stringifySanitizedJson } from "../../src/runtime/jsonSanitizer.js";
import { appendUserTurnToTranscript, readActiveTaskGoalFromTranscript } from "../../src/runtime/modelTranscript.js";

const READ_TEXT_TOOL: ModelToolSpec = {
  name: "fs.read_text",
  description: "Read a text file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
};

function setKestrelHomeForTest(kestrelHome: string): () => void {
  const original = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = kestrelHome;
  return () => {
    if (original === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = original;
    }
  };
}

function transcriptForTask(task: string) {
  return appendUserTurnToTranscript({
    transcript: { version: 1, windowId: 1, items: [] },
    message: task,
    stepIndex: 0,
  });
}

const WRITE_TEXT_TOOL: ModelToolSpec = {
  name: "fs.write_text",
  description: "Write a text file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

const SEARCH_TEXT_TOOL: ModelToolSpec = {
  name: "fs.search_text",
  description: "Search files for text.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      query: { type: "string" },
    },
    required: ["path", "query"],
  },
};

function successfulFileMutationEvidence() {
  return [
    {
      id: "ev-file-write",
      version: "v1",
      createdAt: "2026-06-15T00:00:00.000Z",
      source: "tool",
      kind: "file_mutation",
      status: "passed",
      summary: "fs.write_text wrote 32 bytes to newsletter-report.json.",
      target: { type: "path", value: "newsletter-report.json" },
      facts: {
        toolName: "fs.write_text",
        path: "newsletter-report.json",
        changed: true,
        bytesWritten: 32,
      },
    },
  ];
}

function successfulTokenChangingReplaceTextEvidence() {
  return [
    {
      id: "ev-replace-token-delta",
      version: "v1",
      createdAt: "2026-06-15T00:00:00.000Z",
      source: "tool",
      kind: "file_mutation",
      status: "passed",
      summary: 'fs.replace_text "a great deal more" -> "a lot more" (1 replacement, token delta -1).',
      target: { type: "path", value: "input.tex" },
      facts: {
        toolName: "fs.replace_text",
        outputPath: "input.tex",
        find: "a great deal more",
        replace: "a lot more",
        replacements: 1,
        changed: true,
        whitespaceTokenCountBefore: 939,
        whitespaceTokenCountAfter: 938,
        whitespaceTokenCountDelta: -1,
        lineCountBefore: 20,
        lineCountAfter: 20,
        lineCountDelta: 0,
      },
    },
  ];
}

function successfulTokenPreservingReplaceTextEvidence() {
  return [
    {
      id: "ev-replace-token-preserving",
      version: "v1",
      createdAt: "2026-06-15T00:00:00.000Z",
      source: "tool",
      kind: "file_mutation",
      status: "passed",
      summary: 'fs.replace_text "college" -> "school" (1 replacement).',
      target: { type: "path", value: "input.tex" },
      facts: {
        toolName: "fs.replace_text",
        outputPath: "input.tex",
        find: "college",
        replace: "school",
        replacements: 1,
        changed: true,
        whitespaceTokenCountDelta: 0,
        lineCountDelta: 0,
      },
    },
  ];
}

function successfulReadInputTexEvidence(id = "ev-read-input", stepIndex = 1) {
  return {
    id,
    version: "v1",
    createdAt: `2026-06-15T00:00:0${stepIndex}.000Z`,
    stepIndex,
    source: "tool",
    kind: "file_content",
    status: "passed",
    summary: "fs.read_text input.tex.",
    target: { type: "path", value: "input.tex" },
    facts: {
      toolName: "fs.read_text",
      inputPath: "input.tex",
      outputPath: "input.tex",
      contentPreview: "final text",
    },
  };
}

function successfulShellChangedFilesEvidence(paths: string[], id = "ev-shell-changed", stepIndex = 2) {
  return {
    id,
    version: "v1",
    createdAt: `2026-06-15T00:00:0${stepIndex}.000Z`,
    stepIndex,
    source: "tool",
    kind: "process_result",
    status: "passed",
    summary: `dev.shell.run changed ${paths.join(", ")}.`,
    target: { type: "tool", value: "dev.shell.run" },
    facts: {
      toolName: "dev.shell.run",
      command: "python3 edit.py",
      exitCode: 0,
      workspaceRoot: "/app",
      changedFiles: paths,
    },
  };
}

type LegacyCompileIntentFixtureInput = Omit<CompileAgentActionInput, "action"> & {
  output?: unknown;
  modelText?: string | undefined;
};

function compileIntent(input: LegacyCompileIntentFixtureInput) {
  const output = input.output as Record<string, unknown> | undefined;
  const action = normalizeLegacyNextActionForFixture(output?.nextAction, input.sourceRunId);
  if (action === undefined) {
    throw new DecisionCompileError(
      "DECISION_PARSE_FAILED",
      "Test fixture must provide output.nextAction for action compilation.",
      "parse",
    );
  }
  const outputRecord = output as Record<string, unknown>;
  const {
    output: _output,
    modelText: _modelText,
    ...rest
  } = input;
  return compileAgentAction({
    ...rest,
    action,
    visibleTodosPatch: outputRecord.visibleTodos as CompileAgentActionInput["visibleTodosPatch"],
    reason: typeof outputRecord.reason === "string" ? outputRecord.reason : undefined,
  });
}

function normalizeLegacyNextActionForFixture(
  value: unknown,
  sourceRunId: string | undefined,
): CompileAgentActionInput["action"] | undefined {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  const action = value as Record<string, unknown>;
  if (action.kind === "finalize" && typeof action.status === "string") {
    return {
      kind: "finalize",
      finalizeReason: action.status,
      input: {
        message: typeof action.message === "string" ? action.message : "",
        ...(action.data !== undefined ? { data: action.data } : {}),
      },
    } as CompileAgentActionInput["action"];
  }
  if (action.kind === "handoff_to_build" && typeof action.message === "string") {
    const continuationInput = action.continuation as Record<string, unknown> | undefined;
    const continuation = continuationInput === undefined
      ? undefined
      : normalizeContinuationOffer({
          ...continuationInput,
          version: "continuation_offer_v1",
          kind: "implementation",
          requiredMode: "build",
          sourceRunId,
        }, sourceRunId ?? "fixture-run");
    return {
      kind: "handoff_to_build",
      message: action.message,
      continuation,
      ...(action.data !== undefined ? { data: action.data } : {}),
    } as CompileAgentActionInput["action"];
  }
  return action as CompileAgentActionInput["action"];
}

const LIST_TOOL: ModelToolSpec = {
  name: "fs.list",
  description: "List files",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
      includeHidden: { type: "boolean" },
      maxDepth: { type: "number" },
    },
    required: ["path"],
  },
};

async function writeLegacySessionNoteFixture(
  kestrelHome: string,
  sessionId: string,
  filename: string,
  content: string,
): Promise<string> {
  const absolutePath = path.join(kestrelHome, "sessions", sessionId, filename);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

const DEV_SHELL_RUN_TOOL: ModelToolSpec = {
  name: "dev.shell.run",
  description: "Run a command in the development shell.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      workspaceRoot: { type: "string" },
    },
    required: ["command"],
  },
};

const EXEC_COMMAND_TOOL: ModelToolSpec = {
  ...DEV_SHELL_RUN_TOOL,
  name: "exec_command",
  description: "Run terminal work.",
};

const PROJECT_TASK_PROPOSE_TOOL: ModelToolSpec = {
  name: "task.propose",
  description: "Propose a Mission Control task.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string" },
      title: { type: "string" },
      instructions: { type: "string" },
      summary: { type: "string" },
    },
    required: ["sessionId", "title", "instructions"],
  },
};

function projectTaskQueueCapabilityManifest() {
  return [
    {
      name: "task.propose",
      description: "Propose a Mission Control task",
      capabilityClasses: ["runtime.project.task_queue"],
      approvalCapabilities: ["project.task_queue.write"],
      executionClass: "external_side_effect" as const,
      allowedInteractionModes: ["chat", "build"] as Array<"chat" | "build">,
    },
  ];
}

function taskQueueWriteAllowedPolicy() {
  return {
    toolClassPolicy: {
      external_side_effect: true,
    },
    capabilityPolicy: {
      "project.task_queue.write": true,
    },
  };
}

function projectSnapshotFixture(input?: {
  cards?: Record<string, unknown>;
}) {
  return {
    sessionId: "project-session-1",
    taskQueue: {
      version: 1,
      queueVersion: 1,
      nextTaskNumber: 2,
      tasks: input?.cards ?? {},
    },
  };
}

const MKDIR_TOOL: ModelToolSpec = {
  name: "fs.mkdir",
  description: "Create a directory.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
    },
    required: ["path"],
  },
};

function buildStep(input?: {
  tools?: ModelToolSpec[];
    capabilityManifest?: Array<{
      name: string;
      description: string;
      capabilityClasses: string[];
      approvalCapabilities?: string[];
      executionClass: "read_only" | "sandboxed_only" | "external_side_effect";
      allowedInteractionModes?: Array<"chat" | "plan" | "build">;
  }>;
}) {
  return createAgentLoopStep({
    agentModel: "test/agent",
    agentToolsProvider: () => input?.tools ?? [READ_TEXT_TOOL],
    capabilityManifestProvider: () => input?.capabilityManifest ?? [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
    defaultGoal: "Answer the user.",
    loopStepId: "agent.loop",
    execDispatchStepId: "agent.exec.dispatch",
  });
}

function modelResponse(output: unknown): ModelResponse<unknown> {
  const record = output !== null && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : undefined;
  const toolIntents = record?.nextAction !== undefined || record?.visibleTodos !== undefined
    ? modelToolIntentsFromLegacyTestAction(record.nextAction, record.visibleTodos)
    : [];
  const normalizedOutput =
    record !== undefined &&
    record.understanding === undefined &&
    record.nextAction !== undefined &&
    typeof record.reason === "string"
      ? {
          understanding: {
            task: "Handle the requested test task.",
            facts: ["The test model selected an executable next action."],
            currentGap: "The requested task still needs the selected action.",
            actionBasis: "The selected action is the next concrete step for the test.",
          },
          ...record,
        }
      : output;
  return ({
    output: normalizedOutput,
    ...(typeof record?.reason === "string" ? { text: record.reason } : {}),
    toolIntents,
    provider: {
      name: "openai",
      model: "test/agent",
      endpoint: "chat",
    },
  });
}

function modelToolIntentsFromLegacyTestAction(
  action: unknown,
  visibleTodos: unknown,
): ModelToolIntent[] {
  const intents: ModelToolIntent[] = [];
  if (visibleTodos !== undefined) {
    intents.push({
      name: "kestrel_todo_update",
      input: {
        ...(visibleTodos as Record<string, unknown>),
        assistantProgress: "I am updating the visible work plan.",
      },
    });
  }
  const record = action !== null && typeof action === "object" && !Array.isArray(action)
    ? action as Record<string, unknown>
    : undefined;
  if (record === undefined) {
    return intents;
  }
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  if (kind === "tool" && typeof record.name === "string") {
    intents.push({
      name: providerToolAliasForCanonicalName(record.name),
      input: {
        ...(record.input as Record<string, unknown>),
        assistantProgress: `I am using ${record.name} to continue the requested work.`,
      },
    });
    return intents;
  }
  if (kind === "tool_batch" && Array.isArray(record.items)) {
    for (const item of record.items) {
      const itemRecord = item !== null && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : undefined;
      if (typeof itemRecord?.name !== "string") {
        continue;
      }
      intents.push({
        name: providerToolAliasForCanonicalName(itemRecord.name),
        input: {
          ...(itemRecord.input as Record<string, unknown>),
          assistantProgress: `I am using ${itemRecord.name} to continue the requested work.`,
        },
      });
    }
    return intents;
  }
  if (kind === "finalize") {
    const inputRecord = record.input as Record<string, unknown> | undefined;
    intents.push({
      name: "kestrel_finalize",
      input: {
        status: record.status ?? record.finalizeReason ?? "goal_satisfied",
        message: record.message ?? inputRecord?.message,
        assistantProgress: "I have completed the requested work.",
        ...(record.data !== undefined ? { data: record.data } : {}),
        ...(inputRecord?.data !== undefined ? { data: inputRecord.data } : {}),
      },
    });
    return intents;
  }
  if (kind === "ask_user") {
    intents.push({
      name: "kestrel_ask_user",
      input: {
        prompt: record.prompt,
        assistantProgress: "I need one detail from you before I can continue.",
      },
    });
    return intents;
  }
  if (kind === "cannot_satisfy") {
    intents.push({
      name: "kestrel_cannot_satisfy",
      input: {
        reasonCode: record.reasonCode,
        message: record.message,
        assistantProgress: "I found a blocker that prevents me from continuing.",
        ...(record.details !== undefined ? { details: record.details } : {}),
      },
    });
    return intents;
  }
  if (kind === "handoff_to_build") {
    intents.push({
      name: "kestrel_handoff_to_build",
      input: {
        message: record.message,
        continuation: record.continuation,
        assistantProgress: "The plan is ready to continue in build mode.",
        ...(record.data !== undefined ? { data: record.data } : {}),
      },
    });
  }
  return intents;
}

function context(): StepContext {
  return ({
    runId: "run-1",
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {},
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: "Read a file.",
      },
    },
    stepIndex: 1,
    memory: {},
    budget: {},
  } as unknown) as StepContext;
}

function continuationOffer(overrides: Partial<ContinuationOfferV1> = {}): ContinuationOfferV1 {
  return {
    version: "continuation_offer_v1",
    kind: "implementation",
    objective: "Create a Python Pong game.",
    requiredToolClass: "sandboxed_only",
    requiredCapabilities: ["workspace.write"],
    requiredMode: "build",
    sourceRunId: "run-1",
    resumeMessage: "Create the Pong game.",
    ...overrides,
  };
}

function compactContinuationInput() {
  return {
    objective: "Create a Python Pong game.",
    requiredToolClass: "sandboxed_only",
    requiredCapabilities: ["workspace.write"],
    resumeMessage: "Create the Pong game.",
  };
}

function runtimeContinuation(overrides: Record<string, unknown> = {}) {
  return {
    ...createRuntimeContinuationState({
      offer: continuationOffer(),
      resumeStepAgent: "agent.exec.wait_user",
      planDocumentPath: "~/.kestrel/sessions/session-1/PLAN.md",
      proposedNextAction: "Create a Python Pong game.",
      handoffMessage: "I can build this next.",
      createdAt: "2026-06-03T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function planningContinuationOffer() {
  return {
    version: "continuation_offer_v1",
    kind: "implementation",
    objective: "Run the workspace bootstrap command.",
    requiredToolClass: "sandboxed_only",
    requiredCapabilities: ["workspace.write"],
    requiredMode: "build",
    sourceRunId: "run-1",
    resumeMessage: "Run the workspace bootstrap command.",
  };
}

test("plan-mode clarification replies preserve the transcript task as task instruction", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build a NextJS text-only microblogging demo with signup and CRUD posts.";
  const reply = "yes assume simple defaults.";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          modelTranscript: transcriptForTask(buildRequest),
          interactionMode: "plan",
          waitingFor: {
            kind: "user",
            eventType: "user.message",
            reason: "Need stack defaults.",
            resumeInstruction: "Resume after the user confirms defaults.",
            metadata: {
              prompt: "Should I assume simple defaults?",
            },
          },
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: reply,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "Captured the defaults reply.",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, buildRequest);
  const agentPatch = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(agentPatch.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agentPatch.modelTranscript), buildRequest);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [buildRequest, reply],
  );
  assert.equal(items.at(-1)?.content, reply);
});

test("build-mode collected clarification replies preserve transcript task as task instruction", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const reply = "lets do Vite instead of Nextjs... SQLite db via prisma is fine";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: reply,
          modelTranscript: transcriptForTask(buildRequest),
          interactionMode: "build",
          lastActionResult: {
            ok: true,
            kind: "user_reply",
            status: "received",
            responseEventType: "user.reply",
            resumeGoal: "Wrong legacy resume task.",
            responsePayload: {
              message: reply,
            },
          },
        },
      },
    },
    event: {
      type: "user.reply",
      payload: {
        message: reply,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, buildRequest);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [buildRequest, reply],
  );
  assert.equal(items.at(-1)?.content, reply);
});

test("build-mode collected clarification resumeGoal does not seed missing transcript task", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const reply = "lets do Vite instead of Nextjs... SQLite db via prisma is fine";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          interactionMode: "build",
          lastActionResult: {
            ok: true,
            kind: "user_reply",
            status: "received",
            responseEventType: "user.reply",
            resumeGoal: buildRequest,
            responsePayload: {
              message: reply,
            },
          },
        },
      },
    },
    event: {
      type: "user.reply",
      payload: {
        message: reply,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, "Answer the user.");
  assert.notEqual(input.taskInstruction, buildRequest);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    ["Answer the user.", reply],
  );
});

test("build-mode fresh user messages replace transcript task when no active task state remains", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const followUp = "you can use your tools to scaffold a project";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: followUp,
          interactionMode: "build",
          modelTranscript: {
            version: 1,
            windowId: 1,
            items: [
              {
                id: "turn_1",
                createdAt: "2026-07-06T13:43:38.872Z",
                kind: "user",
                content: buildRequest,
              },
              {
                id: "turn_2",
                createdAt: "2026-07-06T13:44:00.000Z",
                kind: "assistant_text",
                content: "I cannot continue because the workspace is empty.",
              },
            ],
          },
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: followUp,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, followUp);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.equal(items.at(-1)?.kind, "user");
  assert.equal(items.at(-1)?.content, followUp);
  const agentPatch = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(agentPatch.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agentPatch.modelTranscript), followUp);
});

test("terminal user messages start a fresh task epoch and clear task-scoped state", async () => {
  let capturedRequest: ModelRequest | undefined;
  const oldTask = "Tell me about this workspace pls.";
  const buildRequest = "Build a bookmark manager with auth, bookmark CRUD, tags, and search.";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          interactionMode: "build",
          phase: "DONE",
          terminal: {
            status: "DONE",
          },
          finalOutput: {
            message: "Old workspace summary.",
          },
          observations: [
            {
              kind: "tool",
              status: "passed",
              summary: "legacy observation for old task",
              capabilityClasses: ["old-capability"],
            },
          ],
          modelTranscript: transcriptForTask(oldTask),
          retryContext: {
            failure: {
              code: "DECISION_POLICY_FAILED",
              details: {
                reason: "visible_todo_finalize_continuation",
              },
            },
          },
          postToolVerification: {
            resultQuality: "ok",
            evidenceRecoverySummary: {
              retainedCandidates: ["legacy-post-tool-marker"],
            },
          },
          decisionVerification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          lastAction: {
            kind: "finalize",
            finalizeReason: "goal_satisfied",
          },
          lastActionResult: {
            kind: "finalize",
            status: "ok",
          },
          nextAction: {
            kind: "finalize",
            finalizeReason: "goal_satisfied",
          },
          commandBatch: {
            status: "ready",
            commands: [{ kind: "finalize" }],
          },
          visibleTodos: {
            objective: oldTask,
            items: [
              {
                id: "db",
                text: "Implement Prisma schema and migrations for users and bookmarks",
                status: "pending",
              },
            ],
          },
          decisionReason: "Still open: Implement Prisma schema and migrations for users and bookmarks.",
          decisionTrace: [
            {
              eventType: "decision.redirected",
              phase: "agent.loop",
              decisionCode: "visible_todo_finalize_continuation",
            },
          ],
          loopGuard: {
            history: [
              {
                actionSignature: "old-finalize-loop",
              },
            ],
          },
        },
        evidenceLedger: successfulFileMutationEvidence(),
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: buildRequest,
        interactionMode: "build",
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
        reason: "Inspect the workspace for the new build.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  const requestText = JSON.stringify(capturedRequest.messages ?? []);
  assert.equal(input.taskInstruction, buildRequest);
  assert.notEqual(input.taskInstruction, oldTask);
  assert.doesNotMatch(requestText, /newsletter-report\.json/u);
  assert.doesNotMatch(requestText, /legacy-post-tool-marker/u);
  assert.doesNotMatch(requestText, /old-capability/u);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [buildRequest],
  );
  const agentPatch = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(agentPatch.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agentPatch.modelTranscript), buildRequest);
  assert.equal(agentPatch.retryContext, undefined);
  assert.equal(agentPatch.lastActionResult, undefined);
  assert.equal(agentPatch.visibleTodos, undefined);
  assert.deepEqual(agentPatch.observations, []);
  assert.equal(agentPatch.postToolVerification, undefined);
  assert.deepEqual(agentPatch.decisionVerification, {
    missingCapabilities: [],
    actionNovelty: true,
    expectedEvidenceDelta: "medium",
  });
  assert.equal(agentPatch.loopGuard, undefined);
  assert.equal(agentPatch.terminal, undefined);
  assert.equal(agentPatch.finalOutput, undefined);
  assert.equal(Object.hasOwn(transition.statePatch ?? {}, "evidenceLedger"), true);
  assert.equal(transition.statePatch?.evidenceLedger, undefined);
  assert.doesNotMatch(JSON.stringify(agentPatch), /visible_todo_finalize_continuation/u);
});

test("terminal user messages do not let stale task evidence satisfy fresh build finalization", async () => {
  const oldTask = "Build an old newsletter report.";
  const buildRequest = "Build a bookmark manager with auth, bookmark CRUD, tags, and search.";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          interactionMode: "build",
          phase: "DONE",
          terminal: {
            status: "DONE",
          },
          modelTranscript: transcriptForTask(oldTask),
          observations: [
            {
              kind: "tool",
              status: "passed",
              capabilityClasses: ["filesystem.write"],
            },
          ],
          postToolVerification: {
            resultQuality: "ok",
          },
          decisionVerification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
        },
        evidenceLedger: successfulFileMutationEvidence(),
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: buildRequest,
        interactionMode: "build",
      },
    },
  } as unknown as StepContext, {
    useModel: async () => modelResponse({
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
      reason: "The prior run already had evidence.",
    }),
  } as StepIO);

  const agentPatch = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agentPatch.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(details.reason, "build_goal_satisfied_without_evidence");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(Object.hasOwn(transition.statePatch ?? {}, "evidenceLedger"), true);
  assert.equal(transition.statePatch?.evidenceLedger, undefined);
  const observations = agentPatch.observations as Array<Record<string, unknown>>;
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.kind, "validation_feedback");
  assert.equal(observations[0]?.errorCode, "DECISION_POLICY_FAILED");
  assert.doesNotMatch(JSON.stringify(observations), /filesystem\.write/u);
  assert.equal(agentPatch.postToolVerification, undefined);
  assert.equal(agentPatch.decisionVerification, undefined);
});

test("build-mode fresh user messages start a new task before live reply", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const followUp = "you can use your tools to scaffold a project";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          modelTranscript: transcriptForTask(buildRequest),
          interactionMode: "build",
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: followUp,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, followUp);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [followUp],
  );
});

test("active follow-up payload message is appended instead of promoted to task fallback", async () => {
  let capturedRequest: ModelRequest | undefined;
  const followUp = "you can use your tools to scaffold a project";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          interactionMode: "build",
          lastAction: {
            kind: "ask_user",
            prompt: "What should I build?",
          },
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: followUp,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, "Answer the user.");
  assert.notEqual(input.taskInstruction, followUp);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    ["Answer the user.", followUp],
  );
});

test("fresh payload message replaces transcript task and ignores stale payload goal", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const stalePayloadGoal = "stale follow-up task";
  const followUp = "you can use your tools to scaffold a project";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          modelTranscript: transcriptForTask(buildRequest),
          interactionMode: "build",
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        goal: stalePayloadGoal,
        message: followUp,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, followUp);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [followUp],
  );
});

test("fresh payload message replaces stale agent goal when transcript lacks active task", async () => {
  let capturedRequest: ModelRequest | undefined;
  const staleStateGoal = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const followUp = "you can use your tools to scaffold a project";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: staleStateGoal,
          interactionMode: "build",
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
        },
      },
    },
    event: {
      type: "user.message",
      payload: {
        message: followUp,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, followUp);
  assert.notEqual(input.taskInstruction, staleStateGoal);
  const transcript = input.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [followUp],
  );
});

test("mismatched collected clarification replies do not override the transcript task", async () => {
  let capturedRequest: ModelRequest | undefined;
  const currentGoal = "Review the current session state.";
  const buildRequest = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const earlierReply = "lets do Vite instead of Nextjs... SQLite db via prisma is fine";
  const laterReply = "Actually just explain what happened.";
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-1",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {
          goal: "Stale legacy task",
          modelTranscript: transcriptForTask(currentGoal),
          interactionMode: "build",
          lastActionResult: {
            ok: true,
            kind: "user_reply",
            status: "received",
            responseEventType: "user.reply",
            resumeGoal: buildRequest,
            responsePayload: {
              message: earlierReply,
            },
          },
        },
      },
    },
    event: {
      type: "user.reply",
      payload: {
        message: laterReply,
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Continue?",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.ok(capturedRequest);
  const input = capturedRequest.input as Record<string, unknown>;
  assert.equal(input.taskInstruction, currentGoal);
});

test("build full-auto submode reaches deliberator model request metadata", async () => {
  const requests: ModelRequest[] = [];
  const transition = await buildStep()({
    ...context(),
    session: {
      sessionId: "session-full-auto",
      state: {
        runtime: { schemaVersion: 1 },
        agent: {},
      },
    },
    event: {
      type: "job.run",
      payload: {
        message: "Fix the benchmark task.",
        interactionMode: "build",
        actSubmode: "full_auto",
      },
    },
  } as unknown as StepContext, {
    useModel: async (request) => {
      requests.push(request);
      return modelResponse({
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "Done.",
        },
        reason: "Test response.",
      });
    },
  } as StepIO);

  assert.equal(transition.status, "RUNNING");
  const actionRequest = requests.find((request) => request.metadata?.phase === "agent.loop");
  assert.equal(actionRequest?.metadata?.interactionMode, "build");
  assert.equal(actionRequest?.metadata?.actSubmode, "full_auto");
});

test("compileIntent rejects removed legacy finalize evidence fields", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          plan: {
            intent: "Finalize the grounded newsletter work.",
            successCriteria: ["The structured report is verified before success."],
          },
          requiredCapabilities: ["filesystem.read"],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
            verificationSteps: ["verify:newsletter-report.json::stories"],
            expectedRepoDelta: ["newsletter-report.json"],
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "The newsletter task is complete.",
            data: {
              completionState: "implemented_and_verified",
              changedFiles: ["newsletter-report.json"],
              checksRun: ["pnpm build"],
              checksFailed: [],
            },
          },
          reason: "Legacy finalize evidence fields should be schema-invalid.",
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    (error) => {
      assert.equal((error as { code?: string }).code, "DECISION_SCHEMA_FAILED");
      return true;
    },
  );
});

test("compileIntent allows coding goal_satisfied finalization without file-backed closeout", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      plan: {
        intent: "Build the newsletter app.",
        successCriteria: ["The app is implemented and verified."],
      },
      requiredCapabilities: ["filesystem.write"],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "The research is complete.",
      },
      reason: "The research result is enough.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: true },
    },
  });

  assert.equal(compiled.action?.kind, "finalize");
});

test("compileIntent allows goal_satisfied when runtime evidence has an active verification blocker", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      plan: {
        intent: "Finalize the report.",
        successCriteria: ["The report verifier passed."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
      reason: "The report is done.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    evidenceLedger: [
      {
        id: "ev_newsletter_verification_failed",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "runtime",
        kind: "artifact_verification",
        status: "failed",
        summary: "Newsletter report verification failed.",
        target: {
          type: "artifact",
          value: "newsletter-report.json::stories",
          normalizedValue: "newsletter-report.json::stories",
        },
        facts: {
          target: "newsletter-report.json::stories",
          status: "failed",
        },
      },
    ],
  });

  assert.equal(compiled.action?.kind, "finalize");
});

test("agent loop sends native tool specs for tool-capable turns", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  await buildStep()(buildContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "Read the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.responseFormat, undefined);
  assert.equal(capturedRequest.responseSchema, undefined);
  assert.equal(capturedRequest.tools?.some((tool) => tool.name === "fs_read_text"), true);
  assert.equal(capturedRequest.tools?.some((tool) => tool.name === "kestrel_finalize"), true);
  assert.deepEqual(capturedRequest.providerOptions?.openrouter, {
    endpoint: "chat",
    toolChoice: "required",
    parallelToolCalls: true,
  });
  assert.deepEqual(capturedRequest.providerOptions?.openai, {
    toolChoice: "required",
    parallelToolCalls: true,
  });
  assert.deepEqual(capturedRequest.providerOptions?.anthropic, {
    toolChoice: "required",
    parallelToolCalls: true,
  });
});

test("agent loop disables parallel tool calls when a surfaced action requires individual approval", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "chat",
  };
  buildContext.session.state.agent = {
    interactionMode: "chat",
  };
  const approvalTool: ModelToolSpec = {
    name: "calendar.create_event",
    description: "Create a calendar event.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  };

  await buildStep({
    tools: [approvalTool],
    capabilityManifest: [{
      name: approvalTool.name,
      description: approvalTool.description,
      capabilityClasses: ["calendar.write"],
      approvalCapabilities: ["network.call", "external.confirm"],
      executionClass: "external_side_effect",
      allowedInteractionModes: ["chat", "build"],
    }],
  })(buildContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "Answer without changing the calendar.",
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "No calendar change was made.",
        },
      });
    },
  } satisfies StepIO);

  assert.equal(capturedRequest?.tools?.some((tool) => tool.name === "calendar_create_event"), true);
  assert.equal(capturedRequest?.providerOptions?.openrouter?.parallelToolCalls, false);
  assert.equal(capturedRequest?.providerOptions?.openai?.parallelToolCalls, false);
  assert.equal(capturedRequest?.providerOptions?.anthropic?.parallelToolCalls, false);
});

test("agent loop disables parallel tool calls under strict per-call approval policy", async () => {
  let capturedRequest: ModelRequest | undefined;
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    executionPolicy: {
      approvalPolicy: { strictApprovalPerCall: true },
    },
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    executionPolicy: {
      approvalPolicy: { strictApprovalPerCall: true },
    },
  };

  await buildStep()(buildContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "Read the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(capturedRequest?.providerOptions?.openrouter?.parallelToolCalls, false);
  assert.equal(capturedRequest?.providerOptions?.openai?.parallelToolCalls, false);
  assert.equal(capturedRequest?.providerOptions?.anthropic?.parallelToolCalls, false);
});

test("agent loop fails immediately when a required structured action is missing", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    lastActionResult: {
      kind: "tool",
      status: "passed",
      name: "dev.shell.run",
      toolName: "dev.shell.run",
      output: {
        status: "passed",
        text: "vite build succeeded",
      },
    },
  };
  const requests: ModelRequest[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
  })(buildContext, {
    useModel: async (request) => {
      requests.push(request);
      return modelResponse({
        reason: "The build passed, so I can report completion.",
      });
    },
  } satisfies StepIO);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.providerOptions?.openrouter?.toolChoice, "required");
  assert.equal(transition.status, "FAILED");
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const terminal = agent.terminal as Record<string, unknown>;
  const error = (agent.lastActionResult as Record<string, unknown>).error as Record<string, unknown>;
  assert.equal(terminal.reasonCode, "MODEL_REQUIRED_TOOL_CALL_MISSING");
  assert.equal(error.code, "MODEL_REQUIRED_TOOL_CALL_MISSING");
  assert.equal((error.details as Record<string, unknown>).textPresent, true);
  assert.equal(agent.retryContext, undefined);
});

test("chat direct answers use one required structured call", async () => {
  const chatContext = context();
  chatContext.event.payload = { ...chatContext.event.payload, interactionMode: "chat" };
  chatContext.session.state.agent = { interactionMode: "chat" };
  const requests: ModelRequest[] = [];

  const transition = await buildStep({ tools: [READ_TEXT_TOOL] })(chatContext, {
    useModel: async (request) => {
      requests.push(request);
      return modelResponse({
        reason: "Answer the user directly.",
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "The concise direct answer.",
        },
      });
    },
  } satisfies StepIO);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.providerOptions?.openai?.toolChoice, "required");
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const commands = ((agent.commandBatch as Record<string, unknown>).commands) as Array<Record<string, unknown>>;
  assert.equal(((commands[0]?.input as Record<string, unknown>).message), "The concise direct answer.");
});

test("required-action failure diagnostics do not retain prose as retry output", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    lastActionResult: {
      kind: "tool",
      status: "passed",
      name: "dev.shell.run",
      toolName: "dev.shell.run",
      output: {
        status: "passed",
        text: "vite build succeeded",
      },
    },
  };
  const requests: ModelRequest[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
  })(buildContext, {
    useModel: async (request) => {
      requests.push(request);
      return modelResponse({
        reason: "The work is complete.",
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const terminal = agent.terminal as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  const error = lastActionResult.error as Record<string, unknown>;
  assert.equal(requests.length, 1);
  assert.equal(transition.status, "FAILED");
  assert.equal(terminal.reasonCode, "MODEL_REQUIRED_TOOL_CALL_MISSING");
  assert.equal(error.code, "MODEL_REQUIRED_TOOL_CALL_MISSING");
  assert.equal(agent.retryContext, undefined);
  assert.equal(JSON.stringify(agent).includes("The work is complete."), false);
});

test("agent loop persists compiled decision verification for downstream finalize enforcement", async () => {
  const transition = await buildStep()(context(), {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "The task is complete with explicit runtime verification evidence.",
      requiredCapabilities: ["filesystem.read"],
      confidence: 1,
      verification: {
        actionNovelty: true,
        expectedEvidenceDelta: "low",
        verificationSteps: ["verify:newsletter-report.json::stories", "check:pnpm build"],
        expectedRepoDelta: ["newsletter-report.json"],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "The newsletter app and report are complete.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    }),
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  const agentState = (transition.statePatch as { agent?: Record<string, unknown> }).agent ?? {};
  assert.deepEqual(agentState.decisionVerification, {
    missingCapabilities: [],
    actionNovelty: true,
    expectedEvidenceDelta: "medium",
  });
});

test("agent loop sends workspace, Project, and skill pack context in the user prompt, not system messages", async () => {
  let capturedRequest: ModelRequest | undefined;
  const ctx = context();
  ctx.event.payload.workspace = {
    workspaceId: "workspace-1",
    workspaceRoot: "/repo",
    appRoot: ".",
    commands: {},
    label: "Project",
  };
  ctx.event.payload.skillPack = {
    id: "research",
    label: "Research",
    instructions: ["Prefer grounded sources."],
    allowedTools: ["internet.search"],
  };
  ctx.event.payload.projectContext = {
    projectId: "project-atlas",
    contextRevisionId: "revision-7",
    contextRevision: 7,
    content: "Project: Atlas\n\nProject instructions:\nPrefer verified sources.",
  };

  await buildStep()(ctx, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "Read the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.ok(capturedRequest);
  const systemMessages = capturedRequest.messages?.filter((message) => message.role === "system") ?? [];
  assert.equal(systemMessages.length, 1);
  assert.equal(JSON.stringify(systemMessages).includes("Prefer grounded sources."), false);
  const userMessage = capturedRequest.messages?.find((message) => message.role === "user")?.content;
  assert.equal(typeof userMessage, "string");
  assert.match(userMessage as string, /<runtime_context>/u);
  assert.match(userMessage as string, /Workspace: workspace-1 \(Project\)\./u);
  assert.match(userMessage as string, /- root: \/repo/u);
  assert.match(userMessage as string, /Project context:/u);
  assert.match(userMessage as string, /- projectId: project-atlas/u);
  assert.match(userMessage as string, /- contextRevision: 7/u);
  assert.match(userMessage as string, /Prefer verified sources\./u);
  assert.match(userMessage as string, /Skill pack: research \(Research\)\./u);
  assert.match(userMessage as string, /Prefer grounded sources\./u);
});

test("agent loop compaction prompt preserves constraint-critical tool facts", async () => {
  const requests: ModelRequest[] = [];
  const ctx = context();
  ctx.event.payload.message = "you can use your tools to continue";
  const originalTask = [
    "Older work included a zero-result search for privileged.",
    "x".repeat(130_000),
  ].join("\n");
  ctx.session.state.agent = {
    goal: "stale follow-up task",
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Missing tool call.",
        details: {
          modelFeedback: "Retry guidance: call a concrete tool.",
        },
        schemaCategory: "tool_call",
      },
    },
    modelTranscript: {
      version: 1,
      windowId: 1,
      items: [
        {
          id: "mt_1_0001_user",
          createdAt: "2026-06-15T12:00:00.000Z",
          kind: "user",
          content: originalTask,
        },
      ],
    },
  };

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
  })(ctx, {
    useModel: async (request) => {
      requests.push(request);
      if (request.metadata?.phase === "agent.compaction") {
        return {
          output: "Summary preserves the zero-result search and current blocker.",
          text: "Summary preserves the zero-result search and current blocker.",
        } as ModelResponse<unknown>;
      }
      return modelResponse({
        reason: "Read the requested file after compaction.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  const compactionRequest = requests.find((request) => request.metadata?.phase === "agent.compaction");
  assert.ok(compactionRequest);
  assert.equal((compactionRequest.input as Record<string, unknown>).taskInstruction, originalTask);
  const systemContent = compactionRequest.messages?.find((message) => message.role === "system")?.content;
  assert.equal(typeof systemContent, "string");
  assert.match(
    systemContent as string,
    /Preserve constraint facts, zero-result searches, the chronologically latest successful or failed tool results, exact mutation summaries, open todos, and current blockers/u,
  );
  const finalRequest = requests.find((request) => request.metadata?.phase === "agent.loop");
  assert.ok(finalRequest);
  assert.match(JSON.stringify(finalRequest.messages), /Retry guidance: call a concrete tool/u);
  const agentPatch = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(readActiveTaskGoalFromTranscript(agentPatch.modelTranscript), originalTask);
});

test("agent loop exposes mission control context and accepts proactive task proposal", async () => {
  let capturedRequest: ModelRequest | undefined;
  const ctx = context();
  const executionPolicy = taskQueueWriteAllowedPolicy();
  ctx.event.payload = {
    message: "Track these follow-ups: fix auth callback and add regression tests.",
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.agent = {
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.product = {
    projectSnapshot: projectSnapshotFixture(),
  };

  const transition = await buildStep({
    tools: [PROJECT_TASK_PROPOSE_TOOL],
    capabilityManifest: projectTaskQueueCapabilityManifest(),
  })(ctx, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "Capture the durable auth follow-up as a proposed task.",
        nextAction: {
          kind: "tool",
          name: "task.propose",
          input: {
            sessionId: "project-session-1",
            title: "Fix auth callback",
            instructions: "Repair the auth callback regression and verify login succeeds with a regression test.",
            summary: "The user asked to track auth follow-up work.",
          },
        },
      });
    },
  } satisfies StepIO);

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.tools?.some((tool) => tool.name === "task_propose"), true);
  const renderedMessages = JSON.stringify(capturedRequest.messages);
  assert.match(renderedMessages, /Mission Control task queue/u);
  assert.match(renderedMessages, /sessionId: project-session-1/u);
  assert.match(renderedMessages, /task\.propose/u);
  assert.match(renderedMessages, /avoid duplicates/u);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "tool",
    name: "task.propose",
    input: {
      sessionId: "project-session-1",
      title: "Fix auth callback",
      instructions: "Repair the auth callback regression and verify login succeeds with a regression test.",
      summary: "The user asked to track auth follow-up work.",
    },
  });
});

test("agent loop accepts split task capture as multiple focused proposals", async () => {
  const ctx = context();
  const executionPolicy = taskQueueWriteAllowedPolicy();
  ctx.event.payload = {
    message: "Split this into tasks: fix auth and add regression tests.",
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.agent = {
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.product = {
    projectSnapshot: projectSnapshotFixture(),
  };

  const transition = await buildStep({
    tools: [PROJECT_TASK_PROPOSE_TOOL],
    capabilityManifest: projectTaskQueueCapabilityManifest(),
  })(ctx, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Create focused task proposals for the two durable follow-ups.",
      nextAction: {
        kind: "tool_batch",
        items: [
          {
            name: "task.propose",
            input: {
              sessionId: "project-session-1",
              title: "Fix auth callback",
              instructions: "Repair the auth callback regression and verify login succeeds.",
              summary: "Implementation follow-up from the split request.",
            },
          },
          {
            name: "task.propose",
            input: {
              sessionId: "project-session-1",
              title: "Add auth regression tests",
              instructions: "Add regression coverage for the auth callback path and verify the test fails before the fix or covers the repaired behavior.",
              summary: "Validation follow-up from the split request.",
            },
          },
        ],
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const commandBatch = agent.commandBatch as Record<string, unknown>;
  const commands = commandBatch.commands as Array<Record<string, unknown>>;
  const aggregateInput = commands[0]?.input as Record<string, unknown> | undefined;
  const aggregateItems = aggregateInput?.items as Array<Record<string, unknown>> | undefined;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "tool_batch");
  assert.equal(aggregateItems?.length, 2);
  assert.equal(aggregateItems?.[0]?.name, "task.propose");
  assert.equal(aggregateItems?.[1]?.name, "task.propose");
  assert.match(JSON.stringify(aggregateItems?.[0]?.input), /Fix auth callback/u);
  assert.match(JSON.stringify(aggregateItems?.[1]?.input), /Add auth regression tests/u);
});

test("agent loop supplies existing matching tasks so duplicate proposal can be skipped", async () => {
  let capturedRequest: ModelRequest | undefined;
  const ctx = context();
  const executionPolicy = taskQueueWriteAllowedPolicy();
  ctx.event.payload = {
    message: "Track the auth regression test follow-up.",
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.agent = {
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.product = {
    projectSnapshot: projectSnapshotFixture({
      cards: {
        "T-7": {
          id: "T-7",
          title: "Add auth regression tests",
          instructions: "Add coverage for the auth callback regression and verify login succeeds.",
          status: "proposed",
          priority: "medium",
          order: 1,
          evidence: [
            {
              id: "evidence-7",
              timestamp: "2026-06-15T12:00:00.000Z",
              source: "agent",
              summary: "Captured from prior conversation.",
            },
          ],
        },
      },
    }),
  };

  const transition = await buildStep({
    tools: [PROJECT_TASK_PROPOSE_TOOL],
    capabilityManifest: projectTaskQueueCapabilityManifest(),
  })(ctx, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "The existing proposed task already covers the requested follow-up.",
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "T-7 already tracks the auth regression test follow-up, so I did not propose a duplicate task.",
        },
      });
    },
  } satisfies StepIO);

  assert.ok(capturedRequest);
  const renderedMessages = JSON.stringify(capturedRequest.messages);
  assert.match(renderedMessages, /T-7 Add auth regression tests/u);
  assert.match(renderedMessages, /Captured from prior conversation/u);
  assert.match(renderedMessages, /avoid duplicates/u);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const commandBatch = agent.commandBatch as Record<string, unknown>;
  const commands = commandBatch.commands as Array<Record<string, unknown>>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "finalize");
  assert.doesNotMatch(JSON.stringify(commandBatch), /task\.propose/u);
});

test("agent loop omits mission control context when the turn has no project snapshot", async () => {
  let capturedRequest: ModelRequest | undefined;
  const ctx = context();
  const executionPolicy = taskQueueWriteAllowedPolicy();
  ctx.event.payload = {
    message: "Track the auth regression test follow-up.",
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };
  ctx.session.state.agent = {
    interactionMode: "chat",
    modeSystemV2Enabled: true,
    executionPolicy,
  };

  await buildStep({
    tools: [PROJECT_TASK_PROPOSE_TOOL],
    capabilityManifest: projectTaskQueueCapabilityManifest(),
  })(ctx, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        reason: "No task queue context is available.",
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "No task queue is active for this turn.",
        },
      });
    },
  } satisfies StepIO);

  assert.ok(capturedRequest);
  assert.equal(Object.hasOwn(capturedRequest.input as Record<string, unknown>, "projectTaskQueueContext"), false);
  assert.doesNotMatch(JSON.stringify(capturedRequest.messages), /Mission Control task queue/u);
});

test("agent loop commits a valid first action directly to exec dispatch", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Read the requested file.",
      visibleTodos: {
        objective: "Handle the requested test task.",
        items: [
          {
            id: "read-file-readme-md",
            text: "Read file: README.md",
            status: "in_progress",
          },
        ],
      },
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: { path: "README.md" },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "README.md" },
  });
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(agent.visibleTodos, {
    objective: "Handle the requested test task.",
    items: [
      {
        id: "read-file-readme-md",
        text: "Read file: README.md",
        status: "in_progress",
      },
    ],
  });
  assert.equal(agent.decisionReason, "Read the requested file.");
  assert.equal(
    (agent.commandBatch as Record<string, unknown>).planningSummary,
    "Read the requested file.",
  );
  assert.equal(Object.hasOwn(transition, "reasoningHint"), false);
  for (const key of [
    "capabilityEvidence",
    "toolIntent",
    "compiledIntent",
    "workPlan",
  ]) {
    assert.equal(Object.hasOwn(agent, key), false);
  }
});

test("agent loop preserves model text reason from native tool-call responses", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      understanding: {
        task: "Read a file.",
        facts: ["The request asks for README.md."],
        currentGap: "The file contents still need to be read.",
        actionBasis: "Reading README.md is the next concrete evidence step.",
      },
      reason: "Read README.md before answering from memory.",
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: { path: "README.md" },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(agent.decisionReason, "Read README.md before answering from memory.");
  assert.equal(
    (agent.commandBatch as Record<string, unknown>).planningSummary,
    "Read README.md before answering from memory.",
  );
});

test("agent loop routes premature visible-todo finalization back to open work", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Build static newsletter artifacts.",
  };
  buildContext.session.state.evidenceLedger = [successfulReadInputTexEvidence()];
  buildContext.session.state.agent = {
    interactionMode: "build",
    goal: "Stale follow-up.",
    modelTranscript: appendUserTurnToTranscript({
      transcript: undefined,
      message: "Build static newsletter artifacts.",
      stepIndex: 1,
    }),
    visibleTodos: {
      objective: "Build static newsletter artifacts.",
      items: [
        {
          id: "write-newsletter-report-json",
          text: "Write file: newsletter-report.json",
          status: "in_progress",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      understanding: {
        task: "Build static newsletter artifacts.",
        facts: ["newsletter-report.json still needs to be written."],
        currentGap: "The visible work item remains open.",
        actionBasis: "The model incorrectly attempted to finish.",
      },
      reason: "I should be done.",
      visibleTodos: {
        objective: "Build static newsletter artifacts.",
        items: [
          {
            id: "write-newsletter-report-json",
            text: "Write file: newsletter-report.json",
            status: "in_progress",
          },
        ],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(agent.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agent.modelTranscript), "Build static newsletter artifacts.");
  assert.equal(agent.commandBatch, undefined);
  assert.match(String(agent.decisionReason), /Still open: Write file: newsletter-report\.json/u);
  assert.match(String(agent.decisionReason), /kestrel_todo_update/u);
  assert.match(String(agent.decisionReason), /write-newsletter-report-json' marked done/u);
  assert.match(String(agent.decisionReason), /observed validation result/u);
  assert.match(String(agent.decisionReason), /kestrel_finalize/u);
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  assert.equal(retryContext.loopAttempt, undefined);
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(failure.schemaCategory, "visible_todos");
  assert.equal(details.reason, "visible_todo_finalize_continuation");
  assert.equal(details.openVisibleTodoItemId, "write-newsletter-report-json");
  assert.equal(details.openVisibleTodoItemText, "Write file: newsletter-report.json");
  assert.equal(details.openVisibleTodoItemStatus, "in_progress");
  assert.equal((agent.lastActionResult as Record<string, unknown> | undefined)?.kind, undefined);
});

test("agent loop accepts visible todo closure with finalization in one model turn", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Build static newsletter artifacts.",
  };
  buildContext.session.state.evidenceLedger = [successfulReadInputTexEvidence()];
  buildContext.session.state.agent = {
    interactionMode: "build",
    visibleTodos: {
      objective: "Build static newsletter artifacts.",
      items: [
        {
          id: "write-newsletter-report-json",
          text: "Write file: newsletter-report.json",
          status: "in_progress",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      understanding: {
        task: "Build static newsletter artifacts.",
        facts: ["newsletter-report.json was written and verified."],
        currentGap: "The visible work item needs to be closed before finalizing.",
        actionBasis: "The evidence proves the visible item is done.",
      },
      reason: "Close the completed visible todo and finalize.",
      visibleTodos: {
        objective: "Build static newsletter artifacts.",
        items: [
          {
            id: "write-newsletter-report-json",
            text: "Write file: newsletter-report.json",
            status: "done",
          },
        ],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const visibleTodos = agent.visibleTodos as Record<string, unknown>;
  const items = visibleTodos.items as Record<string, unknown>[];

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: {
      message: "Done.",
    },
  });
  assert.equal(items[0]?.status, "done");
  assert.equal(agent.retryContext, undefined);
});

test("agent loop accepts documented residual gap finalization without another reasoning loop", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Build static newsletter artifacts.",
  };
  buildContext.session.state = {
    runtime: { schemaVersion: 1 },
    evidenceLedger: [
      {
        ...successfulFileMutationEvidence()[0],
        stepIndex: 1,
      },
      {
        id: "ev-browser-e2e-failed",
        version: "v1",
        createdAt: "2026-06-15T00:00:02.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "process_result",
        status: "failed",
        summary: "Browser E2E could not be completed.",
        target: { type: "tool", value: "exec_command" },
        facts: {
          toolName: "exec_command",
          command: "pnpm run test:browser",
          exitCode: 1,
        },
      },
    ],
    agent: {
      interactionMode: "build",
      visibleTodos: {
        objective: "Build static newsletter artifacts.",
        items: [
          {
            id: "write-newsletter-report-json",
            text: "Write file: newsletter-report.json",
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
      lastActionResult: {
        kind: "tool",
        status: "ok",
        toolName: "dev.shell.run",
      },
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      understanding: {
        task: "Build static newsletter artifacts.",
        facts: ["The file was written and validation passed."],
        currentGap: "Browser E2E was not directly exercised.",
        actionBasis: "The remaining gap is documented as residual risk.",
      },
      reason: "Finalize with the documented residual risk.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done. Browser E2E was not directly exercised.",
        data: {
          openGap: "Browser E2E was not directly exercised.",
          residualTodoIds: ["browser-e2e"],
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const visibleTodos = agent.visibleTodos as Record<string, unknown>;
  const items = visibleTodos.items as Record<string, unknown>[];

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(items[1]?.status, "blocked");
  assert.equal(items[1]?.note, "Browser E2E was not directly exercised.");
  assert.deepEqual(agent.nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: {
      message: "Done. Browser E2E was not directly exercised.",
      data: {
        openGap: "Browser E2E was not directly exercised.",
        residualTodoIds: ["browser-e2e"],
      },
    },
  });
  assert.equal(agent.retryContext, undefined);
});

test("agent loop rejects same-turn todo closure after file mutation because a note is not validation evidence", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Build static newsletter artifacts.",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: successfulFileMutationEvidence(),
    visibleTodos: {
      objective: "Build static newsletter artifacts.",
      items: [
        {
          id: "write-newsletter-report-json",
          text: "Write file: newsletter-report.json",
          status: "in_progress",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "Close the completed visible todo and finalize.",
      visibleTodos: {
        objective: "Build static newsletter artifacts.",
        items: [
          {
            id: "write-newsletter-report-json",
            text: "Write file: newsletter-report.json",
            status: "done",
            note: "Read back newsletter-report.json and confirmed it contains the requested stories.",
          },
        ],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.match(String(agent.decisionReason), /latest workspace mutation has no later current-state validation evidence/u);
});

test("agent loop accepts finalization when a shell-changed file is read after the mutation", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Constrained edit input.tex.",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: [
      successfulReadInputTexEvidence("ev-read-before", 1),
      successfulShellChangedFilesEvidence(["input.tex"], "ev-shell-changed", 2),
      successfulReadInputTexEvidence("ev-read-after", 3),
    ],
    visibleTodos: {
      objective: "Constrained edit input.tex.",
      items: [
        {
          id: "check-constrained-edit",
          text: "Check constrained edit result",
          status: "done",
          note: "Read input.tex after the final edit and confirmed the requested final state.",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "The constrained edit comparison passed, so finalize.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: {
      message: "Done.",
    },
  });
  assert.equal(agent.retryContext, undefined);
});

test("agent loop rejects finalization when shell changes a generated file that was not later validated", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Generate report.",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: [
      successfulShellChangedFilesEvidence(["report.json"], "ev-shell-changed", 2),
    ],
    visibleTodos: {
      objective: "Generate report.",
      items: [
        {
          id: "check-report",
          text: "Check report",
          status: "done",
          note: "Command completed and produced report.json.",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "The report exists, so finalize.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.match(String(agent.decisionReason), /latest workspace mutation has no later current-state validation evidence/u);
});

test("agent loop rejects finalization after token-changing replace_text when only a todo note claims validation", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Constrained edit input.tex.",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: successfulTokenChangingReplaceTextEvidence(),
    visibleTodos: {
      objective: "Constrained edit input.tex.",
      items: [
        {
          id: "check-constrained-edit",
          text: "Check constrained edit result",
          status: "done",
          note: "Read back input.tex and compared token count against the original; token count changed by -1 and every changed token was allowed.",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "The constrained edit comparison passed, so finalize.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.match(String(agent.decisionReason), /latest workspace mutation has no later current-state validation evidence/u);
});

test("agent loop rejects finalization after token-preserving replace_text when only a todo note claims validation", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
    message: "Constrained edit input.tex.",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: successfulTokenPreservingReplaceTextEvidence(),
    visibleTodos: {
      objective: "Constrained edit input.tex.",
      items: [
        {
          id: "check-constrained-edit",
          text: "Check constrained edit result",
          status: "done",
          note: "pdflatex exited 0 and no overfull hbox warnings remained.",
        },
      ],
    },
  };

  const transition = await buildStep({ tools: [WRITE_TEXT_TOOL] })(buildContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "The LaTeX check passed and replacement was token-preserving, so finalize.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.match(String(agent.decisionReason), /latest workspace mutation has no later current-state validation evidence/u);
});

test("agent loop accepts deliberator output without understanding", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
        version: "v1",
        reason: "Read the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(agent.nextAction, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "README.md" },
  });
});

test("agent loop retries invalid handoff continuation with targeted compact handoff guidance", async () => {
  const retryingContext = context();
  retryingContext.event.payload = {
    message: "Lets start the build.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  retryingContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    plan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
  };

  let requestCount = 0;
  const transition = await buildStep()(retryingContext, {
    useModel: async (request: ModelRequest) => {
      requestCount += 1;
      void request;
      return modelResponse({
        version: "v1",
        understanding: {
          task: "Start the approved build handoff.",
          facts: ["The session plan document already exists."],
          currentGap: "The build handoff continuation is malformed.",
          actionBasis: "Retry with the correct compact handoff shape.",
        },
        reason: "The plan is ready for build handoff.",
        nextAction: {
          kind: "handoff_to_build",
          message: "I can build this next.",
          continuation: {
            requiredCapabilities: ["workspace.write"],
          },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  assert.equal(requestCount, 1);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(details.reason, "invalid_control_tool_input");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(details.path, "toolCalls[0].input.continuation");
});

test("agent loop allows repeated broad filesystem inventory for runtime reuse", async () => {
  const inventoryContext = context();
  inventoryContext.event.payload = {
    ...inventoryContext.event.payload,
    interactionMode: "build",
  };
  let capturedRequest: ModelRequest | undefined;
  inventoryContext.session.state.agent = {
    interactionMode: "build",
    lastAction: {
      kind: "tool",
      name: "fs.list",
      input: { path: ".", recursive: true, includeHidden: true, maxDepth: 3 },
    },
    lastActionResult: {
      kind: "tool",
      name: "fs.list",
      status: "succeeded",
      input: { path: ".", recursive: true, includeHidden: true, maxDepth: 3 },
      output: {
        entries: [
          { path: ".git", type: "directory" },
          { path: ".kestrel", type: "directory" },
        ],
      },
    },
  };

  const transition = await buildStep({
    tools: [LIST_TOOL, WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.list",
        description: "List files",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(inventoryContext, {
    useModel: async (request) => {
      capturedRequest = request;
      return modelResponse({
        version: "v1",
        understanding: {
          task: "Build the requested app.",
          facts: ["The previous broad fs.list already succeeded and returned only .git and .kestrel."],
          currentGap: "No app files have been created yet.",
          actionBasis: "Repeating the same inventory would not create or verify the app.",
        },
        reason: "The workspace inventory should be repeated.",
        nextAction: {
          kind: "tool",
          name: "fs.list",
          input: { path: ".", recursive: true, includeHidden: true, maxDepth: 3 },
        },
      });
    },
  } satisfies StepIO);

  const modelInput = capturedRequest?.input as Record<string, unknown> | undefined;
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(Object.hasOwn(modelInput ?? {}, "supportingFacts"), false);
  assert.equal(Object.hasOwn(modelInput ?? {}, "currentTurnSummary"), false);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal((agent.nextAction as Record<string, unknown> | undefined)?.name, "fs.list");
  assert.equal(agent.retryContext, undefined);
});

test("agent loop dispatches repeated cached fs.read_text", async () => {
  const repeatContext = context();
  repeatContext.event.payload = {
    message: "continue",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  repeatContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
    evidenceLedger: [
      {
        id: "ev_read_page",
        version: "v1",
        createdAt: "2026-05-29T12:44:00.000Z",
        stepIndex: 12,
        source: "tool",
        kind: "file_content",
        status: "passed",
        summary: "Read src/app/page.tsx.",
        target: {
          type: "path",
          value: "src/app/page.tsx",
          normalizedValue: "src/app/page.tsx",
        },
        facts: {
          toolName: "fs.read_text",
          inputPath: "src/app/page.tsx",
          outputPath: "src/app/page.tsx",
        },
        raw: {
          hash: "content-hash-page",
          bytes: 128,
        },
      },
    ],
  };

  const transition = await buildStep()(repeatContext, {
    useModel: async () => modelResponse({
      version: "v2",
      reason: "Read the page again before deciding the next edit.",
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: "./src/app/page.tsx",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal((agent.nextAction as Record<string, unknown>).name, "fs.read_text");
  assert.equal(agent.retryContext, undefined);
});

test("agent loop rejects repeated failed shell action before engine loop guard", async () => {
  const shellContext = context();
  const shellRoot = process.cwd();
  shellContext.event.payload = {
    message: "Build the app.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  shellContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
    lastAction: {
      kind: "tool",
      name: "exec_command",
      input: {
        command: "npm run lint",
        cwd: shellRoot,
        workspaceRoot: shellRoot,
      },
    },
    lastActionResult: {
      ok: false,
      kind: "tool",
      name: "exec_command",
      toolName: "exec_command",
      status: "failed",
      input: {
        command: "npm run lint",
        cwd: shellRoot,
        workspaceRoot: shellRoot,
      },
      inputHash: "failed-lint-root",
      error: {
        code: "ENOENT",
        message: "Could not read package.json.",
      },
      outputSummary: "npm ERR! enoent Could not read package.json",
    },
  };

  const transition = await buildStep({
    tools: [EXEC_COMMAND_TOOL],
    capabilityManifest: [
      {
        name: "exec_command",
        description: "Run a command",
        capabilityClasses: ["dev.shell"],
        executionClass: "sandboxed_only",
      },
    ],
  })(shellContext, {
    useModel: async () => modelResponse({
      version: "v1",
      understanding: {
        task: "Build the app.",
        facts: ["The prior lint command failed."],
        currentGap: "Validation has not passed.",
        actionBasis: "Try lint again.",
      },
      reason: "Retry the same command.",
      nextAction: {
        kind: "tool",
        name: "exec_command",
        input: {
          command: "npm run lint",
          cwd: shellRoot,
          workspaceRoot: shellRoot,
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  const previousFailure = details.previousFailure as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(details.reason, "repeated_failed_action_without_repair");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(previousFailure.errorCode, "ENOENT");
  assert.match(String(previousFailure.outputSummary), /package\.json/u);
});

test("agent loop rejects repeated mixed batch when one item failed", async () => {
  const shellContext = context();
  const shellRoot = process.cwd();
  const repeatedBatch = {
    kind: "tool_batch",
    items: [
      {
        name: "fs.read_text",
        input: { path: "package.json" },
      },
      {
        name: "exec_command",
        input: {
          command: "npm run test",
          cwd: shellRoot,
          workspaceRoot: shellRoot,
        },
      },
    ],
  };
  shellContext.event.payload = {
    message: "Build the app.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  shellContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
    lastAction: repeatedBatch,
    lastActionResult: {
      ok: true,
      kind: "tool_batch",
      status: "ok",
      items: [
        {
          name: "fs.read_text",
          inputHash: "read-ok",
          output: { content: "{}" },
        },
        {
          name: "exec_command",
          inputHash: "run-failed",
          output: {
            status: "FAILED",
            errorCode: "COMMAND_FAILED",
            message: "Tests failed.",
          },
        },
      ],
    },
  };

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL, EXEC_COMMAND_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
      {
        name: "exec_command",
        description: "Run a command",
        capabilityClasses: ["dev.shell"],
        executionClass: "sandboxed_only",
      },
    ],
  })(shellContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Retry the same batch.",
      nextAction: repeatedBatch,
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  const previousFailure = details.previousFailure as Record<string, unknown>;
  const failedBatchItems = previousFailure.failedBatchItems as Record<string, unknown>[];
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(details.reason, "repeated_failed_action_without_repair");
  assert.equal(failedBatchItems[0]?.itemIndex, 1);
  assert.equal(failedBatchItems[0]?.toolName, "exec_command");
  assert.equal(failedBatchItems[0]?.errorCode, "COMMAND_FAILED");
});

test("agent loop compiles handoff_to_build without persisting legacy continuation offer state", async () => {
  const planContext = context();
  planContext.session.state.agent = {
    ...(planContext.session.state.agent as Record<string, unknown>),
    interactionMode: "plan",
    plan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
  };
  const transition = await buildStep()(planContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The current response is a plan handoff.",
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next.",
        continuation: continuationOffer(),
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(agent.pendingContinuationOffer, undefined);
  assert.deepEqual(agent.nextAction, {
    kind: "handoff_to_build",
    message: "I can build this next.",
    continuation: continuationOffer(),
      });
});

test("agent loop accepts plan handoff when the live turn is plan mode even if agent state omits the mode", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "The plan is ready. Hand off to build.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    modeSystemV2Enabled: true,
    plan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
  };

  const transition = await buildStep()(planContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The plan is complete and ready for implementation handoff.",
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next.",
        continuation: continuationOffer(),
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(agent.nextAction, {
    kind: "handoff_to_build",
    message: "I can build this next.",
    continuation: continuationOffer(),
      });
});

test("agent loop feeds missing plan document handoff back as planning write correction", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "The plan is ready. Hand off to build.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    modeSystemV2Enabled: true,
  };

  const transition = await buildStep()(planContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The plan is complete and ready for implementation handoff.",
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next.",
        continuation: continuationOffer(),
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  const requiredCorrection = retryContext.requiredCorrection as Record<string, unknown>;
  const handoffCorrection = requiredCorrection.planDocumentBeforeHandoff as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(details.requiredAction, "write_session_plan_before_handoff");
  assert.equal(handoffCorrection.action, "write_session_plan_before_handoff");
  assert.equal(handoffCorrection.requiredTool, "planning.write_document");
  assert.equal(handoffCorrection.requiredModelTool, "planning_write_document");
  assert.equal(handoffCorrection.forbiddenActionUntilPlanExists, "kestrel_handoff_to_build");
});

test("agent loop preserves live plan mode across deliberator retry before accepting plan handoff", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "The plan is ready. Hand off to build.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    modeSystemV2Enabled: true,
    plan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
  };

  let modelCallCount = 0;
  const transition = await buildStep()(planContext, {
    useModel: async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return modelResponse({
          version: "v1",
          reason: "Give the handoff as internal narration first.",
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "The next move is to hand this plan off for implementation.",
          },
        });
      }
      return modelResponse({
        version: "v1",
        reason: "The plan is complete and ready for implementation handoff.",
        nextAction: {
          kind: "handoff_to_build",
          message: "I can build this next.",
          continuation: continuationOffer(),
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(modelCallCount, 2);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(agent.nextAction, {
    kind: "handoff_to_build",
    message: "I can build this next.",
    continuation: continuationOffer(),
      });
});

test("agent loop assembles execution-ready fresh-app plan prompts and accepts plan handoff", async () => {
  const planContext = context();
  planContext.event.payload = {
    message:
      "This is a fresh Next.js app. Use NextAuth, Prisma, and SQLite. Reasonable defaults are fine. Lets start the build.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    plan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: [
        "# Plan",
        "",
        "- Build a fresh Next.js app.",
        "- Use NextAuth, Prisma, and SQLite.",
        "- Reasonable defaults are allowed.",
      ].join("\n"),
    },
  };

  let modelInput: Record<string, unknown> | undefined;
  let systemPrompt = "";
  let userPrompt = "";
  let allUserPrompt = "";
  let runtimePrompt = "";
  const transition = await buildStep()(planContext, {
    useModel: async (request: ModelRequest) => {
      modelInput = request.input as Record<string, unknown>;
      for (const message of request.messages ?? []) {
        if (message.role === "system" && typeof message.content === "string") {
          systemPrompt = message.content;
        }
        if (message.role === "user" && typeof message.content === "string") {
          userPrompt = message.content;
          allUserPrompt = [allUserPrompt, message.content].filter((item) => item.length > 0).join("\n\n");
          if (message.content.includes("<runtime_context>")) {
            runtimePrompt = message.content;
          }
        }
      }
      return modelResponse({
        version: "v1",
        reason: "The build request is execution-ready and the active session plan document exists.",
        nextAction: {
          kind: "handoff_to_build",
          message: "I can build this next with a fresh Next.js app using NextAuth, Prisma, and SQLite.",
          continuation: {
            version: "continuation_offer_v1",
            kind: "implementation",
            objective: "Build a fresh Next.js app with NextAuth, Prisma, and SQLite.",
            requiredToolClass: "sandboxed_only",
            requiredCapabilities: ["workspace.write"],
            requiredMode: "build",
            sourceRunId: "run-1",
            resumeMessage: "Lets start the build.",
          },
          data: {
            proposedNextAction: "Scaffold the fresh Next.js app and wire NextAuth, Prisma, and SQLite.",
          },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(modelInput?.interactionMode, "plan");
  assert.equal(
    modelInput?.taskInstruction,
    "This is a fresh Next.js app. Use NextAuth, Prisma, and SQLite. Reasonable defaults are fine. Lets start the build.",
  );
  assert.equal(modelInput?.latestUserTurn, undefined);
  assert.match(
    systemPrompt,
    /For software build requests, once stack, scope, and defaults are clear enough for the next implementation pass, write the session plan document before choosing `handoff_to_build`\./u,
  );
  assert.match(
    systemPrompt,
    /Reserve finalize status goal_satisfied for true conversational or current task status answers, not execution-ready build requests\./u,
  );
  assert.match(
    systemPrompt,
    /Treat follow-ups such as "let's start the build", "lets start the build", "go ahead", or similar implementation prompts as a request to proceed with the already-agreed build pass/u,
  );
  assert.equal(typeof runtimePrompt, "string");
  assert.match(allUserPrompt, /This is a fresh Next\.js app\. Use NextAuth, Prisma, and SQLite\./u);
  assert.doesNotMatch(userPrompt, /<decision_controls_json>/u);
  assert.match(runtimePrompt, /Mode:\n- event: user\.message\n- interaction: plan/u);
  assert.deepEqual(agent.nextAction, {
    kind: "handoff_to_build",
    message: "I can build this next with a fresh Next.js app using NextAuth, Prisma, and SQLite.",
    continuation: {
      version: "continuation_offer_v1",
      kind: "implementation",
      objective: "Build a fresh Next.js app with NextAuth, Prisma, and SQLite.",
      requiredToolClass: "sandboxed_only",
      requiredCapabilities: ["workspace.write"],
      requiredMode: "build",
      sourceRunId: "run-1",
      resumeMessage: "Lets start the build.",
    },
    data: {
      proposedNextAction: "Scaffold the fresh Next.js app and wire NextAuth, Prisma, and SQLite.",
    },
  });
});

test("agent loop prompts for Build mode when accepting a pending implementation offer in plan mode", async () => {
  const acceptanceContext = context();
  acceptanceContext.event = {
    id: "evt-accept-plan",
    type: "user.reply",
    sessionId: "session-1",
    payload: {
      message: "confirmed",
      interactionMode: "plan",
      modeSystemV2Enabled: true,
    },
  };
  acceptanceContext.session.state.agent = {
    goal: "switch to build",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    modelTranscript: appendUserTurnToTranscript({
      transcript: undefined,
      message: "Create a Python Pong game.",
      stepIndex: 1,
    }),
    decisionReason: "Stale reason from the prior accepted plan.",
    activeContinuation: runtimeContinuation(),
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
    visibleTodos: {
      objective: "Create a Python Pong game.",
      items: [
        {
          id: "write-pong",
          text: "Write the Pong implementation file",
          status: "in_progress",
        },
        {
          id: "check-pong",
          text: "Check the Pong implementation",
          status: "pending",
        },
      ],
    },
    waitingFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "continuation_handoff",
        continuationId: "continuation:run-1",
      },
    },
    nextAction: {
      kind: "ask_user",
      prompt: "I can build this next.",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "continuation_handoff",
          continuationId: "continuation:run-1",
        },
      },
    },
  };

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL, WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(acceptanceContext, {
    useModel: async () => {
      throw new Error("model should not be called before mode escalation");
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const waitFor = nextAction.waitFor as Record<string, unknown>;
  const metadata = waitFor.metadata as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agent.modelTranscript), "Create a Python Pong game.");
  assert.equal(nextAction.kind, "ask_user");
  assert.equal(metadata.reason, "planner_mode_blocked");
  assert.equal(metadata.requiredToolClass, "sandboxed_only");
  assert.equal(metadata.currentMode, "Plan");
  assert.equal(metadata.requiredMode, "Build");
  assert.equal(
    agent.decisionReason,
    "The selected continuation offer requires Build, but the run is currently in Plan.",
  );
});

test("agent loop mode-blocked transition does not restamp stale goal when transcript lacks a task", async () => {
  const acceptanceContext = context();
  acceptanceContext.event = {
    id: "evt-accept-plan",
    type: "user.reply",
    sessionId: "session-1",
    payload: {
      message: "confirmed",
      interactionMode: "plan",
      modeSystemV2Enabled: true,
    },
  };
  acceptanceContext.session.state.agent = {
    goal: "Stale legacy task",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
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
    activeContinuation: runtimeContinuation(),
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
    waitingFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "continuation_handoff",
        continuationId: "continuation:run-1",
      },
    },
    nextAction: {
      kind: "ask_user",
      prompt: "I can build this next.",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "continuation_handoff",
          continuationId: "continuation:run-1",
        },
      },
    },
  };

  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(acceptanceContext, {
    useModel: async () => {
      throw new Error("model should not be called before mode escalation");
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const waitFor = nextAction.waitFor as Record<string, unknown>;
  const metadata = waitFor.metadata as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.goal, undefined);
  assert.equal(readActiveTaskGoalFromTranscript(agent.modelTranscript), undefined);
  assert.equal(metadata.reason, "planner_mode_blocked");
});

test("agent loop repairs missing assistantProgress within the bounded deliberator retry", async () => {
  let modelCallCount = 0;
  let retryRequest: ModelRequest | undefined;
  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  })(context(), {
    useModel: async (request: ModelRequest) => {
      modelCallCount += 1;
      if (modelCallCount === 2) {
        retryRequest = request;
      }
      return {
        output: {
          understanding: {
            task: "Inspect the workspace.",
            facts: ["The workspace has not been inspected yet."],
            currentGap: "The package metadata must be read.",
            actionBasis: "Reading package.json is the next concrete step.",
          },
          reason: "Read the package metadata.",
        },
        text: "Read the package metadata.",
        toolIntents: [
          {
            name: "fs_read_text",
            input: {
              path: "package.json",
              ...(modelCallCount === 1
                ? {}
                : { assistantProgress: "I’m reading the package metadata now." }),
            },
          },
        ],
        provider: {
          name: "openai",
          model: "test/agent",
          endpoint: "chat",
        },
      } satisfies ModelResponse<unknown>;
    },
  } satisfies StepIO);

  assert.equal(modelCallCount, 2);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  const retryMessages = JSON.stringify(retryRequest?.messages);
  assert.match(retryMessages, /invalid_assistant_progress/u);
  assert.match(retryMessages, /assistantProgress/u);
  assert.match(retryMessages, /minimumLength/u);
  assert.match(retryMessages, /maximumLength/u);
  assert.match(retryMessages, /600/u);
  assert.match(retryMessages, /concrete work/u);
  assert.match(retryMessages, /corrected structured tool call only/u);
  assert.match(retryMessages, /Repeat the exact rejected tool call shown below/u);
  assert.match(retryMessages, /Previous rejected structured response/u);
  assert.match(retryMessages, /fs_read_text/u);
  assert.match(retryMessages, /package\.json/u);
  assert.deepEqual(retryRequest?.tools?.map((tool) => tool.name), ["fs_read_text"]);
  assert.equal(retryRequest?.providerOptions?.openrouter?.parallelToolCalls, false);
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.deepEqual(agent.nextAction, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "package.json" },
  });
});

test("agent loop advertises assistantProgress inside every exec_command lifecycle branch", async () => {
  let execCommandSchema: Record<string, unknown> | undefined;
  const execCommandLifecycleTool: ModelToolSpec = {
    name: "exec_command",
    description: "Run or continue a command.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        sessionId: { type: "string" },
        stop: { type: "boolean" },
      },
      oneOf: [
        { type: "object", additionalProperties: false, properties: { command: { type: "string" } }, required: ["command"] },
        { type: "object", additionalProperties: false, properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
        { type: "object", additionalProperties: false, properties: { sessionId: { type: "string" }, stop: { type: "boolean" } }, required: ["sessionId", "stop"] },
      ],
    },
  };
  await buildStep({
    tools: [execCommandLifecycleTool],
    capabilityManifest: [
      {
        name: "exec_command",
        description: "Run a command",
        capabilityClasses: ["dev.shell"],
        executionClass: "read_only",
      },
    ],
  })(context(), {
    useModel: async (request: ModelRequest) => {
      execCommandSchema = request.tools?.find((tool) => tool.name === "exec_command")?.inputSchema;
      return modelResponse({
        version: "v1",
        reason: "No command is needed.",
        nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "No command was needed.",
        },
      });
    },
  } satisfies StepIO);

  const schema = execCommandSchema as Record<string, unknown>;
  const branches = schema.oneOf as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(branches), true);
  assert.equal(branches.length, 3);
  for (const branch of branches) {
    assert.equal((branch.required as string[]).includes("assistantProgress"), true);
    assert.deepEqual((branch.properties as Record<string, unknown>).assistantProgress, {
      type: "string",
      minLength: 1,
      maxLength: 600,
      description: "One concise user-facing progress sentence for this action. It is shown only after the action is accepted and committed.",
    });
  }
});

test("agent loop terminates with the decision contract failure after assistantProgress retries are exhausted", async () => {
  let modelCallCount = 0;
  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  })(context(), {
    useModel: async () => {
      modelCallCount += 1;
      return {
        output: {
          understanding: {
            task: "Inspect the workspace.",
            facts: ["The workspace has not been inspected yet."],
            currentGap: "The package metadata must be read.",
            actionBasis: "Reading package.json is the next concrete step.",
          },
          reason: "Read the package metadata.",
        },
        text: "Read the package metadata.",
        toolIntents: [
          {
            name: "fs_read_text",
            input: { path: "package.json" },
          },
        ],
        provider: {
          name: "openai",
          model: "test/agent",
          endpoint: "chat",
        },
      } satisfies ModelResponse<unknown>;
    },
  } satisfies StepIO);

  assert.equal(modelCallCount, 4);
  assert.equal(transition.status, "FAILED");
  assert.equal(transition.nextStepAgent, undefined);
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const terminal = agent.terminal as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const details = failure.details as Record<string, unknown>;
  const observations = agent.observations as Array<Record<string, unknown>>;
  assert.equal(terminal.reasonCode, "DECISION_SCHEMA_FAILED");
  assert.match(String(terminal.message), /contract remained invalid after 4 attempts/u);
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(details.reason, "invalid_assistant_progress");
  assert.equal(details.attemptCount, 4);
  assert.equal(retryContext.exhausted, true);
  assert.equal(observations.at(-1)?.kind, "model_contract_failure");
  assert.equal(observations.at(-1)?.errorCode, "DECISION_SCHEMA_FAILED");
  assert.doesNotMatch(JSON.stringify(agent), /NO_PROGRESS_REASONING_LOOP/u);
});

test("agent loop rejects plan-mode external side-effect choices instead of asking for full-auto", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "Give me a report on the status of this repo.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  let requestToolNames: string[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL, DEV_SHELL_RUN_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
      {
        name: "dev.shell.run",
        description: "Run a shell command",
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect",
      },
    ],
  })(planContext, {
    useModel: async (request: ModelRequest) => {
      requestToolNames = (request.tools ?? []).map((tool) => tool.name);
      return modelResponse({
        version: "v1",
        reason: "A git status command would inspect repository state.",
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: { command: "git status --short" },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  assert.deepEqual(requestToolNames, ["fs_read_text", "kestrel_finalize", "kestrel_ask_user", "kestrel_cannot_satisfy", "kestrel_handoff_to_build", "kestrel_todo_update"]);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "unknown_model_tool_alias");
  assert.equal(failureDetails.providerName, "dev_shell_run");
  assert.doesNotMatch(JSON.stringify(agent), /act\.full_auto|switch to act full auto/u);
});

test("agent loop rejects ask_user and preserves a noninteractive retry surface for SWE job runs", async () => {
  const sweContext = context();
  sweContext.event.type = "job.run";
  sweContext.event.payload = {
    message: "Fix the failing test in /testbed.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
    benchmark: {
      name: "swe-verified",
      taskId: "pytest-dev__pytest-10051",
      context: {
        source: "swe-verified",
        taskId: "pytest-dev__pytest-10051",
        workspaceRoot: "/testbed",
      },
    },
    workspace: {
      workspaceId: "swe-verified",
      workspaceRoot: "/testbed",
      label: "SWE Verified testbed",
      managedWorktreeRequired: false,
    },
  };
  sweContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  const requestToolNames: string[][] = [];

  const io = {
    useModel: async (request: ModelRequest) => {
      requestToolNames.push((request.tools ?? []).map((tool) => tool.name));
      if (requestToolNames.length === 1) {
        return modelResponse({
          version: "v1",
          reason: "Ask the user which implementation to use.",
          nextAction: {
            kind: "ask_user",
            prompt: "Which implementation should I use?",
          },
        });
      }
      return modelResponse({
        version: "v1",
        reason: "Continue from repository evidence instead.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO;

  const rejectedTransition = await buildStep()(sweContext, io);
  assert.equal(rejectedTransition.status, "RUNNING");
  assert.equal(rejectedTransition.nextStepAgent, "agent.loop");
  sweContext.session.state.agent = rejectedTransition.statePatch?.agent as Record<string, unknown>;
  sweContext.stepIndex += 1;
  const transition = await buildStep()(sweContext, io);

  assert.equal(transition.status, "RUNNING");
  assert.equal(requestToolNames.length, 2);
  for (const names of requestToolNames) {
    assert.ok(names.includes("kestrel_finalize"));
    assert.ok(names.includes("kestrel_todo_update"));
    assert.equal(names.includes("kestrel_ask_user"), false);
  }
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  assert.equal(nextAction.kind, "tool");
  assert.equal(nextAction.name, "fs.read_text");
});

test("agent loop narrows build-mode cannot_satisfy reasons to concrete unavailable blockers", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    message: "Inspect the repo and explain the blocker.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  let requestTools: ModelToolSpec[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  })(buildContext, {
    useModel: async (request: ModelRequest) => {
      requestTools = request.tools ?? [];
      return modelResponse({
        version: "v1",
        reason: "Read a file before deciding.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  const cannotSatisfyTool = requestTools.find((tool) => tool.name === "kestrel_cannot_satisfy");
  assert.ok(cannotSatisfyTool);
  const inputSchema = cannotSatisfyTool.inputSchema as Record<string, unknown>;
  const properties = inputSchema.properties as Record<string, unknown>;
  const reasonCodeSchema = properties.reasonCode as Record<string, unknown>;
  assert.deepEqual(reasonCodeSchema.enum, ["missing_required_capability", "requested_tool_unavailable"]);
});

test("agent loop accepts a concrete unavailable build capability with blocker provenance", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    message: "Apply the requested change or report the concrete blocker.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The requested write tool is not present in the runtime capability manifest.",
      nextAction: {
        kind: "cannot_satisfy",
        reasonCode: "requested_tool_unavailable",
        message: "Blocked while waiting for approved write capability.",
        details: {
          requestedTool: "fs.write_text",
          completionState: "blocked",
          blockers: ["awaiting approved write capability"],
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "cannot_satisfy",
    reasonCode: "requested_tool_unavailable",
    message: "Blocked while waiting for approved write capability.",
    details: {
      requestedTool: "fs.write_text",
      completionState: "blocked",
      blockers: ["awaiting approved write capability"],
    },
  });
  assert.equal(agent.retryContext, undefined);
});

test("agent loop hides tools missing capability manifest entries", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "Read the repo status.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  let requestToolNames: string[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL, DEV_SHELL_RUN_TOOL],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file",
        capabilityClasses: ["filesystem.read"],
        executionClass: "read_only",
      },
    ],
  })(planContext, {
    useModel: async (request: ModelRequest) => {
      requestToolNames = (request.tools ?? []).map((tool) => tool.name);
      return modelResponse({
        version: "v1",
        reason: "Try an unclassified shell command.",
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: { command: "git status --short" },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;
  assert.deepEqual(requestToolNames, ["fs_read_text", "kestrel_finalize", "kestrel_ask_user", "kestrel_cannot_satisfy", "kestrel_handoff_to_build", "kestrel_todo_update"]);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "unknown_model_tool_alias");
  assert.equal(failureDetails.providerName, "dev_shell_run");
});

test("agent loop omits plan-only handoff control tool in build mode", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    message: "Read the repo status.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  let requestToolNames: string[] = [];

  const transition = await buildStep({
    tools: [READ_TEXT_TOOL],
  })(buildContext, {
    useModel: async (request: ModelRequest) => {
      requestToolNames = (request.tools ?? []).map((tool) => tool.name);
      return modelResponse({
        version: "v1",
        reason: "Read the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      });
    },
  } satisfies StepIO);

  assert.deepEqual(requestToolNames, [
    "fs_read_text",
    "kestrel_finalize",
    "kestrel_ask_user",
    "kestrel_cannot_satisfy",
    "kestrel_todo_update",
  ]);
  assert.equal(requestToolNames.includes("kestrel_handoff_to_build"), false);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
});

test("agent loop rejects capability-blocked tools with explicit policy feedback", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    message: "Propose a Mission Control task.",
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
  };
  buildContext.session.state.agent = {
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
  };

  const transition = await buildStep({
    tools: [PROJECT_TASK_PROPOSE_TOOL],
    capabilityManifest: [
      {
        name: "task.propose",
        description: "Propose a Mission Control task",
        capabilityClasses: ["runtime.project.task_queue"],
        approvalCapabilities: ["project.task_queue.write"],
        executionClass: "external_side_effect",
      },
    ],
  })(buildContext, {
    useModel: async () =>
      modelResponse({
        version: "v1",
        reason: "Propose the requested task.",
        nextAction: {
          kind: "tool",
          name: "task.propose",
          input: {
            sessionId: "session-1",
            title: "Scaffold work",
            instructions: "Create the scaffold.",
          },
        },
      }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "unknown_model_tool_alias");
  assert.equal(failureDetails.providerName, "task_propose");
});

test("agent loop resumes an accepted implementation offer when the current Build mode already allows it", async () => {
  const acceptanceContext = context();
  acceptanceContext.event = {
    id: "evt-accept-act-safe",
    type: "user.reply",
    sessionId: "session-1",
    payload: {
      message: "not a magic phrase",
      interactionMode: "build",
      actSubmode: "safe",
      modeSystemV2Enabled: true,
    },
  };
  acceptanceContext.session.state.agent = {
    interactionMode: "build",
    actSubmode: "safe",
    modeSystemV2Enabled: true,
    activeContinuation: runtimeContinuation(),
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
    visibleTodos: {
      objective: "Create a Python Pong game.",
      items: [
        {
          id: "write-pong",
          text: "Write the Pong implementation file",
          status: "in_progress",
        },
        {
          id: "check-pong",
          text: "Check the Pong implementation",
          status: "pending",
        },
      ],
    },
    waitingFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "continuation_handoff",
        continuationId: "continuation:run-1",
      },
    },
    nextAction: {
      kind: "ask_user",
      prompt: "I can build this next.",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "continuation_handoff",
          continuationId: "continuation:run-1",
        },
      },
    },
  };

  let modelCalled = false;
  let modelInput: Record<string, unknown> | undefined;
  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(acceptanceContext, {
    useModel: async (request) => {
      modelCalled = true;
      modelInput = request.input as Record<string, unknown>;
      return modelResponse({
        version: "v1",
        reason: "Write the implementation file.",
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: { path: "pong.py", content: "print('pong')" },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(modelCalled, true);
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.pendingContinuationOffer, undefined);
  assert.equal(modelInput?.taskInstruction, "Create a Python Pong game.");
  const transcript = modelInput?.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.equal(items.at(-1)?.content, "not a magic phrase");
});

test("agent loop preserves canonical handoff facts when accepting a plan handoff", async () => {
  const acceptanceContext = context();
  acceptanceContext.event = {
    id: "evt-accept-plan-handoff",
    type: "user.reply",
    sessionId: "session-1",
    payload: {
      message: "continue",
      interactionMode: "build",
      modeSystemV2Enabled: true,
    },
  };
  acceptanceContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    activeContinuation: runtimeContinuation(),
    planDocument: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      exists: true,
      content: "# Plan\n\nBuild this next.",
    },
    visibleTodos: {
      objective: "Create a Python Pong game.",
      items: [
        {
          id: "write-pong",
          text: "Write the Pong implementation file",
          status: "in_progress",
        },
        {
          id: "check-pong",
          text: "Check the Pong implementation",
          status: "pending",
        },
      ],
    },
    waitingFor: {
      kind: "user",
      eventType: "user.reply",
      reason: "plan handoff confirmation",
      resumeInstruction: "Resume after the user confirms the plan handoff.",
      resumeStepAgent: "agent.exec.wait_user",
      resumeToken: "plan-handoff-token",
      metadata: {
        reason: "continuation_handoff",
        continuationId: "continuation:run-1",
        handoff: {
          goal: "Create a Python Pong game.",
          proposedApproach: "Create the Pong game files.",
          readiness: "ready_to_build",
          proposedNextMode: "build",
        },
      },
    },
    nextAction: {
      kind: "ask_user",
      prompt: "I can build this next.",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "continuation_handoff",
          continuationId: "continuation:run-1",
        },
      },
    },
  };

  let modelInput: Record<string, unknown> | undefined;
  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(acceptanceContext, {
    useModel: async (request) => {
      modelInput = request.input as Record<string, unknown>;
      return modelResponse({
        version: "v1",
        reason: "Write the implementation file.",
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: { path: "pong.py", content: "print('pong')" },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(Object.hasOwn(modelInput ?? {}, "supportingFacts"), false);
  assert.equal(Object.hasOwn(modelInput ?? {}, "currentTurnSummary"), false);
});

test("agent loop allows build finalization without a planning document update", async () => {
  const finalizeContext = context();
  finalizeContext.event = {
    id: "evt-finalize-build-without-plan-doc",
    type: "user.message",
    sessionId: "session-1",
    payload: {
      message: "finish",
      interactionMode: "build",
    },
  };
  finalizeContext.session.state.agent = {
    interactionMode: "build",
    lastActionResult: {
      kind: "tool",
      name: "fs.write_text",
      toolName: "fs.write_text",
      status: "ok",
      inputHash: "write-ok",
      output: {
        path: "src/app.ts",
        bytesWritten: 42,
      },
    },
  };

  const transition = await buildStep()(finalizeContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The implementation is complete.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: { message: "Done." },
  });
});

test("agent loop dispatches selected tool work without hidden progress gates", async () => {
  const finalizeContext = context();
  finalizeContext.event = {
    id: "evt-complete-ledger-tool-work",
    type: "user.message",
    sessionId: "session-1",
    payload: {
      message: "finish",
      interactionMode: "build",
    },
  };
  finalizeContext.session.state.agent = {
    interactionMode: "build",
  };

  const transition = await buildStep()(finalizeContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "I should inspect again.",
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: { path: "index.html" },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.deepEqual(nextAction, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "index.html" },
  });
  assert.equal((agent.lastActionResult as Record<string, unknown> | undefined), undefined);
});

test("agent loop dispatches goal_satisfied when artifact verification is inconclusive", async () => {
  const finalizeContext = context();
  finalizeContext.event = {
    id: "evt-finalize-blocked-by-artifact-verification",
    type: "user.message",
    sessionId: "session-1",
    payload: {
      message: "finish",
      interactionMode: "build",
    },
  };
  finalizeContext.session.state.agent = {
    interactionMode: "build",
    evidenceLedger: [
      {
        id: "ev_empty_workspace",
        version: "v1",
        createdAt: "2026-06-09T21:00:00.000Z",
        source: "runtime",
        kind: "artifact_verification",
        status: "inconclusive",
        summary: "Workspace is empty.",
        target: {
          type: "artifact",
          value: "newsletter page in workspace",
        },
        facts: {
          target: "newsletter page in workspace",
          status: "inconclusive",
          failures: ["No concrete file artifact is visible in the current workspace evidence."],
          requirements: [
            {
              id: "implementation",
              expectation: "Newsletter page with three sample stories exists in the workspace.",
              observed: "Current filesystem listing shows no files or directories in the workspace root.",
              status: "inconclusive",
            },
          ],
        },
      },
    ],
  };

  const transition = await buildStep()(finalizeContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The ledger says this is complete.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "The task ledger reports the newsletter page is complete and verified.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.deepEqual(agent.nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: {
      message: "The task ledger reports the newsletter page is complete and verified.",
      data: {
        completionState: "implemented_and_verified",
      },
    },
  });
  assert.equal(agent.retryContext, undefined);
});

test("agent loop resumes a mode-blocked continuation offer after structural mode-switch reply", async () => {
  const acceptanceContext = context();
  const runtimeContinuation = {
    version: "runtime_continuation_v1",
    id: "continuation:run-1",
    kind: "implementation",
    objective: "Create a Python Pong game.",
    requiredToolClass: "sandboxed_only",
    requiredCapabilities: ["workspace.write"],
    requiredMode: "build",
    sourceRunId: "run-1",
    resumeStepAgent: "agent.exec.wait_user",
    status: "awaiting_user",
    createdAt: "2026-06-03T20:48:32.000Z",
    resumeMessage: "Create the Pong game.",
  };
  acceptanceContext.event = {
    id: "evt-accept-mode-switch",
    type: "user.reply",
    sessionId: "session-1",
    payload: {
      message: "switch to build",
      interactionMode: "build",
      actSubmode: "safe",
      modeSystemV2Enabled: true,
    },
  };
  acceptanceContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    activeContinuation: runtimeContinuation,
    visibleTodos: {
      objective: "Create a Python Pong game.",
      items: [
        {
          id: "write-pong",
          text: "Write the Pong implementation file",
          status: "in_progress",
        },
        {
          id: "check-pong",
          text: "Check the Pong implementation",
          status: "pending",
        },
      ],
    },
    waitingFor: {
      kind: "user",
      eventType: "user.reply",
      reason: "planner_mode_blocked",
      metadata: {
        reason: "planner_mode_blocked",
        continuationId: runtimeContinuation.id,
      },
    },
    nextAction: {
      kind: "ask_user",
      prompt: "Switch to build?",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "planner_mode_blocked",
          continuationId: runtimeContinuation.id,
        },
      },
    },
  };

  let modelInput: Record<string, unknown> | undefined;
  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(acceptanceContext, {
    useModel: async (request) => {
      modelInput = request.input as Record<string, unknown>;
      return modelResponse({
        version: "v1",
        reason: "Write the implementation file.",
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: { path: "pong.py", content: "print('pong')" },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.pendingContinuationOffer, undefined);
  assert.equal(modelInput?.taskInstruction, "Create a Python Pong game.");
});

test("agent loop rejects hidden sandboxed tool dispatch selected while still in plan mode", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "Build it.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  let requestToolNames: string[] = [];

  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write a text file",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(planContext, {
    useModel: async (request: ModelRequest) => {
      requestToolNames = (request.tools ?? []).map((tool) => tool.name);
      return modelResponse({
        version: "v1",
        reason: "Write the requested file.",
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: { path: "pong.py", content: "print('pong')" },
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;
  assert.deepEqual(requestToolNames, ["kestrel_finalize", "kestrel_ask_user", "kestrel_cannot_satisfy", "kestrel_handoff_to_build", "kestrel_todo_update"]);
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "unknown_model_tool_alias");
  assert.equal(failureDetails.providerName, "fs_write_text");
  assert.doesNotMatch(JSON.stringify(agent), /switch to build/u);
});

test("agent loop allows direct conversational finalization while in plan mode", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "cwd?",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
    workspace: {
      workspaceRoot: "/repo",
      sourceWorkspaceRoot: "/repo",
      managedWorktreeRequired: true,
    },
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  let modelInput: Record<string, unknown> | undefined;

  const transition = await buildStep()(planContext, {
    useModel: async (request: ModelRequest) => {
      modelInput = request.input as Record<string, unknown>;
      return modelResponse({
      version: "v1",
      reason: "Answer the simple current task status question without writing a plan.",
      nextAction: {
          kind: "finalize",
          status: "goal_satisfied",
          message: "/repo",
        },
      });
    },
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const commandBatch = agent.commandBatch as Record<string, unknown>;
  const commands = commandBatch.commands as Array<Record<string, unknown>>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(modelInput?.interactionMode, "plan");
  assert.deepEqual(nextAction, {
    kind: "finalize",
    finalizeReason: "goal_satisfied",
    input: { message: "/repo" },
  });
  assert.equal(commandBatch.status, "ready");
  assert.equal(commands[0]?.name, "finalize");
});

test("agent loop allows clarifying questions while in plan mode before writing a plan", async () => {
  const planContext = context();
  planContext.event.payload = {
    message: "Let's fix plan mode.",
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };
  planContext.session.state.agent = {
    interactionMode: "plan",
    modeSystemV2Enabled: true,
  };

  const transition = await buildStep()(planContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Ask for the missing product decision before continuing.",
      nextAction: {
        kind: "ask_user",
        prompt: "Should plan mode answer simple context questions directly, or only ask clarifying questions first?",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "planning_clarification",
          },
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const commandBatch = agent.commandBatch as Record<string, unknown>;
  const commands = commandBatch.commands as Array<Record<string, unknown>>;
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(nextAction.kind, "ask_user");
  assert.equal(nextAction.prompt, "Should plan mode answer simple context questions directly, or only ask clarifying questions first?");
  assert.equal(((nextAction.waitFor as Record<string, unknown>).metadata as Record<string, unknown>).reason, "model_requested_clarification");
  assert.equal(commandBatch.status, "ready");
  assert.equal(commands[0]?.name, "ask_user");
});

test("agent loop persists detached action snapshots", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Read the requested file.",
      visibleTodos: {
        objective: "Handle the requested test task.",
        items: [
          {
            id: "read-file-readme-md",
            text: "Read file: README.md",
            status: "in_progress",
          },
        ],
      },
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: { path: "README.md" },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const lastAction = agent.lastAction as Record<string, unknown>;
  const commandBatch = agent.commandBatch as Record<string, unknown>;
  const commands = commandBatch.commands as Record<string, unknown>[];
  const command = commands[0]!;

  assert.deepEqual(nextAction, lastAction);
  assert.notEqual(nextAction, lastAction);
  assert.deepEqual(command.input, nextAction.input);
  assert.notEqual(command.input, nextAction.input);

  const persisted = JSON.parse(stringifySanitizedJson(transition.statePatch)) as {
    agent: {
      nextAction: unknown;
      lastAction: unknown;
      commandBatch: {
        commands: Array<{ input: unknown }>;
      };
    };
  };
  assert.deepEqual(persisted.agent.nextAction, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "README.md" },
  });
  assert.deepEqual(persisted.agent.lastAction, persisted.agent.nextAction);
  assert.deepEqual(persisted.agent.commandBatch.commands[0]?.input, { path: "README.md" });
});

test("agent loop does not import session-scoped runtime notes into deliberation facts", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-agent-plan-import-"));
  const restoreKestrelHome = setKestrelHomeForTest(workspaceRoot);
  await writeLegacySessionNoteFixture(
    workspaceRoot,
    "session-1",
    "note.md",
    [
      "# Note",
      "",
      "## Objective",
      "Build the session plan",
      "",
      "## Checklist",
      "- [x] Inspect workspace",
      "  - evidence: fs.list",
      "- [ ] Run verification (active)",
      "",
    ].join("\n"),
  );

  try {
    const importedContext = context();
    importedContext.event.payload = {
      ...importedContext.event.payload,
      interactionMode: "build",
      workspace: {
        workspaceRoot,
      },
    };
    importedContext.session.state.agent = {
      interactionMode: "build",
    };
    let modelInput: Record<string, unknown> | undefined;
    const transition = await buildStep()(importedContext, {
      useModel: async (request: ModelRequest) => {
        modelInput = request.input as Record<string, unknown>;
        return modelResponse({
          version: "v1",
          reason: "Read the requested file.",
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: { path: "README.md" },
          },
        });
      },
    } satisfies StepIO);

    const agent = transition.statePatch?.agent as Record<string, unknown>;
    assert.equal(Object.hasOwn(modelInput ?? {}, "supportingFacts"), false);
    assert.equal(agent.planDocument, undefined);
    assert.equal(Object.hasOwn(agent, "progress"), false);
  } finally {
    restoreKestrelHome();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("agent loop does not import legacy session notes into hidden progress state", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-agent-plan-malformed-"));
  const restoreKestrelHome = setKestrelHomeForTest(workspaceRoot);
  await writeLegacySessionNoteFixture(
    workspaceRoot,
    "session-1",
    "note.md",
    [
      "random planning note",
      "maybe inspect the runtime and then do the simple thing",
    ].join("\n"),
  );

  try {
    const malformedContext = context();
    malformedContext.session.state.agent = {
      interactionMode: "build",
    };
    malformedContext.event.payload = {
      ...malformedContext.event.payload,
      interactionMode: "build",
      workspace: {
        workspaceRoot,
      },
    };
    const transition = await buildStep()(malformedContext, {
      useModel: async (request: ModelRequest) => {
        const modelInput = request.input as Record<string, unknown>;
        assert.equal(Object.hasOwn(modelInput, "supportingFacts"), false);
        return modelResponse({
          version: "v1",
          reason: "Read the requested file.",
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: { path: "README.md" },
          },
        });
      },
    } satisfies StepIO);

    const agent = transition.statePatch?.agent as Record<string, unknown>;
    assert.equal(transition.status, "RUNNING");
    assert.equal((agent.nextAction as Record<string, unknown>).name, "fs.read_text");
    assert.equal(agent.planDocument, undefined);
  } finally {
    restoreKestrelHome();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("agent loop feeds invalid tool names back as retry context instead of hard failing", async () => {
  const invalidContext = context();
  invalidContext.session.state.agent = {
    nextAction: {
      kind: "tool",
      name: "fs.read_text",
      input: { path: "STALE.md" },
    },
  };

  const transition = await buildStep()(invalidContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Try a missing tool.",
      nextAction: {
        kind: "tool",
        name: "fs.missing",
        input: {},
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  const observations = agent.observations as Record<string, unknown>[];
  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal(lastActionResult.status, "failed");
  assert.equal(typeof lastActionResult.timestamp, "string");
  assert.equal(agent.nextAction, undefined);
  assert.equal(retryContext.loopAttempt, 1);
  assert.equal((retryContext.failure as Record<string, unknown>).code, "DECISION_SCHEMA_FAILED");
  assert.equal(observations.at(-1)?.kind, "validation_feedback");
  assert.equal(observations.at(-1)?.status, "failed");
  assert.equal(observations.at(-1)?.errorCode, "DECISION_SCHEMA_FAILED");
  assert.equal(typeof observations.at(-1)?.timestamp, "string");
});

test("agent loop feeds internal finalize narration back as retry context instead of hard failing", async () => {
  const invalidContext = context();

  const transition = await buildStep()(invalidContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The answer is already known.",
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "The next move is to answer the question directly in chat.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(failureDetails.reason, "user_visible_text_not_operator_facing");
  assert.equal(failureDetails.field, "finalize.message");
});

test("agent loop feeds internal ask_user narration back as retry context instead of hard failing", async () => {
  const invalidContext = context();

  const transition = await buildStep()(invalidContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "A missing choice blocks the plan.",
      nextAction: {
        kind: "ask_user",
        prompt: "Ask the user which runtime target they prefer.",
        waitFor: {
          kind: "user",
          eventType: "user.reply",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal((agent.lastActionResult as Record<string, unknown>).kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(failureDetails.reason, "user_visible_text_not_operator_facing");
  assert.equal(failureDetails.field, "ask_user.prompt");
});

test("agent loop feeds internal cannot_satisfy narration back as retry context instead of hard failing", async () => {
  const invalidContext = context();

  const transition = await buildStep()(invalidContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The request exceeds the current horizon.",
      nextAction: {
        kind: "cannot_satisfy",
        reasonCode: "insufficient_horizon",
        message: "I cannot finish in this turn.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal((agent.lastActionResult as Record<string, unknown>).kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_POLICY_FAILED");
  assert.equal(failureDetails.reason, "user_visible_text_not_operator_facing");
  assert.equal(failureDetails.field, "cannot_satisfy.message");
});

test("agent loop rejects build-mode insufficient_horizon cannot_satisfy at the tool boundary", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };

  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The task needs more implementation steps.",
      nextAction: {
        kind: "cannot_satisfy",
        reasonCode: "insufficient_horizon",
        message: "The requested work is too large to complete here.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal((agent.lastActionResult as Record<string, unknown>).kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "invalid_control_tool_input");
  assert.equal(failureDetails.canonicalName, "kestrel.cannot_satisfy");
  assert.equal(failureDetails.path, "toolCalls[0].input.reasonCode");
});

test("agent loop rejects policy_blocked finalize after a cannot_satisfy retry", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    retryContext: {
      loopAttempt: 1,
      failure: {
        code: "DECISION_POLICY_FAILED",
        message: "cannot_satisfy reasonCode='insufficient_horizon' is invalid in build mode.",
        details: {
          reasonCode: "insufficient_horizon",
          interactionMode: "build",
          requiredAction: "choose_available_tool_or_concrete_blocker",
        },
      },
    },
  };

  const transition = await buildStep()(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "The policy blocks further work.",
      nextAction: {
        kind: "finalize",
        status: "policy_blocked",
        message: "Policy blocks this work.",
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const retryContext = agent.retryContext as Record<string, unknown>;
  const failure = retryContext.failure as Record<string, unknown>;
  const failureDetails = failure.details as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal((agent.lastActionResult as Record<string, unknown>).kind, "validation_feedback");
  assert.equal(failure.code, "DECISION_SCHEMA_FAILED");
  assert.equal(failureDetails.reason, "invalid_control_tool_input");
  assert.match(String(failure.message), /kestrel\.finalize requires status goal_satisfied or out_of_scope/u);
});

test("agent loop hides synthetic build blockers when executable tools are available", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  let requestTools: ModelToolSpec[] = [];

  const transition = await buildStep({
    tools: [EXEC_COMMAND_TOOL],
    capabilityManifest: [
      {
        name: "exec_command",
        description: "Run a shell command",
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect",
      },
    ],
  })(buildContext, {
    useModel: async (request) => {
      requestTools = request.tools ?? [];
      return modelResponse({
        version: "v1",
        reason: "Use the shell tool to inspect the workspace.",
        nextAction: {
          kind: "tool",
          name: "exec_command",
          input: { command: "pwd" },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  const requestToolNames = requestTools.map((tool) => tool.name);
  assert.ok(requestToolNames.includes("exec_command"));
  assert.ok(requestToolNames.includes("kestrel_finalize"));
  assert.equal(requestToolNames.includes("kestrel_cannot_satisfy"), false);
  const finalizeTool = requestTools.find((tool) => tool.name === "kestrel_finalize");
  const inputSchema = finalizeTool?.inputSchema as Record<string, unknown> | undefined;
  const properties = inputSchema?.properties as Record<string, unknown> | undefined;
  const statusSchema = properties?.status as Record<string, unknown> | undefined;
  assert.deepEqual(statusSchema?.enum, ["goal_satisfied", "out_of_scope"]);
});

test("agent loop accepts model-authored visible todos", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };
  const transition = await buildStep({
    tools: [EXEC_COMMAND_TOOL],
    capabilityManifest: [
      {
        name: "exec_command",
        description: "Run a shell command",
        capabilityClasses: ["dev.shell"],
        executionClass: "sandboxed_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Start with the scaffold step.",
      understanding: {
        task: "Build newsletter app",
        facts: ["The task requires scaffold, report, UI, and validation."],
        currentGap: "The workspace needs a scaffold first.",
        actionBasis: "Run the requested scaffold command.",
      },
      visibleTodos: {
        objective: "Build newsletter app",
        items: [
          {
            id: "scaffold-app",
            text: "Run shell command: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
            status: "in_progress",
          },
          {
            id: "write-report",
            text: "Write file: newsletter-report.json",
            status: "pending",
          },
          {
            id: "replace-page",
            text: "Write file: app/page.tsx",
            status: "pending",
          },
        ],
      },
      nextAction: {
        kind: "tool",
        name: "exec_command",
        input: {
          command: "CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const visibleTodos = agent.visibleTodos as Record<string, unknown>;
  const items = visibleTodos.items as Record<string, unknown>[];
  assert.equal(transition.status, "RUNNING");
  assert.equal(visibleTodos.objective, "Build newsletter app");
  assert.equal(items.length, 3);
  assert.equal(items[0]?.id, "scaffold-app");
  assert.equal(items[1]?.id, "write-report");
  assert.equal(items[2]?.id, "replace-page");
});

test("agent loop accepts standalone visible todo updates as progress", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };

  const transition = await buildStep({
    tools: [EXEC_COMMAND_TOOL],
    capabilityManifest: [
      {
        name: "exec_command",
        description: "Run a shell command",
        capabilityClasses: ["dev.shell"],
        executionClass: "sandboxed_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Create the visible checklist before editing.",
      visibleTodos: {
        objective: "Build newsletter app",
        items: [
          {
            id: "create-page",
            text: "Create the newsletter page",
            status: "in_progress",
          },
          {
            id: "verify-page",
            text: "Verify it works locally",
            status: "pending",
          },
        ],
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const visibleTodos = agent.visibleTodos as Record<string, unknown>;
  const transcript = agent.modelTranscript as Record<string, unknown>;
  const transcriptItems = transcript.items as Array<Record<string, unknown>>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.loop");
  assert.equal(agent.nextAction, undefined);
  assert.equal(agent.retryContext, undefined);
  assert.equal(visibleTodos.objective, "Build newsletter app");
  assert.equal(transcriptItems.some((item) => item.kind === "todo_update"), true);
});

test("agent loop accepts build-mode file mutation without a runtime visible-todo redirect", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };

  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Write the requested file.",
      nextAction: {
        kind: "tool",
        name: "fs.write_text",
        input: {
          path: "index.html",
          content: "<!doctype html>",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.equal(nextAction.kind, "tool");
  assert.equal(nextAction.name, "fs.write_text");
});

test("agent loop allows build-mode file mutation after visible todos exist", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
    visibleTodos: {
      objective: "Create the page",
      items: [
        {
          id: "write-page",
          text: "Write the page file",
          status: "in_progress",
        },
        {
          id: "check-page",
          text: "Check the generated page",
          status: "pending",
        },
      ],
    },
  };

  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Write the requested file.",
      nextAction: {
        kind: "tool",
        name: "fs.write_text",
        input: {
          path: "index.html",
          content: "<!doctype html>",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.equal(nextAction.kind, "tool");
  assert.equal(nextAction.name, "fs.write_text");
});

test("agent loop accepts same-response visible todo update and build-mode file mutation", async () => {
  const buildContext = context();
  buildContext.event.payload = {
    ...buildContext.event.payload,
    interactionMode: "build",
  };
  buildContext.session.state.agent = {
    interactionMode: "build",
  };

  const transition = await buildStep({
    tools: [WRITE_TEXT_TOOL],
    capabilityManifest: [
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["filesystem.write"],
        executionClass: "sandboxed_only",
      },
    ],
  })(buildContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Create the checklist and write the file.",
      visibleTodos: {
        objective: "Create the page",
        items: [
          {
            id: "write-page",
            text: "Write the page file",
            status: "in_progress",
          },
          {
            id: "check-page",
            text: "Check the generated page",
            status: "pending",
          },
        ],
      },
      nextAction: {
        kind: "tool",
        name: "fs.write_text",
        input: {
          path: "index.html",
          content: "<!doctype html>",
        },
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const nextAction = agent.nextAction as Record<string, unknown>;
  const visibleTodos = agent.visibleTodos as Record<string, unknown>;
  const items = visibleTodos.items as Record<string, unknown>[];

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(agent.retryContext, undefined);
  assert.equal(nextAction.kind, "tool");
  assert.equal(nextAction.name, "fs.write_text");
  assert.equal(items[0]?.id, "write-page");
});

test("compileIntent compiles simplified goal_satisfied finalization to internal action shape", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      plan: {
        intent: "Finalize completed work.",
        successCriteria: ["The user receives a final answer."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
      reason: "The work is complete.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
  });

  assert.equal(compiled.action.kind, "finalize");
  assert.equal(compiled.action.finalizeReason, "goal_satisfied");
  assert.deepEqual(compiled.action.input, { message: "Done." });
});

test("compileIntent accepts handoff_to_build", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "run-1",
    interactionMode: "plan",
    activePlan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    output: {
      version: "v2",
      plan: {
        intent: "Hand implementation to the next user reply.",
        successCriteria: ["The user can confirm the plan before execution starts."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next by creating the Python game file.",
        continuation: continuationOffer(),
        data: {
          proposedNextAction: "Create a Python Pong game.",
        },
      },
      reason: "The current response is a plan handoff.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
  });

  assert.equal(compiled.action.kind, "handoff_to_build");
  assert.deepEqual(compiled.action, {
    kind: "handoff_to_build",
    message: "I can build this next by creating the Python game file.",
    continuation: continuationOffer(),
    data: {
      proposedNextAction: "Create a Python Pong game.",
    },
  });
});

test("compileIntent allows handoff_to_build to declare future build capabilities without observed evidence", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "run-1",
    interactionMode: "plan",
    activePlan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    executionIntent: {
      objective: "Create a Python Pong game.",
      candidateTools: ["dev.shell.run"],
    },
    output: {
      version: "v2",
      plan: {
        intent: "Hand implementation to the next user reply.",
        successCriteria: ["The next build pass has the required capabilities captured."],
      },
      requiredCapabilities: ["workspace.write"],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next by creating the Python game file.",
        continuation: continuationOffer(),
              },
      reason: "The plan is ready, and the next build pass needs workspace write access.",
    },
    observedCapabilities: [],
    capabilityManifest: [
      {
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: ["workspace.write", "shell.exec"],
        executionClass: "external_side_effect",
      },
    ],
    availableTools: [DEV_SHELL_RUN_TOOL],
  });

  assert.equal(compiled.action.kind, "handoff_to_build");
  assert.deepEqual(compiled.action.continuation.requiredCapabilities, ["workspace.write"]);
});

test("compileIntent hydrates compact handoff_to_build continuation payloads", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "run-1",
    interactionMode: "plan",
    activePlan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    output: {
      version: "v2",
      plan: {
        intent: "Hand implementation to the next user reply.",
        successCriteria: ["The next build pass is ready."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next by creating the Python game file.",
        continuation: compactContinuationInput(),
              },
      reason: "The plan is ready for build handoff.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
  });

  assert.equal(compiled.action.kind, "handoff_to_build");
  assert.deepEqual(compiled.action.continuation, continuationOffer());
});

test("compileIntent rewrites model-supplied handoff lineage to the active run", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "run-1",
    interactionMode: "plan",
    activePlan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    output: {
      version: "v2",
      plan: {
        intent: "Hand implementation to the next user reply.",
        successCriteria: ["The next build pass is ready with runtime-owned lineage."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next by creating the Python game file.",
        continuation: continuationOffer({ sourceRunId: "stale-run-99" }),
              },
      reason: "The runtime should own continuation lineage.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
  });

  assert.equal(compiled.action.kind, "handoff_to_build");
  assert.deepEqual(compiled.action.continuation, continuationOffer());
});

test("compileIntent rejects handoff_to_build outside plan mode", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          plan: {
            intent: "Hand implementation to the next user reply.",
            successCriteria: ["The user can confirm the plan before execution starts."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "handoff_to_build",
            message: "I can build this next by creating the Python game file.",
            continuation: continuationOffer(),
          },
          reason: "The current response is a plan handoff.",
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    /handoff_to_build is only valid in plan mode/u,
  );
});

test("compileIntent rewrites model-supplied handoff mode to build", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "run-1",
    interactionMode: "plan",
    activePlan: {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      status: "draft",
    },
    output: {
      version: "v2",
      plan: {
        intent: "Hand implementation to the next user reply.",
        successCriteria: ["The next build pass is normalized to build mode."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "handoff_to_build",
        message: "I can build this next by creating the Python game file.",
        continuation: {
          ...continuationOffer(),
          requiredMode: "plan",
        },
              },
      reason: "The runtime should own continuation mode.",
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
  });

  assert.equal(compiled.action.kind, "handoff_to_build");
  assert.deepEqual(compiled.action.continuation, continuationOffer());
});

test("compileIntent rejects cannot_satisfy when extracted candidate tools are available", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        executionIntent: {
          objective: "Scaffold the app in the empty workspace.",
          candidateTools: ["dev.shell.run"],
        },
        output: {
          version: "v2",
          plan: {
            intent: "Give up before starting scaffold.",
            successCriteria: ["The task is marked impossible."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "unsatisfied_by_available_tools",
            message: "I cannot proceed with the available tools.",
          },
          reason: "No valid implementation route is available.",
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "dev.shell.run",
            description: "Run a shell command.",
            capabilityClasses: ["workspace.write", "shell.exec"],
            executionClass: "external_side_effect",
          },
        ],
        availableTools: [DEV_SHELL_RUN_TOOL],
      }),
    /unsatisfied_by_available_tools' is invalid when extracted candidate tools are available/u,
  );
});

test("compileIntent rejects internal finalize narration for user-visible closeouts", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "plan",
        output: {
          version: "v2",
          plan: {
            intent: "Answer the follow-up directly.",
            successCriteria: ["The user gets the requested answer."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "The next move is to answer the question directly in chat.",
          },
          reason: "The answer can be delivered without tools.",
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    (error) => {
      const cast = error as DecisionCompileError;
      assert.equal(cast instanceof DecisionCompileError, true);
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.diagnostics?.reason, "user_visible_text_not_operator_facing");
      assert.equal(cast.diagnostics?.field, "finalize.message");
      return true;
    },
  );
});

test("compileIntent rejects internal ask_user narration for user-visible prompts", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "plan",
        output: {
          version: "v2",
          plan: {
            intent: "Clarify the missing preference.",
            successCriteria: ["The user answers the blocking question."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "ask_user",
            prompt: "Ask the user which runtime target they prefer.",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
            },
          },
          reason: "A preference blocks the plan.",
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reason, "user_visible_text_not_operator_facing");
      assert.equal(cast.details?.field, "ask_user.prompt");
      return true;
    },
  );
});

test("compileIntent rejects internal cannot_satisfy narration for user-visible blockers", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          plan: {
            intent: "Report the blocker directly.",
            successCriteria: ["The user sees the blocker."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "insufficient_horizon",
            message: "I cannot finish in this turn.",
          },
          reason: "The request is blocked by the runtime horizon.",
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reason, "user_visible_text_not_operator_facing");
      assert.equal(cast.details?.field, "cannot_satisfy.message");
      return true;
    },
  );
});

test("compileIntent allows root create-next-app scaffold under scaffold intent", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    executionIntent: {
      objective: "Scaffold the app in the empty workspace.",
      candidateTools: ["dev.shell.run"],
      operationIntent: { kind: "scaffold_app" },
    },
    output: {
      version: "v2",
      plan: {
        intent: "Scaffold the workspace root.",
        successCriteria: ["The Next.js app is created at the current root."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "dev.shell.run",
        input: {
          command: "pnpm create next-app@latest . --ts --eslint --app --use-pnpm",
        },
      },
      reason: "The workspace is empty, so the next concrete step is the root scaffold.",
    },
    observedCapabilities: [],
    capabilityManifest: [
      {
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: ["workspace.write", "shell.exec"],
        executionClass: "external_side_effect",
      },
    ],
    availableTools: [DEV_SHELL_RUN_TOOL],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "dev.shell.run");
});

test("agent loop allows file creation after empty-root evidence when visible todos exist", async () => {
  const scaffoldContext = context();
  let requestCount = 0;
  let retryInput: Record<string, unknown> | undefined;
  scaffoldContext.event.payload = {
    message: "Scaffold the app in the empty workspace.",
    interactionMode: "build",
    modeSystemV2Enabled: true,
  };
  scaffoldContext.session.state.agent = {
    interactionMode: "build",
    modeSystemV2Enabled: true,
    toolIntent: {
      version: "v3",
      execution: {
        objective: "Scaffold the app in the empty workspace.",
        candidateTools: ["fs.write_text", "dev.shell.run"],
        operationIntent: {
          kind: "scaffold_app",
        },
      },
      confidence: 0.96,
    },
    lastActionResult: {
      kind: "tool",
      name: "fs.list",
      status: "succeeded",
      input: {
        path: ".",
        includeHidden: true,
      },
      output: {
        path: ".",
        entries: [],
        entryCount: 0,
        empty: true,
        message: "This directory is empty.",
      },
    },
    evidenceLedger: [
      {
        id: "ev_root_empty",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 1,
        source: "tool",
        kind: "file_listing",
        status: "passed",
        summary: "This directory is empty.",
        target: {
          type: "path",
          value: ".",
          normalizedValue: ".",
        },
        facts: {
          toolName: "fs.list",
          inputPath: ".",
          outputPath: ".",
          entryCount: 0,
          empty: true,
          entries: [],
          message: "This directory is empty.",
          inputIncludeHidden: true,
        },
      },
    ],
    visibleTodos: {
      objective: "Scaffold the app in the empty workspace.",
      items: [
        {
          id: "create-page",
          text: "Create the requested page file",
          status: "in_progress",
        },
        {
          id: "check-page",
          text: "Check the created page file",
          status: "pending",
        },
      ],
    },
  };

  const transition = await buildStep({
    tools: [LIST_TOOL, WRITE_TEXT_TOOL, DEV_SHELL_RUN_TOOL],
    capabilityManifest: [
      {
        name: "fs.list",
        description: "List files.",
        capabilityClasses: ["fs.read"],
        executionClass: "read_only",
      },
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["fs.write"],
        executionClass: "sandboxed_only",
      },
      {
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: ["workspace.write", "shell.exec"],
        executionClass: "external_side_effect",
      },
    ],
  })(scaffoldContext, {
    useModel: async (request: ModelRequest) => {
      requestCount += 1;
      return modelResponse({
        version: "v1",
        understanding: {
          task: "Create a simple page in the empty workspace.",
          facts: ["The workspace root is already empty."],
          currentGap: "The page has not been created yet.",
          actionBasis: "Write the requested page directly.",
        },
        reason: "Create the requested page directly.",
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: {
            path: "index.html",
            content: "<!doctype html><title>Newsletter</title>",
          },
        },
      });
    },
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  assert.equal(transition.nextStepAgent, "agent.exec.dispatch");
  assert.equal(requestCount, 1);
  const nextAction = (transition.statePatch?.agent as Record<string, unknown>).nextAction as Record<string, unknown>;
  assert.equal(nextAction.kind, "tool");
  assert.equal(nextAction.name, "fs.write_text");
});

test("compileIntent rejects fs.mkdir on the already-provisioned workspace root", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        workspaceRoot: "/repo",
        executionIntent: {
          objective: "Scaffold the app in the empty workspace.",
          candidateTools: ["fs.mkdir", "dev.shell.run"],
          operationIntent: { kind: "scaffold_app" },
        },
        output: {
          version: "v2",
          plan: {
            intent: "Prepare the workspace root.",
            successCriteria: ["The app scaffold can start."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "tool",
            name: "fs.mkdir",
            input: {
              path: ".",
            },
          },
          reason: "Create the workspace directory before scaffolding.",
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "fs.mkdir",
            description: "Create a directory.",
            capabilityClasses: ["filesystem.write"],
            executionClass: "sandboxed_only",
          },
          {
            name: "dev.shell.run",
            description: "Run a shell command.",
            capabilityClasses: ["workspace.write", "shell.exec"],
            executionClass: "external_side_effect",
          },
        ],
        availableTools: [MKDIR_TOOL, DEV_SHELL_RUN_TOOL],
      }),
    /already-provisioned workspace root/u,
  );
});

test("compileIntent allows finalization when malformed optional browser evidence is dropped", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      plan: {
        intent: "Finalize browser work.",
        successCriteria: ["The browser behavior is verified."],
      },
      requiredCapabilities: ["browser.automation"],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
        browserEvidence: { url: "http://localhost:3000" },
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
      reason: "The browser work is complete.",
    },
    observedCapabilities: ["browser.automation"],
    capabilityManifest: [
      {
        name: "browser.open",
        description: "Open a browser",
        capabilityClasses: ["browser.automation"],
        executionClass: "external_side_effect",
      },
    ],
    availableTools: [],
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: true, kinds: ["browser"] },
    },
  });

  assert.equal(compiled.action?.kind, "finalize");
  assert.equal(compiled.verification.browserEvidence, undefined);
});

test("agent loop hard fails after validation retry exhaustion", async () => {
  const exhaustedContext = context();
  exhaustedContext.session.state.agent = {
    nextAction: {
      kind: "tool",
      name: "fs.read_text",
      input: { path: "STALE.md" },
    },
    retryContext: {
      loopAttempt: 4,
      maxLoopAttempts: 4,
      failure: {
        code: "DECISION_POLICY_FAILED",
        message: "Previous validation failure.",
      },
    },
  };

  const transition = await buildStep()(exhaustedContext, {
    useModel: async () => modelResponse({
      version: "v1",
      reason: "Still choose a missing tool.",
      nextAction: {
        kind: "tool",
        name: "fs.missing",
        input: {},
      },
    }),
  } satisfies StepIO);

  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  const terminal = agent.terminal as Record<string, unknown>;
  const observations = agent.observations as Record<string, unknown>[];
  assert.equal(transition.status, "FAILED");
  assert.equal(transition.nextStepAgent, undefined);
  assert.equal(lastActionResult.kind, "validation_feedback");
  assert.equal((lastActionResult.error as Record<string, unknown>).code, "AGENT_VALIDATION_RETRY_EXHAUSTED");
  assert.equal(typeof lastActionResult.timestamp, "string");
  assert.equal(terminal.reasonCode, "AGENT_VALIDATION_RETRY_EXHAUSTED");
  assert.equal((agent.retryContext as Record<string, unknown>).loopAttempt, 5);
  assert.equal(observations.at(-1)?.kind, "validation_feedback");
  assert.equal(observations.at(-1)?.errorCode, "AGENT_VALIDATION_RETRY_EXHAUSTED");
  assert.equal(typeof observations.at(-1)?.timestamp, "string");
  assert.equal(agent.nextAction, undefined);
});
