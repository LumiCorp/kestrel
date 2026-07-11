import test from "node:test";
import assert from "node:assert/strict";

import type { StepContext, StepIO } from "../../src/kestrel/contracts/execution.js";

import {
  createExecDispatchStep,
  createExecFinalizeStep,
} from "../../agents/reference-react/src/steps/execStates.js";
import { appendToolObservations } from "../../agents/reference-react/src/steps/acter/resultShaping.js";

const BASE_CONTEXT: StepContext = {
  runId: "run-1",
  session: {
    sessionId: "session-1",
    version: 1,
    state: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "code.execute",
          input: {
            language: "javascript",
            code: "console.log('ok')",
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
    episodicRef: "",
    semanticRef: "",
  },
  budget: {
    remainingMs: 10_000,
    tokensUsed: 0,
    toolCallsUsed: 0,
  },
};

test("tool observations keep compact filesystem input and output facts", () => {
  const observations = appendToolObservations({}, [
    {
      toolName: "fs.replace_text",
      input: {
        path: "/app/input.tex",
        find: "privileged",
        replace: "special",
        all: true,
      },
      output: {
        path: "/app/input.tex",
        replacements: 1,
        changed: true,
        status: "OK",
        message: "Replaced 1 occurrence.",
        findWhitespaceTokenCount: 1,
        replaceWhitespaceTokenCount: 1,
        perReplacementWhitespaceTokenDelta: 0,
        bytesBefore: 31,
        bytesAfter: 27,
        lineCountBefore: 2,
        lineCountAfter: 2,
        whitespaceTokenCountBefore: 4,
        whitespaceTokenCountAfter: 4,
        lineCountDelta: 0,
        whitespaceTokenCountDelta: 0,
        content: "x".repeat(10_000),
      },
      capabilityClasses: ["filesystem.write"],
    },
    {
      toolName: "fs.search_text",
      input: {
        path: "/app/synonyms.txt",
        query: "privileged",
      },
      output: {
        path: "/app/synonyms.txt",
        query: "privileged",
        matches: [],
      },
      capabilityClasses: ["filesystem.read"],
    },
    {
      toolName: "fs.write_text",
      input: {
        path: "/app/input.tex",
        content: "alpha gamma\n",
        mode: "overwrite",
      },
      output: {
        path: "/app/input.tex",
        mode: "overwrite",
        bytesWritten: 12,
        existed: true,
        changed: true,
        bytesBefore: 17,
        bytesAfter: 12,
        lineCountBefore: 2,
        lineCountAfter: 2,
        whitespaceTokenCountBefore: 3,
        whitespaceTokenCountAfter: 2,
        diffPreview: {
          before: "alpha beta gamma\n",
          after: "alpha gamma\n",
          truncated: false,
        },
        content: "x".repeat(10_000),
      },
      capabilityClasses: ["filesystem.write"],
    },
  ]) as Array<Record<string, unknown>>;

  const replaceObservation = observations[0] as Record<string, unknown>;
  const replaceInput = replaceObservation.input as Record<string, unknown>;
  const replaceOutput = replaceObservation.output as Record<string, unknown>;
  assert.deepEqual(replaceInput, {
    path: "/app/input.tex",
    find: "privileged",
    replace: "special",
    all: true,
  });
  assert.deepEqual(replaceOutput, {
    path: "/app/input.tex",
    replacements: 1,
    changed: true,
    status: "OK",
    message: "Replaced 1 occurrence.",
    findWhitespaceTokenCount: 1,
    replaceWhitespaceTokenCount: 1,
    perReplacementWhitespaceTokenDelta: 0,
    bytesBefore: 31,
    bytesAfter: 27,
    lineCountBefore: 2,
    lineCountAfter: 2,
    whitespaceTokenCountBefore: 4,
    whitespaceTokenCountAfter: 4,
    lineCountDelta: 0,
    whitespaceTokenCountDelta: 0,
  });
  assert.equal(Object.hasOwn(replaceOutput, "content"), false);

  const searchObservation = observations[1] as Record<string, unknown>;
  const searchOutput = searchObservation.output as Record<string, unknown>;
  assert.deepEqual(searchObservation.input, {
    path: "/app/synonyms.txt",
    query: "privileged",
  });
  assert.deepEqual(searchOutput, {
    path: "/app/synonyms.txt",
    query: "privileged",
    matchCount: 0,
    matches: [],
    matchesTruncated: false,
  });

  const writeObservation = observations[2] as Record<string, unknown>;
  const writeInput = writeObservation.input as Record<string, unknown>;
  const writeOutput = writeObservation.output as Record<string, unknown>;
  assert.deepEqual(writeInput, {
    path: "/app/input.tex",
    mode: "overwrite",
    contentBytes: 12,
    contentPreview: "alpha gamma\n",
  });
  assert.deepEqual(writeOutput, {
    path: "/app/input.tex",
    mode: "overwrite",
    bytesWritten: 12,
    existed: true,
    changed: true,
    bytesBefore: 17,
    bytesAfter: 12,
    lineCountBefore: 2,
    lineCountAfter: 2,
    whitespaceTokenCountBefore: 3,
    whitespaceTokenCountAfter: 2,
    diffPreviewBefore: "alpha beta gamma\n",
    diffPreviewAfter: "alpha gamma\n",
    diffPreviewTruncated: false,
  });
  assert.equal(Object.hasOwn(writeOutput, "content"), false);
});

test("exec.dispatch preserves replace operands in compact last action input", async () => {
  const step = createExecDispatchStep(buildExecConfig());
  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "fs.replace_text",
            input: {
              path: "/app/input.tex",
              find: "privileged",
              replace: "special",
              all: true,
            },
          },
        },
      },
    },
  };

  const transition = await step(context, {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      assert.equal(name, "fs.replace_text");
      assert.deepEqual(input, {
        path: "/app/input.tex",
        find: "privileged",
        replace: "special",
        all: true,
      });
      return {
        path: "/app/input.tex",
        replacements: 1,
        changed: true,
        status: "OK",
        message: "Replaced 1 occurrence.",
      } as T;
    },
  } satisfies StepIO);

  assert.equal(transition.status, "RUNNING");
  const agent = transition.statePatch?.agent as Record<string, unknown>;
  const lastActionResult = agent.lastActionResult as Record<string, unknown>;
  assert.deepEqual(lastActionResult.input, {
    path: "/app/input.tex",
    find: "privileged",
    replace: "special",
    all: true,
  });
});

