import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReasoningPromptContext,
  ModelReasoningSidecar,
  selectReasoningMilestone,
  validateReasoningMonologue,
} from "../../src/reasoning/index.js";

test("selectReasoningMilestone emits milestone updates for meaningful runtime transitions", () => {
  const phaseChanged = selectReasoningMilestone({
    stepAgent: "agent.loop",
    previousState: {
      agent: {
        phase: "THINK",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });
  assert.equal(phaseChanged, "phase_changed");

  const toolActivity = selectReasoningMilestone({
    stepAgent: "agent.loop",
    previousState: {
      agent: {
        phase: "ACT",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "tool",
          name: "internet.search",
          input: {
            query: "sensitive query",
          },
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });
  assert.equal(toolActivity, "tool_activity");

  const sameToolDifferentTarget = selectReasoningMilestone({
    stepAgent: "agent.loop",
    previousState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "README.md" },
        },
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: "package.json" },
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });
  assert.equal(sameToolDifferentTarget, "tool_activity");

  const effectActivity = selectReasoningMilestone({
    stepAgent: "agent.exec.dispatch",
    previousState: {
      agent: {
        phase: "ACT",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
      },
    },
    transition: {
      status: "RUNNING",
      effects: [
        {
          type: "tool.execute",
          payload: {},
        },
      ],
    },
  });
  assert.equal(effectActivity, "effect_activity");

  const waitEntered = selectReasoningMilestone({
    stepAgent: "agent.exec.wait_user",
    previousState: {
      agent: {},
    },
    currentState: {
      agent: {
        wait: {
          kind: "user",
        },
      },
    },
    transition: {
      status: "WAITING",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
      },
    },
  });
  assert.equal(waitEntered, "wait_entered");

  const finalizePhase = selectReasoningMilestone({
    stepAgent: "agent.exec.finalize",
    previousState: {
      agent: {
        phase: "ACT",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "finalize",
          finalizeReason: "enough_evidence",
        },
      },
    },
    transition: {
      status: "RUNNING",
    },
  });
  assert.equal(finalizePhase, "phase_changed");

  const terminal = selectReasoningMilestone({
    stepAgent: "agent.exec.finalize",
    previousState: {
      agent: {},
    },
    currentState: {
      agent: {},
    },
    transition: {
      status: "COMPLETED",
    },
  });
  assert.equal(terminal, "run_terminal");
});

test("buildReasoningPromptContext redacts raw tool arguments and user text", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 5,
    milestone: "tool_activity",
    previousState: {
      agent: {
        phase: "THINK",
        observations: [],
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        observations: [{}],
        requiredCapabilities: ["news.headlines"],
        nextAction: {
          kind: "tool",
          name: "internet.search",
          input: {
            query: "user quoted request should never appear",
            token: "secret-value",
          },
        },
      },
      payload: {
        message: "please do not leak this user string",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      effects: [
        {
          type: "assistant.respond",
          payload: {
            raw: "also should not appear",
          },
        },
      ],
    },
    recentMessages: [
      "I traced the transcript formatter first.",
      "That path was fine, so I moved into the sidecar prompt.",
    ],
    runElapsedMs: 4_200,
    stepElapsedMs: 1_350,
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("please do not leak this user string"), false);
  assert.equal(serialized.includes("also-hidden"), false);
  assert.equal(serialized.includes("\"input\""), false);
  assert.equal(serialized.includes("internet.search"), true);
  assert.equal(serialized.includes("recentMessages"), true);
  assert.equal(serialized.includes("\"beat\""), true);
  assert.equal(serialized.includes("\"action\""), true);
  assert.equal(serialized.includes("picked up one new result"), true);
});

test("buildReasoningPromptContext prefers duplicate cached-result messaging over observation growth", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 12,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "ACT",
        observations: [{}],
        latestEvidenceDelta: {
          kind: "duplicate_cached_result",
          toolName: "internet.search",
          cachedStepIndex: 7,
        },
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        observations: [{}, {}],
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("received the same cached result again from 'internet.search'"), true);
  assert.equal(serialized.includes("picked up one new result"), false);
});