const WEB_GENERATIVE_UI_CAPABILITIES = {
  surface: "web",
  generativeUi: {
    enabled: true,
  },
};

function buildExecConfig() {
  return {
    deliberationStepId: "agent.loop",
    loopStepId: "agent.loop",
    effectResultLookupTool: "effect_result_lookup",
    finalizeToolName: "FinalizeAnswer",
    capabilityManifestProvider: () => [
      {
        name: "code.execute",
        capabilityClasses: ["code.execute", "code.sandbox"],
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

async function runFinalizeWithReactState(reactState: Record<string, unknown>) {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: reactState,
      },
    },
  };

  const transition = await step(context, io);
  return {
    transition,
    finalizedPayload,
  };
}

test("exec.dispatch emits code execution artifacts when code.execute returns retained outputs", async () => {
  const step = createExecDispatchStep(buildExecConfig());

  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(_name: string, _input: unknown): Promise<T> =>
      ({
        status: "ok",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 100,
        summary: "ran successfully",
        policy: {
          language: "javascript",
        },
        retention: {
          persistSummary: true,
          persistArtifacts: true,
        },
        artifacts: [
          {
            path: "output.txt",
            sizeBytes: 2,
            sha256: "abc",
            preview: {
              text: "ok",
              truncated: false,
            },
          },
        ],
      }) as T,
  };

  const transition = await step(BASE_CONTEXT, io);

  assert.equal(transition.status, "RUNNING");
  assert.equal(Array.isArray(transition.artifacts), true);
  assert.equal(transition.artifacts?.length, 2);
  assert.equal(transition.artifacts?.[0]?.type, "code.execution.summary");
  assert.equal(transition.artifacts?.[1]?.type, "code.execution.file");
});