test("buildReasoningPromptContext names fresh file results from structured runtime feedback", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.exec.dispatch",
    stepIndex: 13,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "ACT",
        observations: [],
      },
    },
    currentState: {
      agent: {
        phase: "OBSERVE",
        observations: [{}],
        lastActionResult: {
          kind: "tool",
          toolName: "fs.read_text",
          input: {
            path: "src/reasoning/ReasoningSidecar.ts",
            maxBytes: 12_000,
          },
          output: {
            content: "raw file content should not appear",
          },
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(
    serialized.includes("received a result from fs.read_text for src/reasoning/ReasoningSidecar.ts"),
    true,
  );
  assert.equal(serialized.includes("raw file content should not appear"), false);
  assert.equal(serialized.includes("maxBytes"), false);
});

test("buildReasoningPromptContext grounds shell work in the current command over stale todos", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 79,
    milestone: "tool_activity",
    previousState: {
      agent: {
        phase: "LOOP",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: { path: ".kestrel/memory/current.md" },
        },
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        visibleTodos: {
          objective: "Solve the maze task",
          items: [
            {
              id: "repair-smoke",
              text: "Repair the managed maze smoke test",
              status: "in_progress",
            },
          ],
        },
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "python3 maze_solver.py 1",
            cwd: "/app",
            timeoutMs: 120000,
          },
        },
        decisionReason: "Run the maze solver after patching the renderer.",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const beat = context.beat as Record<string, unknown>;
  const action = beat.action as Record<string, unknown>;
  const target = action.target as Record<string, unknown>;
  const serialized = JSON.stringify(context);

  assert.equal(target.kind, "shell_command");
  assert.equal(target.command, "python3 maze_solver.py 1");
  assert.equal(serialized.includes("Run the maze solver after patching the renderer."), true);
  assert.equal(serialized.includes("Repair the managed maze smoke test"), true);
});

test("buildReasoningPromptContext names fresh shell command results", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.exec.wait_effect",
    stepIndex: 87,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "ACT",
        observations: [],
      },
    },
    currentState: {
      agent: {
        phase: "OBSERVE",
        observations: [{}],
        lastActionResult: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "python3 maze_solver.py 1",
            cwd: "/app",
          },
          output: {
            status: "FAILED",
            text: "raw shell output should not appear",
          },
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.collect",
    },
  });

  const serialized = JSON.stringify(context);

  assert.equal(
    serialized.includes("received a result from dev.shell.run for python3 maze_solver.py 1"),
    true,
  );
  assert.equal(serialized.includes("raw shell output should not appear"), false);
});

test("buildReasoningPromptContext does not repeat duplicate cached-result messaging after marker is consumed", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 13,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "ACT",
        observations: [{}, {}],
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        observations: [{}, {}, {}],
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("received the same cached result again"), false);
  assert.equal(serialized.includes("picked up one new result"), true);
});

test("buildReasoningPromptContext reports duplicate executed-result messaging", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 14,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "ACT",
        observations: [{}],
        latestEvidenceDelta: {
          kind: "duplicate_executed_result",
          toolName: "internet.extract",
          matchedPriorStep: 9,
        },
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        observations: [{}, {}],
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("executed 'internet.extract' again and got the same result"), true);
  assert.equal(serialized.includes("picked up one new result"), false);
});

test("buildReasoningPromptContext exposes one runtime beat without event summaries", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 7,
    milestone: "phase_changed",
    previousState: {
      agent: {
        phase: "THINK",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        visibleTodos: {
          objective: "Compare desktop reasoning updates",
          items: [
            {
              id: "compare-desktop-reasoning-updates",
              text: "Compare desktop reasoning updates",
              status: "in_progress",
            },
          ],
        },
        decisionReason: "Read the CSS file before changing the layout.",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "apps/web/app/globals.css",
          },
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("\"beat\""), true);
  assert.equal(serialized.includes("Read the CSS file before changing the layout."), true);
  assert.equal(serialized.includes("Compare desktop reasoning updates"), true);
  assert.equal(serialized.includes("fs.read_text"), true);
  assert.equal(serialized.includes("apps/web/app/globals.css"), true);
  assert.equal(serialized.includes("\"recentActivity\""), false);
  assert.equal(serialized.includes("finished 'code.execute' in 182ms"), false);
  assert.equal(serialized.includes("started step 'agent.loop'"), false);
});