test("exec.finalize merges explicit artifacts and manifest-promoted code artifacts", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Here is your UI artifact",
              data: {
                ui: {
                  artifacts: [
                    {
                      id: "explicit-1",
                      kind: "html",
                      source: { type: "finalize" },
                      html: "<div>explicit</div>",
                    },
                  ],
                },
              },
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "code.execute",
            output: {
              status: "ok",
              exitCode: 0,
              stdout:
                "done\nKCHAT_ARTIFACT_MANIFEST: {\"version\":\"v1\",\"artifacts\":[{\"kind\":\"html\",\"title\":\"Manifest UI\",\"html\":\"<button>Go</button>\"},{\"kind\":\"console\",\"title\":\"Run Log\"}]}",
              stderr: "",
              durationMs: 42,
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  const ui = (data.ui ?? {}) as Record<string, unknown>;
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 3);
  assert.equal(artifacts[0]?.id, "explicit-1");
  assert.equal(artifacts[1]?.kind, "html");
  assert.equal(artifacts[2]?.kind, "console");
});

test("exec.finalize uses the latest valid manifest line when a trailing manifest line is malformed", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Manifest parse fallback.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "code.execute",
            output: {
              status: "ok",
              exitCode: 0,
              stdout:
                "done\nKCHAT_ARTIFACT_MANIFEST: {\"version\":\"v1\",\"artifacts\":[{\"kind\":\"console\",\"title\":\"Run Log\"}]}\nKCHAT_ARTIFACT_MANIFEST: {\"version\":\"v1\",\"artifacts\":[",
              stderr: "",
              durationMs: 21,
              artifacts: [],
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "console");
});

test("exec.finalize does not require manifest for code.execute runs without retained artifacts", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Computation complete.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "code.execute",
            output: {
              status: "ok",
              exitCode: 0,
              stdout: "count: 1000",
              stderr: "",
              durationMs: 18,
              artifacts: [],
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  const ui = asRecordOrUndefined(data.ui);
  assert.equal(ui?.artifacts, undefined);
});

test("exec.finalize skips unresolved manifest html filePath artifacts instead of failing", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Handle unresolved html file path.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "code.execute",
            output: {
              status: "ok",
              exitCode: 0,
              stdout:
                "done\nKCHAT_ARTIFACT_MANIFEST: {\"version\":\"v1\",\"artifacts\":[{\"kind\":\"html\",\"title\":\"UI\",\"filePath\":\"index.html\"},{\"kind\":\"console\",\"title\":\"Run Log\"}]}",
              stderr: "",
              durationMs: 31,
              artifacts: [
                {
                  path: "index.html",
                  preview: {
                    text: "<div>partial</div>",
                    truncated: true,
                  },
                },
              ],
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "console");
});

test("exec.finalize does not require a code.execute artifact manifest", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Fallback artifact",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "code.execute",
            output: {
              status: "error",
              exitCode: 1,
              stdout: "failed",
              stderr: "boom",
              durationMs: 11,
              artifacts: [
                {
                  path: "index.html",
                  preview: {
                    text: "<div>fallback</div>",
                    truncated: false,
                  },
                },
              ],
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 0);
});

test("exec.finalize promotes settled dev.process.read output into console artifacts", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Shell command finished.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "dev.process.read",
            output: {
              processId: "proc-1",
              status: "COMPLETED",
              exitCode: 0,
              chunk: "pnpm run test\nPASS tests/unit/demo.test.ts\n",
              truncated: false,
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = asRecordOrUndefined(finalizedPayload?.data) ?? {};
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "console");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.type, "finalize");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.toolName, "dev.process.read");
  assert.equal(artifacts[0]?.status, "ok");
  assert.equal(artifacts[0]?.exitCode, 0);
  assert.match(String(artifacts[0]?.stdout ?? ""), /PASS tests\/unit\/demo\.test\.ts/u);
  assert.doesNotMatch(String(artifacts[0]?.stdout ?? ""), /__KESTREL_CMD_DONE__/u);
});

test("exec.finalize promotes settled dev.shell.run text into console artifacts", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Shell command finished.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "dev.shell.run",
            output: {
              status: "COMPLETED",
              exitCode: 0,
              text: "pnpm test\nPASS tests/unit/demo.test.ts\n",
              truncated: false,
              command: "pnpm test",
              cwd: "/workspace",
              workspaceRoot: "/workspace",
              completedAt: "2026-06-15T12:00:00.000Z",
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = asRecordOrUndefined(finalizedPayload?.data) ?? {};
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "console");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.type, "finalize");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.toolName, "dev.shell.run");
  assert.equal(artifacts[0]?.status, "ok");
  assert.equal(artifacts[0]?.exitCode, 0);
  assert.match(String(artifacts[0]?.stdout ?? ""), /PASS tests\/unit\/demo\.test\.ts/u);
  assert.match(String(artifacts[0]?.text ?? ""), /PASS tests\/unit\/demo\.test\.ts/u);
  assert.deepEqual((artifacts[0]?.toolContext as Record<string, unknown>)?.command, "pnpm test");
  assert.deepEqual((artifacts[0]?.toolContext as Record<string, unknown>)?.cwd, "/workspace");
});