test("buildReasoningPromptContext keeps step ids as metadata without semantic frame summaries", () => {
  const deliberatorContext = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 3,
    milestone: "phase_changed",
    currentState: {
      agent: {
        phase: "THINK",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
    },
  });
  const execContext = buildReasoningPromptContext({
    stepAgent: "agent.exec.dispatch",
    stepIndex: 2,
    milestone: "phase_changed",
    currentState: {
      agent: {
        phase: "THINK",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
    },
  });

  assert.deepEqual(deliberatorContext.step, {
    agent: "agent.loop",
    index: 3,
    milestone: "phase_changed",
    status: "RUNNING",
    nextStepAgent: "agent.loop",
  });
  assert.deepEqual(execContext.step, {
    agent: "agent.exec.dispatch",
    index: 2,
    milestone: "phase_changed",
    status: "RUNNING",
    nextStepAgent: "agent.loop",
  });
  assert.equal(JSON.stringify(deliberatorContext).includes("\"semanticFrame\""), false);
  assert.equal(JSON.stringify(execContext).includes("\"semanticFrame\""), false);
});

test("buildReasoningPromptContext includes wait prompt and blocked-mode guidance details", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.exec.wait_user",
    stepIndex: 8,
    milestone: "wait_entered",
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "ask_user",
          prompt:
            [
              "Question: You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
              "Reply naturally to approve the switch or run: `/mode build`",
              "The run will resume automatically.",
            ].join("\n"),
          waitFor: {
            kind: "user",
            eventType: "user.reply",
            metadata: {
              reason: "planner_mode_blocked",
              requiredToolClass: "sandboxed_only",
              toolName: "dev.shell.run",
              question:
                "You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
              resumeReply: "switch to build",
              resumeCommand: "/mode build",
              prompt:
                [
                  "Question: You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
                  "Reply naturally to approve the switch or run: `/mode build`",
                  "The run will resume automatically.",
                ].join("\n"),
            },
          },
        },
      },
    },
    transition: {
      status: "WAITING",
      nextStepAgent: "agent.exec.wait_user",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "planner_mode_blocked",
          requiredToolClass: "sandboxed_only",
          toolName: "dev.shell.run",
          question:
            "You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
          resumeReply: "switch to build",
          resumeCommand: "/mode build",
          prompt:
            [
              "Question: You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
              "Reply naturally to approve the switch or run: `/mode build`",
              "The run will resume automatically.",
            ].join("\n"),
        },
      },
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("\"prompt\":\"Question: You're in 'Plan'."), true);
  assert.equal(serialized.includes("\"reason\":\"planner_mode_blocked\""), true);
  assert.equal(serialized.includes("\"requiredToolClass\":\"sandboxed_only\""), true);
  assert.equal(serialized.includes("\"toolName\":\"dev.shell.run\""), true);
  assert.equal(serialized.includes("\"resumeReply\":\"switch to build\""), true);
  assert.equal(
    serialized.includes("\"resumeBehavior\":\"auto_resume_on_valid_mode_switch\""),
    true,
  );
});

test("buildReasoningPromptContext uses the runtime beat without event summaries", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 9,
    milestone: "tool_activity",
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "tool",
          name: "internet.search",
          input: {
            query: "should stay hidden",
          },
        },
        decisionReason: "Search current sources before answering.",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("\"beat\""), true);
  assert.equal(serialized.includes("Search current sources before answering."), true);
  assert.equal(serialized.includes("\"toolName\":\"internet.search\""), true);
  assert.equal(serialized.includes("\"narration\""), false);
  assert.equal(serialized.includes("\"trigger\""), false);
  assert.equal(serialized.includes("\"recentActivity\""), false);
  assert.equal(serialized.includes("\"semanticFrame\""), false);
});

test("buildReasoningPromptContext exposes model-authored visible todos without treating them as narration", () => {
  const context = buildReasoningPromptContext({
    stepAgent: "agent.loop",
    stepIndex: 10,
    milestone: "tool_activity",
    previousState: {
      agent: {
        phase: "ACT",
      },
    },
    currentState: {
      agent: {
        phase: "ACT",
        visibleTodos: {
          objective: "Patch reasoning sidecar",
          items: [
            {
              id: "inspect-session-note-sync",
              text: "Inspect session-note sync",
              status: "done",
            },
            {
              id: "compare-desktop-reasoning-updates",
              text: "Compare desktop reasoning updates",
              status: "in_progress",
            },
            {
              id: "patch-sidecar-contract",
              text: "Patch the sidecar contract",
              status: "pending",
            },
          ],
        },
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "src/reasoning/ReasoningSidecar.ts",
          },
        },
        decisionReason: "Read the sidecar file before patching the prompt contract.",
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  const beat = context.beat as Record<string, unknown>;
  assert.equal(beat.reason, "Read the sidecar file before patching the prompt contract.");
  assert.deepEqual(beat.task, {
    focus: {
      id: "compare-desktop-reasoning-updates",
      text: "Compare desktop reasoning updates",
      status: "in_progress",
    },
    counts: {
      done: 1,
      pending: 1,
      blocked: 0,
      total: 3,
    },
  });
  assert.equal(Object.hasOwn(context, "narration"), false);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("src/reasoning/ReasoningSidecar.ts"), true);
  assert.equal(serialized.includes("Compare desktop reasoning updates"), true);
  assert.equal(serialized.includes("Make narration task-centered"), false);
});

test("validateReasoningMonologue enforces one-to-two sentence plain text", () => {
  assert.equal(
    validateReasoningMonologue("I am narrowing to the strongest tool path. I'm ready to execute."),
    undefined,
  );
  assert.equal(
    validateReasoningMonologue("The runtime is selecting a tool."),
    undefined,
  );
  assert.equal(
    validateReasoningMonologue("I think. I decide. I execute."),
    "sentence_count",
  );
  assert.equal(
    validateReasoningMonologue("I will do this in `markdown`."),
    "markdown",
  );
  assert.equal(
    validateReasoningMonologue("I'm in the OBSERVE phase with decision confidence 0.74."),
    "internal_jargon",
  );
  assert.equal(
    validateReasoningMonologue("I'm tracing the resolve state machine to see why it loops."),
    undefined,
  );
  assert.equal(
    validateReasoningMonologue(
      "I need one change before I can continue: switch with /mode build or reply switch to build, and I'll resume automatically.",
    ),
    undefined,
  );
});

test("ModelReasoningSidecar can be disabled explicitly", async () => {
  let calls = 0;
  const sidecar = new ModelReasoningSidecar(
    ({
      call: async () => {
        calls += 1;
        return { message: "I am still thinking." };
      },
    } as any),
    { enabled: false },
  );

  const update = await sidecar.generate({
    runId: "run-disabled",
    sessionId: "session-disabled",
    seq: 1,
    milestone: "phase_changed",
    stepAgent: "agent.loop",
    stepIndex: 3,
    previousState: { agent: { phase: "THINK" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  assert.equal(update, undefined);
  assert.equal(calls, 0);
});

test("ModelReasoningSidecar can reject ambient process environment fallback", async () => {
  const previous = process.env.KCHAT_REASONING_ENABLED;
  process.env.KCHAT_REASONING_ENABLED = "false";
  let calls = 0;
  try {
    const sidecar = new ModelReasoningSidecar(
      ({
        call: async () => {
          calls += 1;
          return { message: "I am continuing with the explicit runtime configuration." };
        },
      } as any),
      { inheritProcessEnv: false },
    );

    await sidecar.generate({
      runId: "run-no-ambient-env",
      sessionId: "session-no-ambient-env",
      seq: 1,
      milestone: "phase_changed",
      stepAgent: "agent.loop",
      stepIndex: 1,
      previousState: { agent: { phase: "THINK" } },
      currentState: { agent: { phase: "ACT" } },
      transition: {
        status: "RUNNING",
        nextStepAgent: "agent.exec.dispatch",
      },
    });

    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.KCHAT_REASONING_ENABLED;
    } else {
      process.env.KCHAT_REASONING_ENABLED = previous;
    }
  }
});

test("ModelReasoningSidecar forwards explicit model and budget overrides", async () => {
  let requestModel: string | undefined;
  let requestMaxTokens: number | undefined;
  let requestInput = "";
  let systemPrompt = "";
  let userPrompt = "";
  const sidecar = new ModelReasoningSidecar(
    ({
      call: async (request: any) => {
        requestModel = request.model;
        requestMaxTokens = request.providerOptions?.openrouter?.maxTokens;
        requestInput = typeof request.input === "string" ? request.input : "";
        systemPrompt =
          Array.isArray(request.messages?.[0]?.content) || request.messages?.[0]?.content === undefined
            ? ""
            : request.messages[0].content;
        userPrompt =
          Array.isArray(request.messages?.[1]?.content) || request.messages?.[1]?.content === undefined
            ? ""
            : request.messages[1].content;
        return {
          message: "I am narrowing to the next safe execution step.",
          provider: {
            provider: "openrouter",
            model: "unit-test-model",
          },
        };
      },
    } as any),
    {
      model: "openrouter/reasoning-test",
      maxTokens: 77,
      timeoutMs: 500,
    },
  );

  const update = await sidecar.generate({
    runId: "run-model-override",
    sessionId: "session-model-override",
    seq: 2,
    milestone: "tool_activity",
    stepAgent: "agent.loop",
    stepIndex: 7,
    previousState: { agent: { phase: "ACT" } },
    currentState: {
      agent: {
        phase: "ACT",
        nextAction: {
          kind: "tool",
          name: "internet.search",
        },
      },
    },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
    recentMessages: ["I ruled out the transcript renderer first."],
    runElapsedMs: 5_000,
    stepElapsedMs: 1_100,
  });

  assert.equal(requestModel, "openrouter/reasoning-test");
  assert.equal(requestMaxTokens, 77);
  assert.equal(update?.milestone, "tool_activity");
  assert.equal(requestInput.includes("recentMessages"), true);
  assert.equal(requestInput.includes("\"beat\""), true);
  assert.equal(requestInput.includes("\"toolName\":\"internet.search\""), true);
  assert.equal(systemPrompt.includes("Continue the recent narrative"), true);
  assert.equal(systemPrompt.includes("engaged assistant narrating concrete work"), true);
  assert.equal(systemPrompt.includes("Treat beat as the only source"), true);
  assert.equal(systemPrompt.includes("do not call an attempt last or final"), true);
  assert.equal(systemPrompt.includes("promise imminent completion"), true);
  assert.equal(userPrompt.includes("do not claim an attempt is last or final"), true);
  assert.equal(systemPrompt.includes("beat.reason"), true);
  assert.equal(systemPrompt.includes("one more substantive task-level update"), true);
  assert.equal(systemPrompt.includes("runtimeBeat is present"), false);
  assert.equal(systemPrompt.includes("Treat hiddenState"), false);
  assert.equal(systemPrompt.includes("When beat.wait.prompt is present"), true);
  assert.equal(userPrompt.includes("<context_guide>"), true);
  assert.equal(userPrompt.includes("<output_rule>"), true);
  assert.equal(userPrompt.includes("<snapshot_json>"), true);
  assert.equal(userPrompt.includes("compress the next update into a single task-level beat"), true);
  assert.equal(userPrompt.includes("Step metadata, elapsed time"), true);
  assert.equal(userPrompt.includes("\"recentMessages\""), true);
});

test("ModelReasoningSidecar reports validator drop diagnostics for invalid monologues", async () => {
  const sidecar = new ModelReasoningSidecar(({
    call: async () => ({ text: "I will do this with `markdown`." }),
  } as any));

  const result = await sidecar.generateWithDiagnostics({
    runId: "run-drop-validator",
    sessionId: "session-drop-validator",
    seq: 3,
    milestone: "tool_activity",
    stepAgent: "agent.loop",
    stepIndex: 4,
    previousState: { agent: { phase: "ACT" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  assert.equal(result.update, undefined);
  assert.equal(result.dropped?.reason, "message_invalid");
  assert.equal(result.dropped?.validator, "markdown");
});

test("ModelReasoningSidecar truncates verbose monologues to two sentences", async () => {
  const sidecar = new ModelReasoningSidecar(({
    call: async () => ({
      text: "I am collecting the strongest signal. I should verify one more source. I will now finalize.",
    }),
  } as any));

  const result = await sidecar.generateWithDiagnostics({
    runId: "run-truncate",
    sessionId: "session-truncate",
    seq: 4,
    milestone: "tool_activity",
    stepAgent: "agent.loop",
    stepIndex: 5,
    previousState: { agent: { phase: "ACT" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  assert.equal(result.update !== undefined, true);
  assert.equal(
    result.update?.message,
    "I am collecting the strongest signal. I should verify one more source.",
  );
});

test("ModelReasoningSidecar drops exact duplicate updates against recent history", async () => {
  const sidecar = new ModelReasoningSidecar(({
    call: async () => ({
      text: "I traced the sidecar prompt and found the generic wording.",
    }),
  } as any));

  const result = await sidecar.generateWithDiagnostics({
    runId: "run-duplicate",
    sessionId: "session-duplicate",
    seq: 5,
    milestone: "phase_changed",
    stepAgent: "agent.loop",
    stepIndex: 6,
    previousState: { agent: { phase: "THINK" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
    recentMessages: ["I traced the sidecar prompt and found the generic wording."],
  });

  assert.equal(result.update, undefined);
  assert.equal(result.dropped?.reason, "message_invalid");
  assert.equal(result.dropped?.validator, "duplicate");
});

test("ModelReasoningSidecar reports model-error diagnostics when generation fails", async () => {
  const sidecar = new ModelReasoningSidecar(({
    call: async () => {
      const error = new Error("sidecar gateway failure");
      (error as Error & { code?: string }).code = "IO_MODEL_FAILED";
      throw error;
    },
  } as any));

  const result = await sidecar.generateWithDiagnostics({
    runId: "run-drop-model-error",
    sessionId: "session-drop-model-error",
    seq: 4,
    milestone: "phase_changed",
    stepAgent: "agent.loop",
    stepIndex: 5,
    previousState: { agent: { phase: "THINK" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  assert.equal(result.update, undefined);
  assert.equal(result.dropped?.reason, "model_error");
  assert.equal(result.dropped?.errorCode, "IO_MODEL_FAILED");
  assert.equal(result.dropped?.errorMessage, "sidecar gateway failure");
});

test("ModelReasoningSidecar captures response-shape diagnostics for missing message payloads", async () => {
  const sidecar = new ModelReasoningSidecar(({
    call: async () => ({
      output: {
        content: [],
      },
      provider: {
        name: "openrouter",
      },
    }),
  } as any));

  const result = await sidecar.generateWithDiagnostics({
    runId: "run-drop-shape",
    sessionId: "session-drop-shape",
    seq: 5,
    milestone: "phase_changed",
    stepAgent: "agent.loop",
    stepIndex: 6,
    previousState: { agent: { phase: "THINK" } },
    currentState: { agent: { phase: "ACT" } },
    transition: {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
    },
  });

  assert.equal(result.update, undefined);
  assert.equal(result.dropped?.reason, "message_missing");
  assert.equal(Array.isArray(result.dropped?.responseKeys), true);
  assert.equal(Array.isArray(result.dropped?.outputKeys), true);
  assert.match(result.dropped?.contentShape ?? "", /root:object/u);
});