test("exec.finalize promotes settled exec_command output into console artifacts", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Command finished.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "exec_command",
            output: {
              status: "completed",
              sessionId: "exec-1",
              exitCode: 0,
              output: "pnpm test\nPASS tests/unit/demo.test.ts\n",
              durationMs: 42,
              truncated: false,
              command: "pnpm test",
              cwd: "/workspace",
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = asRecordOrUndefined(finalizedPayload?.data) ?? {};
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "console");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.type, "finalize");
  assert.equal((artifacts[0]?.source as Record<string, unknown>)?.toolName, "exec_command");
  assert.equal(artifacts[0]?.status, "ok");
  assert.equal(artifacts[0]?.exitCode, 0);
  assert.match(String(artifacts[0]?.stdout ?? ""), /PASS tests\/unit\/demo\.test\.ts/u);
  assert.equal((artifacts[0]?.toolContext as Record<string, unknown>)?.processId, "exec-1");
  assert.equal((artifacts[0]?.toolContext as Record<string, unknown>)?.sessionId, "exec-1");
});

test("exec.finalize fills explicit empty dev-shell console artifacts with promoted output", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Shell command finished.",
              data: {
                ui: {
                  artifacts: [
                    {
                      id: "dev-shell-console",
                      kind: "console",
                      title: "Dev Shell Output",
                      source: { type: "finalize", toolName: "dev.shell.run" },
                      status: "ok",
                      exitCode: 0,
                    },
                  ],
                },
              },
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "dev.shell.run",
            output: {
              status: "COMPLETED",
              exitCode: 0,
              text: "pnpm test\nPASS tests/unit/demo.test.ts\n",
              truncated: false,
              command: "pnpm test",
              cwd: "/workspace",
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = asRecordOrUndefined(finalizedPayload?.data) ?? {};
  const ui = asRecordOrUndefined(data.ui) ?? {};
  const artifacts = (ui.artifacts ?? []) as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.id, "dev-shell-console");
  assert.equal(artifacts[0]?.kind, "console");
  assert.equal(artifacts[0]?.title, "Dev Shell Output");
  assert.equal(artifacts[0]?.status, "ok");
  assert.equal(artifacts[0]?.exitCode, 0);
  assert.match(String(artifacts[0]?.stdout ?? ""), /PASS tests\/unit\/demo\.test\.ts/u);
  assert.equal((artifacts[0]?.toolContext as Record<string, unknown>)?.command, "pnpm test");
});

test("exec.finalize skips dev.shell console artifact promotion while a command is still active", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Shell command still running.",
            },
          },
          lastActionResult: {
            kind: "tool",
            name: "dev.process.read",
            output: {
              processId: "proc-1",
              status: "RUNNING",
              chunk: "running...",
              truncated: false,
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload !== undefined, true);
  const data = asRecordOrUndefined(finalizedPayload?.data) ?? {};
  const ui = asRecordOrUndefined(data.ui);
  assert.equal(ui?.artifacts, undefined);
});

test("exec.finalize synthesizes only a capped link_list from raw internet.search results", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Search complete.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.search",
      output: {
        status: "ok",
        query: "kestrel",
        results: Array.from({ length: 10 }, (_item, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.com/article-${index + 1}`,
          snippet: `Snippet ${index + 1}`,
        })),
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["link_list"],
  );
  const links = asArray(blocks[0]?.links).map((item) => asRecordOrUndefined(item));
  assert.equal(links.length, 8);
  assert.equal(links[0]?.url, "https://example.com/article-1");
  assert.equal(links[7]?.url, "https://example.com/article-8");
  assert.equal(blocks.some((block) => block.kind === "web_preview"), false);
});

test("exec.finalize emits warning status block for degraded url-list tool output", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Source degraded.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.news",
      output: {
        status: "degraded",
        query: "latest",
        results: [],
        degraded: {
          code: "provider_network_error",
          message: "Temporary upstream outage",
        },
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "status");
  assert.equal(blocks[0]?.value, "warn");
  assert.equal(blocks[0]?.tone, "warn");
});

test("exec.finalize persists resumable follow-up contract for non-success finalization", async () => {
  const { transition } = await runFinalizeWithReactState({
    goal: "can you give me the news for the US this morning?",
    observations: [
      {
        kind: "tool_result",
        stepIndex: 3,
        toolName: "internet.news",
        status: "passed",
        capabilityClasses: ["news.headlines"],
      },
      {
        kind: "tool_result",
        stepIndex: 8,
        toolName: "internet.news",
        status: "passed",
        outputSummary: "News retrieval succeeded but no user-facing summary has been composed.",
        capabilityClasses: ["news.search"],
      },
    ],
    nextAction: {
      kind: "finalize",
      finalizeReason: "out_of_scope",
      input: {
        message: "I cannot summarize yet. If you want, I can continue by gathering fresh US headlines and then summarize them cautiously.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.news",
      outputSummary: "News retrieval succeeded but no user-facing summary has been composed.",
      capabilityClasses: ["news.search"],
      output: {
        status: "ok",
        results: [
          {
            title: "US headline",
            url: "https://example.com/us-headline",
          },
        ],
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const exec = react.exec as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  assert.equal(react.resumableFollowUp, undefined);
  assert.equal(exec.pendingBatch, undefined);
  assert.equal(lastCheckpoint.substate, "finalize");
  assert.equal(workingPlan.status, "finalizing");
});

test("exec.finalize does not persist plan handoff follow-up for plain plan-mode completion", async () => {
  const originalObjective = "Build a polished landing page for the local demo app.";
  const planText = [
    "Plan:",
    "1. Inspect the current app structure.",
    "2. Implement the landing page.",
    "3. Run the focused UI checks.",
  ].join("\n");
  const { transition } = await runFinalizeWithReactState({
    interactionMode: "plan",
    goal: originalObjective,
    plan: {
      intent: originalObjective,
      successCriteria: ["The landing page is implemented", "Focused checks pass"],
    },
    nextAction: {
      kind: "finalize",
      finalizeReason: "goal_satisfied",
      input: {
        message: planText,
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  assert.equal(react.resumableFollowUp, undefined);
});

test("exec.cannot_satisfy persists resumable follow-up contract", async () => {
  const step = createExecFinalizeStep(buildExecConfig());
  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          goal: "can you give me the news for the US this morning?",
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "insufficient_horizon",
            message: "I can't give you current US morning news without a fresh follow-up run.",
          },
          observations: [
            {
              kind: "tool_result",
              stepIndex: 8,
              toolName: "internet.news",
              status: "passed",
              outputSummary: "News retrieval succeeded but the summary is not complete.",
              capabilityClasses: ["news.search"],
            },
          ],
        },
      },
    },
  };

  const transition = await step(context, {
    async useModel() {
      throw new Error("not expected");
    },
    async useTool<T>(_name: string, input: unknown): Promise<T> {
      return input as T;
    },
  });

  const react = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const commandProcessor = react.commandProcessor as Record<string, unknown>;
  const lastCheckpoint = commandProcessor.lastCheckpoint as Record<string, unknown>;
  const workingPlan = react.workingPlan as Record<string, unknown>;
  assert.equal(react.resumableFollowUp, undefined);
  assert.equal(lastCheckpoint.substate, "finalize");
  assert.equal(workingPlan.status, "finalizing");
});

test("exec.finalize synthesizes fetch status, capped summary excerpt, and preview for internet.extract", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Fetched article.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.extract",
      output: {
        status: "ok",
        url: "https://example.com/story",
        title: "Example Story",
        quality: "low",
        truncated: true,
        content: "x".repeat(400),
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["status", "summary", "web_preview"],
  );
  assert.equal(blocks[0]?.value, "warn");
  assert.equal(blocks[1]?.title, "Example Story");
  assert.equal(String(blocks[1]?.body ?? "").length <= 280, true);
  assert.equal(blocks[2]?.url, "https://example.com/story");
});

test("exec.finalize synthesizes evidence summary and strength-bound metrics", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Evidence extracted.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "evidence.extract",
      output: {
        claim: "Automation cut onboarding time.",
        sourceId: "src-12",
        items: [
          { id: "e1", evidenceStrength: 0.75, text: "A" },
          { id: "e2", evidenceStrength: 0.125, text: "B" },
        ],
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["summary", "metric_list"],
  );
  assert.match(String(blocks[0]?.body ?? ""), /Claim:/u);
  assert.match(String(blocks[0]?.body ?? ""), /Source:/u);
  const metrics = asArray(blocks[1]?.metrics).map((metric) => asRecordOrUndefined(metric) ?? {});
  assert.deepEqual(
    metrics.map((metric) => [metric.label, metric.value]),
    [
      ["Extracted items", "2"],
      ["Min strength", "0.1250"],
      ["Max strength", "0.7500"],
    ],
  );
});

test("exec.finalize synthesizes fs.search_text metrics and capped formatted code preview", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Filesystem search complete.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "fs.search_text",
      output: {
        path: "src",
        query: "needle",
        matches: Array.from({ length: 15 }, (_item, index) => ({
          path: "src/app.ts",
          line: index + 1,
          column: 1,
          preview: `needle ${index + 1}`,
        })),
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["metric_list", "code_preview"],
  );
  const metrics = asArray(blocks[0]?.metrics).map((metric) => asRecordOrUndefined(metric) ?? {});
  assert.deepEqual(
    metrics.map((metric) => [metric.label, metric.value]),
    [
      ["Path", "src"],
      ["Query", "needle"],
      ["Match count", "15"],
    ],
  );
  const codeLines = String(blocks[1]?.code ?? "").split("\n");
  assert.equal(codeLines.length, 12);
  assert.equal(codeLines[0], "src/app.ts:1:1 | needle 1");
  assert.equal(codeLines[11], "src/app.ts:12:1 | needle 12");
});

test("exec.finalize appends runtime-synthesized blocks after model blocks and preserves tool_batch order", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: WEB_GENERATIVE_UI_CAPABILITIES,
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Batched synthesis done.",
        data: {
          ui: {
            blocks: [
              {
                kind: "summary",
                title: "Model block",
                body: "Comes first",
              },
            ],
          },
        },
      },
    },
    lastActionResult: {
      kind: "tool_batch",
      items: [
        {
          name: "internet.search",
          output: {
            status: "ok",
            results: [
              {
                title: "Source A",
                url: "https://example.com/a",
                snippet: "A",
              },
            ],
          },
        },
        {
          name: "free.time.current",
          output: {
            timezone: "Etc/UTC",
          },
        },
        {
          name: "source.fetch",
          output: {
            url: "https://example.com/b",
            title: "Source B",
            content: "Fetched body",
          },
        },
        {
          name: "evidence.extract",
          output: {
            claim: "Claim B",
            sourceId: "src-b",
            items: [{ id: "i-1", evidenceStrength: 0.5, text: "x" }],
          },
        },
      ],
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    [
      "summary",
      "link_list",
      "status",
      "summary",
      "web_preview",
      "summary",
      "metric_list",
    ],
  );
  assert.equal(blocks[0]?.title, "Model block");
});

test("exec.finalize drops synthesized blocks when generative UI is disabled", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: {
        surface: "web",
        generativeUi: {
          enabled: false,
        },
      },
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "No generative ui.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.search",
      output: {
        status: "ok",
        results: [
          {
            title: "Source A",
            url: "https://example.com/a",
          },
        ],
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const data = asRecordOrUndefined(finalizedPayload?.data);
  assert.equal(asRecordOrUndefined(data?.ui), undefined);
});

test("exec.finalize filters synthesized blocks by supported block kinds", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    contextCache: {
      clientCapabilities: {
        surface: "web",
        generativeUi: {
          enabled: true,
          supportedBlocks: ["status"],
        },
      },
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Status only.",
      },
    },
    lastActionResult: {
      kind: "tool",
      name: "internet.extract",
      output: {
        status: "ok",
        url: "https://example.com/a",
        title: "A",
        content: "body",
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const blocks = readFinalizeUiBlocks(finalizedPayload);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "status");
});

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFinalizeUiBlocks(
  finalizedPayload: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  const data = asRecordOrUndefined(finalizedPayload?.data);
  const ui = asRecordOrUndefined(data?.ui);
  return asArray(ui?.blocks)
    .map((item) => asRecordOrUndefined(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

test("exec.finalize preserves model-provided phrasing without post-processing rewrites", async () => {
  const step = createExecFinalizeStep({
    ...buildExecConfig(),
    capabilityManifestProvider: () => [
      {
        name: "free.time.current",
        freshnessClass: "live",
        capabilityClasses: ["time.current"],
      },
    ],
  });

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message:
                "I can't access live data right now. I can still help once you share the exact task.",
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  assert.equal(
    finalizedPayload?.message,
    "I can't access live data right now. I can still help once you share the exact task.",
  );
  const reactPatch = (transition.statePatch?.agent ?? {}) as Record<string, unknown>;
  const decisionTrace = Array.isArray(reactPatch.decisionTrace)
    ? (reactPatch.decisionTrace as Array<Record<string, unknown>>)
    : [];
  const metadata = (decisionTrace[0]?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.messageGuardRewritten, undefined);
});

test("exec.finalize forwards coding finalize data fields for operator/API handoff", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Implemented task with pending verification.",
              data: {
                summary: "Updated planner and agent loop coding behavior.",
                changedFiles: ["src/app.ts"],
                checksRun: ["pnpm test"],
                checksFailed: [],
                blockers: [],
                residualRisks: ["Full suite not run yet"],
                completionState: "implemented_not_verified",
              },
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);
  assert.equal(transition.status, "COMPLETED");

  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.equal(data.summary, "Updated planner and agent loop coding behavior.");
  assert.equal(data.changedFiles, undefined);
  assert.equal(data.checksRun, undefined);
  assert.equal(data.checksFailed, undefined);
  assert.deepEqual(data.blockers, []);
  assert.deepEqual(data.residualRisks, ["Full suite not run yet"]);
  assert.equal(data.completionState, "implemented_not_verified");
  const finalizeInputData = ((data.finalizeInput as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
  assert.equal(finalizeInputData.changedFiles, undefined);
  assert.equal(finalizeInputData.checksRun, undefined);
  assert.equal(finalizeInputData.checksFailed, undefined);
});

test("exec.finalize dispatches implemented_and_verified without runtime proof-token gates", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    decisionVerification: {
      verificationSteps: ["verify:newsletter-report.json::stories", "check:pnpm build"],
      expectedRepoDelta: ["file:newsletter-report.json"],
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "Verified newsletter work is complete.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  assert.equal(finalizedPayload?.message, "Verified newsletter work is complete.");
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.equal(data.completionState, "implemented_and_verified");
});

test("exec.finalize reports available evidence without requiring every claimed process token", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    decisionVerification: {
      verificationSteps: ["verify:newsletter-report.json::stories", "check:pnpm build"],
      expectedRepoDelta: ["file:newsletter-report.json"],
    },
    evidenceLedger: [
      {
        id: "ev_newsletter_write",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "tool",
        kind: "tool_result",
        status: "passed",
        summary: "Wrote newsletter report.",
        target: {
          type: "path",
          value: "newsletter-report.json",
          normalizedValue: "newsletter-report.json",
        },
        facts: {
          toolName: "fs.write_text",
          inputPath: "newsletter-report.json",
        },
      },
      {
        id: "ev_newsletter_verification",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "runtime",
        kind: "artifact_verification",
        status: "passed",
        summary: "Verified grounded newsletter report.",
        target: {
          type: "artifact",
          value: "newsletter-report.json::stories",
          normalizedValue: "newsletter-report.json::stories",
        },
        facts: {
          target: "newsletter-report.json::stories",
          status: "passed",
        },
      },
    ],
    nextAction: {
      kind: "finalize",
      input: {
        message: "Verified newsletter work is complete.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.deepEqual(data.artifactVerification, {
    target: "newsletter-report.json::stories",
    status: "passed",
  });
});

test("exec.finalize accepts runtime artifact verification evidence and forwards it in the payload", async () => {
  const { transition, finalizedPayload } = await runFinalizeWithReactState({
    decisionVerification: {
      verificationSteps: ["verify:newsletter-report.json::stories", "check:pnpm build"],
      expectedRepoDelta: ["file:newsletter-report.json"],
    },
    evidenceLedger: [
      {
        id: "ev_newsletter_write",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "tool",
        kind: "tool_result",
        status: "passed",
        summary: "Wrote newsletter report.",
        target: {
          type: "path",
          value: "newsletter-report.json",
          normalizedValue: "newsletter-report.json",
        },
        facts: {
          toolName: "fs.write_text",
          inputPath: "newsletter-report.json",
        },
      },
      {
        id: "ev_newsletter_build",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "tool",
        kind: "process_result",
        status: "passed",
        summary: "pnpm build completed.",
        target: {
          type: "process",
          value: "process-1",
          normalizedValue: "process-1",
        },
        facts: {
          toolName: "dev.shell.run",
          command: "pnpm build",
          exitCode: 0,
        },
      },
      {
        id: "ev_newsletter_tool_result",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "tool",
        kind: "tool_result",
        status: "passed",
        summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
        target: {
          type: "tool",
          value: "fs.verify_json",
          normalizedValue: "fs.verify_json",
        },
        facts: {
          toolName: "fs.verify_json",
        },
      },
      {
        id: "ev_newsletter_verification",
        version: "v1",
        createdAt: "2026-05-26T00:00:00.000Z",
        source: "runtime",
        kind: "artifact_verification",
        status: "passed",
        summary: "Verified grounded newsletter report.",
        target: {
          type: "artifact",
          value: "newsletter-report.json::stories",
          normalizedValue: "newsletter-report.json::stories",
        },
        facts: {
          target: "newsletter-report.json::stories",
          status: "passed",
          evidence: {
            kind: "tool_result",
            toolName: "fs.verify_json",
            summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
          },
          requirements: [
            {
              id: "min_length",
              expectation: "Array contains at least 10 item(s).",
              observed: "Array contains 10 item(s).",
              status: "passed",
            },
          ],
        },
      },
    ],
    nextAction: {
      kind: "finalize",
      input: {
        message: "Verified newsletter work is complete.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    },
  });

  assert.equal(transition.status, "COMPLETED");
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.deepEqual(data.artifactVerification, {
    target: "newsletter-report.json::stories",
    status: "passed",
    evidence: {
      kind: "tool_result",
      toolName: "fs.verify_json",
      summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
    },
    requirements: [
      {
        id: "min_length",
        expectation: "Array contains at least 10 item(s).",
        observed: "Array contains 10 item(s).",
        status: "passed",
      },
    ],
  });
  assert.deepEqual(data.toolEvidenceSummary, {
    successfulCalls: [
      { toolName: "dev.shell.run", count: 1 },
      { toolName: "fs.verify_json", count: 1 },
      { toolName: "fs.write_text", count: 1 },
    ],
    failedCalls: [],
  });
});

test("exec.finalize persists plainText alongside rich ui blocks", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          nextAction: {
            kind: "finalize",
            input: {
              message: "Here is the plan:",
              data: {
                ui: {
                  blocks: [
                    {
                      kind: "steps",
                      title: "Plan",
                      items: ["Inspect the workspace", "Build the page"],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.equal(data.plainText, ["Plan", "- Inspect the workspace", "- Build the page"].join("\n"));
});

test("exec.finalize does not synthesize session-note text from structured progress", async () => {
  const step = createExecFinalizeStep(buildExecConfig());

  let finalizedPayload: Record<string, unknown> | undefined;
  const io: StepIO = {
    useModel: async () => {
      throw new Error("not expected");
    },
    useTool: async <T>(name: string, input: unknown): Promise<T> => {
      if (name === "FinalizeAnswer") {
        finalizedPayload = input as Record<string, unknown>;
        return input as T;
      }
      throw new Error(`Unexpected tool '${name}'`);
    },
  };

  const context: StepContext = {
    ...BASE_CONTEXT,
    session: {
      ...BASE_CONTEXT.session,
      state: {
        agent: {
          interactionMode: "plan",
          goal: "Produce a durable plan",
          plan: {
            intent: "Produce a durable plan",
          },
          progress: {
            objective: "Produce a durable plan",
            items: [
              { label: "Inspect the workspace", status: "active" },
              { label: "Validate the result", status: "done" },
            ],
          },
          decisionVerification: {
            verificationSteps: ["check:pnpm run test -- tests/unit/react-acter-code-artifacts.test.ts"],
          },
          nextAction: {
            kind: "finalize",
            input: {
              message: "Here is the plan.",
            },
          },
        },
      },
    },
  };

  const transition = await step(context, io);

  assert.equal(transition.status, "COMPLETED");
  const data = (finalizedPayload?.data ?? {}) as Record<string, unknown>;
  assert.equal(data.workPlan, undefined);
  assert.deepEqual(data.decisionVerification, {
    verificationSteps: ["check:pnpm run test -- tests/unit/react-acter-code-artifacts.test.ts"],
  });
  assert.equal(data.plainText, undefined);
});
