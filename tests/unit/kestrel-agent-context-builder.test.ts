import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildModelToolAliasRegistry } from "../../agents/reference-react/src/modelToolCallActions.js";
import {
  buildActiveProcessEvidence,
  buildRecentToolResultEvidence,
} from "../../src/runtime/agent-context/evidenceContext.js";
import {
  buildKestrelAgentContext as buildContextRequest,
  buildKestrelAgentCompactionMessages,
  buildKestrelAgentContext,
  buildKestrelAgentCompactedTranscript,
  buildKestrelAgentToolModelContext,
  buildKestrelAgentToolResultSummary,
  buildKestrelAgentToolSurface,
  buildKestrelAgentValidationFeedbackMessage,
  buildKestrelTerminalBenchRepairPrompt,
  shouldCompactKestrelAgentContext,
} from "../../src/runtime/KestrelAgentContextBuilder.js";

test("Kestrel agent context builder preserves the compatibility request output", () => {
  const input = {
    reactState: {
      visibleTodos: {
        objective: "Ship the refactor.",
        items: [
          { id: "inventory", text: "Inventory prompt surfaces", status: "completed" },
          { id: "builder", text: "Create the context builder", status: "in_progress" },
        ],
      },
      lastActionResult: {
        kind: "tool",
        name: "fs.search_text",
        input: { path: "src/runtime", query: "buildContextRequest" },
        output: {
          path: "src/runtime",
          query: "buildContextRequest",
          matches: [
            { path: "src/runtime/example.ts", line: 12, preview: "buildContextRequest(...)" },
          ],
        },
      },
    },
    eventPayload: {
      message: "Ship the refactor.",
    },
    eventType: "user.message",
    goal: "Ship the refactor.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
    activeWorkspace: {
      workspaceRoot: "/repo",
    },
  };

  const direct = buildKestrelAgentContext(input);
  const compat = buildContextRequest(input);

  assert.deepEqual(compat.modelInput, direct.modelInput);
  assert.deepEqual(compat.messages, direct.messages);
  assert.deepEqual(compat.transcript, direct.transcript);
  assert.equal(direct.metadata.builder, "kestrel-agent-context");
});

test("Kestrel agent context builder records deterministic section order", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: "Build a planner.",
    },
    eventType: "job.run",
    goal: "Build a planner.",
    interactionMode: "build",
    activeProjectContext: {
      projectId: "project-atlas",
      contextRevisionId: "revision-7",
      contextRevision: 7,
      content: "Project: Atlas",
    },
  });

  assert.deepEqual(
    context.metadata.sections.map((section) => section.id),
    [
      "systemPrompt",
      "task",
      "benchmarkContext",
      "mode",
      "workspace",
      "projectContext",
      "skillPack",
      "activeProcessEvidence",
      "recentFilesystemEvidence",
      "recentToolResultEvidence",
      "projectTaskQueue",
      "recovery",
      "visibleTodos",
      "workspaceFreshness",
      "correction",
      "activeWait",
      "transcript",
    ],
  );
  assert.deepEqual(
    context.metadata.sections.find((section) => section.id === "projectContext"),
    { id: "projectContext", origin: "project", rendered: true },
  );
});

test("Kestrel agent context builder uses fresh user message when no active task state remains", () => {
  const originalTask = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const followUp = "you can use your tools to scaffold a project";
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "turn_1",
            createdAt: "2026-07-06T13:43:38.872Z",
            kind: "user",
            content: originalTask,
          },
          {
            id: "turn_2",
            createdAt: "2026-07-06T13:43:50.000Z",
            kind: "assistant_text",
            content: "I cannot continue because the workspace is empty.",
          },
        ],
      },
    },
    eventPayload: {
      message: followUp,
    },
    eventType: "user.message",
    goal: followUp,
    interactionMode: "build",
  });

  assert.equal(context.modelInput.taskInstruction, followUp);
  const transcript = context.modelInput.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [originalTask, followUp],
  );
  assert.equal(items.at(-1)?.kind, "user");
  assert.equal(items.at(-1)?.content, followUp);
});

test("Kestrel agent context builder does not reuse cwd task for a fresh plan question", () => {
  const cwdQuestion = "ok whats your cwd?";
  const planQuestion = "ok now what is the current PLAN.md say? where are we at in terms of progress?";
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_user",
            createdAt: "2026-07-06T21:59:15.000Z",
            kind: "user",
            content: cwdQuestion,
          },
          {
            id: "mt_1_0002_assistant_text",
            createdAt: "2026-07-06T21:59:30.000Z",
            kind: "assistant_text",
            content: "The current working directory is /Users/example/Projects/tmp.",
          },
          {
            id: "mt_1_0003_correction",
            createdAt: "2026-07-06T21:59:31.000Z",
            kind: "correction",
            content: "Retry guidance: use terminal control.",
          },
        ],
      },
    },
    eventPayload: {
      message: planQuestion,
    },
    eventType: "user.message",
    goal: planQuestion,
    interactionMode: "plan",
  });

  assert.equal(context.modelInput.taskInstruction, planQuestion);
  assert.notEqual(context.modelInput.taskInstruction, cwdQuestion);
  assert.match(JSON.stringify(context.contextMessages), /ok whats your cwd\?/u);
  assert.match(JSON.stringify(context.contextMessages), /current PLAN\.md/u);
});

test("Kestrel agent context builder seeds original task before bootstrapped replies", () => {
  const originalTask = "Build Chirp, a text-only microblogging app with auth and CRUD posts.";
  const reply = "lets do Vite instead of Nextjs... SQLite db via prisma is fine";
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: reply,
    },
    eventType: "user.reply",
    goal: originalTask,
    interactionMode: "build",
  });

  assert.equal(context.modelInput.taskInstruction, originalTask);
  const transcript = context.modelInput.transcript as Record<string, unknown>;
  const items = transcript.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((item) => item.kind === "user").map((item) => item.content),
    [originalTask, reply],
  );

  const nextContext = buildKestrelAgentContext({
    reactState: {
      modelTranscript: transcript,
    },
    eventPayload: {
      message: "keep going",
    },
    eventType: "user.message",
    goal: "keep going",
    interactionMode: "build",
  });

  assert.equal(nextContext.modelInput.taskInstruction, "keep going");
});

test("Kestrel agent context builder promotes active exec_command process evidence", () => {
  const context = buildKestrelAgentContext({
    reactState: {
      lastActionResult: {
        kind: "tool",
        name: "exec_command",
        toolName: "exec_command",
        input: {
          command: "./maze_game.sh",
          cwd: "/app",
        },
        output: {
          status: "running",
          sessionId: "tb-proc-123",
          cursor: 222,
          output: "\n$ ./maze_game.sh\nWelcome to the Blind Maze Explorer!\n> ",
          truncated: false,
        },
      },
      evidenceLedger: [
        {
          kind: "process_state",
          status: "running",
          target: {
            type: "process",
            value: "tb-proc-123",
          },
          facts: {
            toolName: "exec_command",
            command: "./maze_game.sh",
            sessionId: "tb-proc-123",
            cursor: 222,
            outputPreview: "Welcome to the Blind Maze Explorer! >",
          },
        },
      ],
    },
    eventPayload: {
      message: "Map the maze.",
    },
    eventType: "job.run",
    goal: "Map the maze.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  assert.match(runtimeContext, /Evidence:\nActive process evidence:/u);
  assert.match(runtimeContext, /exec_command running sessionId="tb-proc-123"/u);
  assert.match(runtimeContext, /command="\.\/maze_game\.sh"/u);
  assert.match(runtimeContext, /call exec_command with \{"sessionId":"tb-proc-123","assistantProgress":"I am checking the running process\."\} and no command/u);
  assert.doesNotMatch(runtimeContext, /Recent tool-result evidence:[\s\S]*exec_command running/u);
  assert.equal(countOccurrences(runtimeContext, "call exec_command with"), 1);
  assert.equal(context.metadata.sections.find((section) => section.id === "activeProcessEvidence")?.rendered, true);
});

test("Kestrel agent context builder promotes active exec_command evidence from transcript", () => {
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "tool_result_1",
            createdAt: "2026-07-06T00:00:00.000Z",
            kind: "tool_result",
            toolName: "exec_command",
            toolInput: {
              sessionId: "tb-proc-456",
              stdin: "move N\n",
            },
            toolOutput: {
              status: "running",
              sessionId: "tb-proc-456",
              cursor: 333,
              output: "hit wall\n> ",
              truncated: false,
            },
            rawOutputRef: "tool-output:maze",
          },
        ],
      },
    },
    eventPayload: {
      message: "Continue mapping.",
    },
    eventType: "job.run",
    goal: "Continue mapping.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  assert.match(runtimeContext, /Evidence:\nActive process evidence:/u);
  assert.match(runtimeContext, /exec_command running sessionId="tb-proc-456"/u);
  assert.match(runtimeContext, /last stdin="move N"/u);
  assert.match(runtimeContext, /text="hit wall >"/u);
  assert.match(runtimeContext, /call exec_command with \{"sessionId":"tb-proc-456","assistantProgress":"I am checking the running process\."\} and no command/u);
  assert.match(runtimeContext, /Add stdin only when the process is waiting for input/u);
  assert.doesNotMatch(runtimeContext, /Recent tool-result evidence:[\s\S]*exec_command running/u);
  assert.equal(countOccurrences(runtimeContext, "call exec_command with"), 1);
  assert.equal(context.metadata.sections.find((section) => section.id === "activeProcessEvidence")?.rendered, true);
});

test("Kestrel agent context builder clears transcript process evidence after terminal settlement", () => {
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "tool_result_running",
            createdAt: "2026-07-06T00:00:00.000Z",
            kind: "tool_result",
            toolName: "exec_command",
            toolInput: { command: "npm test", cwd: "coding-fixture" },
            toolOutput: { status: "running", sessionId: "proc-settled", output: "TAP version 13" },
          },
          {
            id: "tool_result_terminal",
            createdAt: "2026-07-06T00:00:01.000Z",
            kind: "tool_result",
            toolName: "exec_command",
            toolInput: { sessionId: "proc-settled" },
            toolOutput: { status: "failed", exitCode: 1, output: "test failed" },
          },
        ],
      },
    },
    eventPayload: { message: "Fix the test." },
    eventType: "job.run",
    goal: "Fix the test.",
    interactionMode: "build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  assert.doesNotMatch(runtimeContext, /Active process evidence:/u);
  assert.doesNotMatch(runtimeContext, /exec_command running sessionId="proc-settled"/u);
  assert.equal(context.metadata.sections.find((section) => section.id === "activeProcessEvidence")?.rendered, false);
});

test("workspace status is rederived from the ledger after compaction and clears when fresh", () => {
  const mutation = {
    id: "mutation-1",
    version: "v1",
    createdAt: "2026-07-17T00:00:00.000Z",
    stepIndex: 1,
    source: "tool",
    kind: "file_write",
    status: "passed",
    summary: "Changed app/page.tsx.",
    target: { type: "path", value: "app/page.tsx" },
    facts: { toolName: "fs.write_text", changedFiles: ["app/page.tsx"] },
  };
  const stale = buildKestrelAgentContext({
    reactState: {
      evidenceLedger: [mutation],
      modelTranscript: [{ kind: "compaction", text: "Earlier transcript compacted." }],
    },
    eventPayload: { message: "Continue." },
    eventType: "system.resume",
    goal: "Update the page.",
    interactionMode: "build",
  });

  const staleRuntimeContext = String(stale.contextMessages[0]?.content ?? "");
  assert.match(staleRuntimeContext, /validation state: stale/u);
  assert.match(staleRuntimeContext, /app\/page\.tsx/u);

  const fresh = buildKestrelAgentContext({
    reactState: {
      evidenceLedger: [
        mutation,
        {
          id: "readback-2",
          version: "v1",
          createdAt: "2026-07-17T00:00:01.000Z",
          stepIndex: 2,
          source: "tool",
          kind: "file_content",
          status: "passed",
          summary: "Read app/page.tsx.",
          target: { type: "path", value: "app/page.tsx" },
          facts: { toolName: "fs.read_text", path: "app/page.tsx" },
        },
      ],
    },
    eventPayload: { message: "Continue." },
    eventType: "system.resume",
    goal: "Update the page.",
    interactionMode: "build",
  });

  assert.doesNotMatch(String(fresh.contextMessages[0]?.content ?? ""), /Workspace status:/u);
});

test("Kestrel agent context builder owns deliberator system message placement", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: "Build a planner.",
    },
    eventType: "job.run",
    goal: "Build a planner.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
    systemPrompt: {
      kind: "reference-react-deliberator",
      interactionMode: "build",
      promptVariant: "reference-react:build",
    },
  });

  assert.equal(context.messages[0]?.role, "system");
  assert.match(String(context.messages[0]?.content), /You are Kestrel, a pragmatic software engineer/u);
  assert.match(String(context.messages[0]?.content), /You are in build mode/u);
  assert.equal(context.contextMessages.some((message) => message.role === "system"), false);
  assert.equal(context.metadata.sections.find((section) => section.id === "systemPrompt")?.rendered, true);
});

test("Kestrel agent context builder renders sectioned runtime context and submode", () => {
  const context = buildKestrelAgentContext({
    reactState: {
      visibleTodos: {
        objective: "Improve context.",
        items: [
          { id: "prompt", text: "Refactor prompts", status: "in_progress" },
        ],
      },
    },
    eventPayload: {
      message: "Improve context.",
    },
    eventType: "job.run",
    goal: "Improve context.",
    interactionMode: "build",
    actSubmode: "full_auto",
    promptVariant: "reference-react:build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  assert.match(runtimeContext, /<runtime_context>/u);
  assert.doesNotMatch(runtimeContext, /Task:\nImprove context\./u);
  assert.match(runtimeContext, /Mode:\n- event: job\.run\n- interaction: build\n- submode: full_auto/u);
  assert.match(runtimeContext, /Work state:\nCurrent work:/u);
  assert.doesNotMatch(runtimeContext, /Context priority:/u);
});

test("Kestrel deliberator system prompt keeps context and build-loop contracts explicit", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: "Improve context.",
    },
    eventType: "job.run",
    goal: "Improve context.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
    systemPrompt: {
      kind: "reference-react-deliberator",
      interactionMode: "build",
      promptVariant: "reference-react:build",
    },
  });
  const systemPrompt = String(context.messages[0]?.content ?? "");

  assert.match(systemPrompt, /Core operating contract:/u);
  assert.match(systemPrompt, /Runtime context is the authoritative control packet/u);
  assert.match(systemPrompt, /Build-mode operating loop:/u);
  assert.match(systemPrompt, /implementation-first/u);
  assert.match(systemPrompt, /primary edit target/u);
  assert.match(systemPrompt, /1\. Orient just enough to act\./u);
  assert.match(systemPrompt, /2\. Make the smallest plausible candidate change early\./u);
  assert.match(systemPrompt, /3\. Validate the exact requested behavior after the latest mutation\./u);
  assert.match(systemPrompt, /4\. Review the final diff and user-visible output\./u);
  assert.match(systemPrompt, /continue that exact sessionId without command/u);
  assert.match(systemPrompt, /settle every live process before finalizing/u);
  assert.match(systemPrompt, /visible plan agent-owned/u);
  assert.match(systemPrompt, /User-facing control tools:/u);
});

test("Kestrel agent context builder owns compaction prompt messages", () => {
  const messages = buildKestrelAgentCompactionMessages({
    contextMessages: [
      {
        role: "user",
        content: "<runtime_context>\nTask: Continue\n</runtime_context>",
      },
    ],
  });

  assert.equal(messages[0]?.role, "system");
  assert.match(String(messages[0]?.content), /Summarize the older transcript for continuation/u);
  assert.equal(messages[1]?.role, "user");
  assert.match(String(messages[1]?.content), /Task: Continue/u);
  assert.equal(messages[2]?.role, "user");
  assert.equal(messages[2]?.content, "Write the compact continuation summary now.");
  assert.equal(shouldCompactKestrelAgentContext({ transcript: { version: 1, windowId: 1, items: [] } }), false);
  const compacted = buildKestrelAgentCompactedTranscript({
    transcript: {
      version: 1,
      windowId: 1,
      items: [
        {
          id: "user_1_1",
          kind: "user",
          content: "Older work.",
          stepIndex: 1,
        },
      ],
    },
  });
  assert.equal(compacted.items[0]?.kind, "compaction_summary");
});

test("Kestrel agent context builder owns the provider-facing tool surface", () => {
  const workspaceTools = [
    {
      name: "dev.shell.run",
      description: "Run a bounded shell command.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
    {
      name: "exec_command",
      description: "Run terminal work.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  ];

  const direct = buildKestrelAgentToolSurface({
    workspaceTools,
    controlToolNames: ["kestrel.finalize", "kestrel.todo_update"],
  });
  const compat = buildModelToolAliasRegistry(workspaceTools, {
    controlToolNames: ["kestrel.finalize", "kestrel.todo_update"],
  });

  assert.deepEqual(compat.requestTools, direct.requestTools);
  assert.deepEqual(compat.entries, direct.entries);
  assert.equal(direct.requestTools[0]?.name, "exec_command");
  assert.equal(direct.byProviderName.get("exec_command")?.canonicalName, "exec_command");
  assert.equal(direct.byProviderName.has("dev_shell_run"), false);
  assert.match(
    direct.requestTools.find((tool) => tool.name === "kestrel_finalize")?.description ?? "",
    /Finish the run with a user-facing answer/u,
  );
  assert.match(
    direct.requestTools.find((tool) => tool.name === "kestrel_finalize")?.description ?? "",
    /Preserve any user-required literal marker or output token exactly, including capitalization/u,
  );
});

test("Kestrel agent context builder owns tool-result summaries and model context", () => {
  assert.equal(
    buildKestrelAgentToolResultSummary({
      toolName: "fs.search_text",
      toolInput: { path: "src", query: "needle" },
      toolOutput: {
        path: "src",
        query: "needle",
        matches: [{ path: "src/file.ts", line: 1, preview: "needle" }],
      },
      status: "passed",
    }),
    'fs.search_text src for "needle" returned 1 match.',
  );

  const context = buildKestrelAgentToolModelContext({
    toolName: "fs.read_text",
    toolInput: { path: "src/file.ts" },
    toolOutput: { path: "src/file.ts", content: "hello" },
    rawOutputRef: "tool-output:abc123",
    status: "OK",
  });

  assert.match(context.text, /Tool result: fs\.read_text/u);
  assert.match(context.text, /- path: src\/file\.ts/u);
  assert.match(context.text, /- content \(exact complete file; boundary markers are not file content\):/u);
  assert.match(context.text, /<<<KESTREL_EXACT_FILE_CONTENT\nhello\nKESTREL_EXACT_FILE_CONTENT/u);
  assert.match(context.text, /Raw output ref: tool-output:abc123/u);

  const genericContext = buildKestrelAgentToolModelContext({
    toolName: "custom.tool",
    toolInput: {},
    toolOutput: { status: "OK", message: "done" },
    rawOutputRef: "tool-output:def456",
    status: "OK",
  });
  assert.equal(genericContext.text.match(/- status:/gu)?.length, 1);
});

test("agent evidence resolves relative process cwd from the recorded workspace root", () => {
  const runningResult = {
    kind: "tool",
    name: "exec_command",
    toolName: "exec_command",
    input: { command: "npm test", cwd: "missing" },
    output: {
      status: "running",
      sessionId: "proc-relative",
      cwd: "missing",
      workspaceRoot: "/repo",
    },
  };
  const activeEvidence = buildActiveProcessEvidence({ lastActionResult: runningResult });
  assert.equal(activeEvidence?.length, 1);
  assert.match(activeEvidence?.[0] ?? "", /cwd="missing"/u);
  assert.doesNotMatch(activeEvidence?.[0] ?? "", /outside-active-workspace/u);

  const completedResult = {
    ...runningResult,
    status: "ok",
    output: {
      ...runningResult.output,
      status: "completed",
      exitCode: 0,
    },
  };
  const recentEvidence = buildRecentToolResultEvidence({ lastActionResult: completedResult });
  assert.equal(recentEvidence?.length, 1);
  assert.match(recentEvidence?.[0] ?? "", /cwd="missing"/u);
  assert.doesNotMatch(recentEvidence?.[0] ?? "", /outside-active-workspace/u);
});

test("Kestrel agent context builder keeps bounded weather facts model-visible", () => {
  const currentContext = buildKestrelAgentToolModelContext({
    toolName: "free.weather.current",
    toolInput: { city: "Cincinnati, OH" },
    toolOutput: {
      source: "open-meteo",
      latitude: 39.1031,
      longitude: -84.512,
      temperatureC: 27,
      apparentTemperatureC: 29,
      humidityPct: 61,
      weatherCode: 2,
      windSpeedKph: 9,
      observedAt: "2026-07-12T15:00",
    },
    rawOutputRef: "tool-output:weather-current",
    status: "OK",
  });
  assert.match(currentContext.text, /temperatureC: 27/u);
  assert.match(currentContext.text, /condition: partly cloudy/u);
  assert.match(currentContext.text, /observedAt: 2026-07-12T15:00/u);

  const forecastContext = buildKestrelAgentToolModelContext({
    toolName: "free.weather.forecast",
    toolInput: { city: "Cincinnati, OH", days: 4 },
    toolOutput: {
      source: "open-meteo",
      latitude: 39.1031,
      longitude: -84.512,
      timezone: "America/New_York",
      requestedDays: 4,
      granularity: "mixed",
      target: {
        time: "2026-07-12T15:00",
        temperatureC: 27,
        apparentTemperatureC: 29,
        precipitationProbabilityPct: 20,
        precipitationMm: 0,
        windSpeedKph: 9,
      },
      daily: Array.from({ length: 12 }, (_, index) => ({
        date: `2026-07-${String(12 + index).padStart(2, "0")}`,
        minTemperatureC: 20 + index,
        maxTemperatureC: 30 + index,
        precipitationProbabilityPct: 10 + index,
        precipitationMm: index / 10,
        windSpeedKph: 8 + index,
        weatherCode: index === 0 ? 3 : 1,
      })),
      nextHours: Array.from({ length: 14 }, (_, index) => ({
        time: `2026-07-12T${String(index).padStart(2, "0")}:00`,
        temperatureC: 24 + index,
        apparentTemperatureC: 25 + index,
        precipitationProbabilityPct: index,
        precipitationMm: 0,
        windSpeedKph: 5 + index,
      })),
    },
    rawOutputRef: "tool-output:weather-forecast",
    status: "OK",
  });

  assert.match(forecastContext.text, /- target:/u);
  assert.match(forecastContext.text, /temperatureC=27/u);
  assert.match(forecastContext.text, /- daily:/u);
  assert.match(forecastContext.text, /date=2026-07-12/u);
  assert.match(forecastContext.text, /maxTemperatureC=30/u);
  assert.match(forecastContext.text, /condition=overcast/u);
  assert.match(forecastContext.text, /- nextHours:/u);
  assert.match(forecastContext.text, /\[omitted 2 daily entries\]/u);
  assert.match(forecastContext.text, /\[omitted 2 hourly entries\]/u);
  assert.match(forecastContext.text, /Raw output ref: tool-output:weather-forecast/u);
  assert.ok(forecastContext.text.length <= 12_000);
});

test("Kestrel agent context builder promotes recent failed tool results as compact evidence", () => {
  const failedToolText = [
    "Tool result: dev.shell.run",
    "",
    "- command: pnpm test report-route",
    "- cwd: /repo/kestrel-app",
    "- status: FAILED",
    "- exitCode: 1",
    "- stdout:",
    "  <empty>",
    "- stderr:",
    "  expected 200 received 500",
    "",
    "Raw output ref: tool-output:test",
  ].join("\n");
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_tool_call",
            createdAt: "2026-07-03T00:00:00.000Z",
            kind: "tool_call",
            toolCallId: "call_test",
            toolName: "dev.shell.run",
            toolInput: {
              command: "pnpm test report-route",
              cwd: "/repo/kestrel-app",
            },
          },
          {
            id: "mt_1_0002_tool_result",
            createdAt: "2026-07-03T00:00:01.000Z",
            kind: "tool_result",
            toolCallId: "call_test",
            toolName: "dev.shell.run",
            toolInput: {
              command: "pnpm test report-route",
              cwd: "/repo/kestrel-app",
            },
            toolOutput: {
              text: failedToolText,
              rawOutputRef: "tool-output:test",
              truncated: false,
            },
            rawOutputRef: "tool-output:test",
            truncated: false,
          },
        ],
      },
    },
    eventPayload: {
      message: "Continue from the gathered evidence and patch the failing route test.",
    },
    eventType: "job.run",
    goal: "Continue from the gathered evidence and patch the failing route test.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  assert.match(runtimeContext, /Evidence:\nRecent tool-result evidence:/u);
  assert.match(runtimeContext, /historical: dev\.shell\.run failed command="pnpm test report-route" cwd="\/repo\/kestrel-app" exitCode=1/u);
  assert.match(runtimeContext, /stderr="expected 200 received 500"/u);
  assert.match(runtimeContext, /rawOutputRef=tool-output:test/u);
  const toolMessage = context.messages.find((message) => message.role === "tool" && message.name === "dev.shell.run");
  assert.match(String(toolMessage?.content), /Tool result: dev\.shell\.run/u);
  assert.match(String(toolMessage?.content), /expected 200 received 500/u);
  const transcriptResult = context.transcript.items.find((item) => item.kind === "tool_result");
  assert.equal(transcriptResult?.rawOutputRef, "tool-output:test");
  assert.equal(
    typeof transcriptResult?.toolOutput === "object" &&
      transcriptResult.toolOutput !== null &&
      "text" in transcriptResult.toolOutput &&
      String(transcriptResult.toolOutput.text).includes("expected 200 received 500"),
    true,
  );
});

test("Kestrel agent context builder presents the latest successful result before older failures", () => {
  const context = buildKestrelAgentContext({
    reactState: {
      lastActionResult: {
        ok: true,
        kind: "tool",
        status: "ok",
        name: "exec_command",
        toolName: "exec_command",
        input: {
          command: "validate-newsletter",
          cwd: "/app",
        },
        inputHash: "validation-v1",
        output: {
          command: "validate-newsletter",
          cwd: "/app",
          status: "completed",
          exitCode: 0,
          output: "static checks passed\nHTTP check passed: GET / returned 200\n",
        },
      },
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_tool_result",
            createdAt: "2026-07-03T00:00:00.000Z",
            kind: "tool_result",
            toolCallId: "call_failed_validation",
            toolName: "exec_command",
            toolInput: {
              command: "validate-newsletter-with-heredoc",
              cwd: "/app",
            },
            toolOutput: {
              text: [
                "Tool result: exec_command",
                "",
                "- command: validate-newsletter-with-heredoc",
                "- cwd: /app",
                "- status: FAILED",
                "- exitCode: 1",
                "- stderr:",
                "  shell syntax error",
                "",
                "Raw output ref: tool-output:failed",
              ].join("\n"),
              rawOutputRef: "tool-output:failed",
              truncated: false,
            },
            rawOutputRef: "tool-output:failed",
            truncated: false,
          },
          {
            id: "mt_1_0002_tool_result",
            createdAt: "2026-07-03T00:00:01.000Z",
            kind: "tool_result",
            toolCallId: "call_successful_validation",
            toolName: "exec_command",
            toolInput: {
              command: "validate-newsletter",
              cwd: "/app",
            },
            toolOutput: {
              text: [
                "Tool result: exec_command",
                "",
                "- command: validate-newsletter",
                "- cwd: /app",
                "- status: COMPLETED",
                "- exitCode: 0",
                "- text:",
                "  static checks passed",
                "  HTTP check passed: GET / returned 200",
                "",
                "Raw output ref: tool-output:success",
              ].join("\n"),
              rawOutputRef: "tool-output:success",
              truncated: false,
            },
            rawOutputRef: "tool-output:success",
            truncated: false,
          },
        ],
      },
    },
    eventPayload: {
      message: "Build the newsletter.",
    },
    eventType: "job.run",
    goal: "Build the newsletter.",
    interactionMode: "build",
    promptVariant: "reference-react:build",
  });

  const runtimeContext = String(context.contextMessages[0]?.content ?? "");
  const latestIndex = runtimeContext.indexOf("latest: exec_command succeeded");
  const historicalIndex = runtimeContext.indexOf("historical: exec_command failed");
  assert.ok(latestIndex >= 0);
  assert.ok(historicalIndex > latestIndex);
  assert.match(runtimeContext, /exitCode=0/u);
  assert.match(runtimeContext, /static checks passed HTTP check passed: GET \/ returned 200/u);
  assert.match(runtimeContext, /rawOutputRef=tool-output:success/u);
  assert.equal(runtimeContext.match(/command="validate-newsletter"/gu)?.length, 1);
  assert.match(runtimeContext, /Treat the latest observed result as authoritative/u);
});

test("Kestrel agent context builder preserves running and partial latest tool results", () => {
  for (const status of ["running", "partial"] as const) {
    const context = buildKestrelAgentContext({
      reactState: {
        lastActionResult: {
          kind: "tool",
          status,
          name: "dev.process.start",
          toolName: "dev.process.start",
          input: {
            command: "pnpm dev",
            cwd: "/app",
          },
          output: {
            status,
            command: "pnpm dev",
            cwd: "/app",
            output: `${status} process output`,
          },
        },
      },
      eventPayload: {
        message: "Start the app.",
      },
      eventType: "job.run",
      goal: "Start the app.",
      interactionMode: "build",
      promptVariant: "reference-react:build",
    });

    const runtimeContext = String(context.contextMessages[0]?.content ?? "");
    assert.match(runtimeContext, new RegExp(`latest: dev\\.process\\.start ${status}`, "u"));
    assert.match(runtimeContext, new RegExp(`stdout="${status} process output"`, "u"));
  }
});

test("Kestrel agent context builder renders structured validation and repair prompts", () => {
  const validation = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "Missing tool call.",
    schemaCategory: "schema",
    loopAttempt: 2,
    maxLoopAttempts: 4,
  });

  assert.match(validation, /previous action was rejected by validation/u);
  assert.match(validation, /- code: DECISION_SCHEMA_FAILED/u);
  assert.match(validation, /- attempt: 2\/4/u);

  const repairPrompt = buildKestrelTerminalBenchRepairPrompt({
    failurePacketPath: "/tmp/failure.md",
    failurePacket: "# Evidence",
    adapter: "kestrel",
    dataset: "terminal-bench@2.0",
    taskId: "hello-world",
  });

  assert.match(repairPrompt, /You are repairing Kestrel based on a Terminal-Bench failure/u);
  assert.match(repairPrompt, /Evidence packet path: \/tmp\/failure\.md/u);
  assert.match(repairPrompt, /Benchmark target: adapter=kestrel dataset=terminal-bench@2\.0 task=hello-world/u);
  assert.match(repairPrompt, /# Evidence/u);
});

test("Kestrel agent context builder renders exec_command lifecycle correction", () => {
  const feedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "exec_command input mixed start-process fields with continuation fields.",
    schemaCategory: "schema",
    details: {
      reason: "exec_command_ambiguous_lifecycle_input",
      toolName: "exec_command",
      requiredCorrection:
        "Use command by itself to start a new process, or use sessionId with stdin/stop to continue an existing process. Do not include both shapes.",
    },
    loopAttempt: 1,
    maxLoopAttempts: 4,
  });
  const context = buildKestrelAgentContext({
    reactState: {},
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "exec_command input mixed start-process fields with continuation fields.",
        details: {
          reason: "exec_command_ambiguous_lifecycle_input",
          toolName: "exec_command",
          requiredCorrection:
            "Use command by itself to start a new process, or use sessionId with stdin/stop to continue an existing process. Do not include both shapes.",
          modelFeedback: feedback,
        },
        schemaCategory: "schema",
      },
    },
    eventPayload: {
      message: "Continue.",
    },
    eventType: "job.run",
    goal: "Continue.",
    interactionMode: "build",
  });

  const providerText = JSON.stringify(context.messages);
  assert.match(feedback, /- correction: Use command by itself to start a new process/u);
  assert.match(feedback, /start with \{ "command": "\.\.\.", "cwd": "\.\.\." \} and omit sessionId\/stdin\/stop/u);
  assert.match(feedback, /Never invent sessionId/u);
  assert.match(providerText, /Correction needed: The previous action was rejected by validation/u);
  assert.match(providerText, /Use command by itself to start a new process/u);
  assert.match(providerText, /Never invent sessionId/u);
  assert.doesNotMatch(providerText, /Correction: The previous action was rejected by validation/u);
});

test("Kestrel agent context builder renders the exact rejected structured response for contract repair", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Every model action tool call requires assistantProgress.",
        details: {
          reason: "invalid_assistant_progress",
          schemaCategory: "tool_call",
        },
      },
      requiredCorrection: {
        assistantProgressContract: {
          action: "repeat_rejected_tool_call_with_valid_assistant_progress",
          requiredField: "assistantProgress",
        },
      },
      previousResponse: {
        toolCalls: [{ name: "fs_read_text", input: { path: "package.json" } }],
      },
    },
    eventPayload: { message: "Continue." },
    eventType: "job.run",
    goal: "Inspect the workspace.",
    interactionMode: "build",
  });

  const providerText = JSON.stringify(context.messages);
  assert.match(providerText, /Repeat the exact rejected tool call shown below/u);
  assert.match(providerText, /Previous rejected structured response/u);
  assert.match(providerText, /fs_read_text/u);
  assert.match(providerText, /package\.json/u);
});

test("Kestrel agent context builder gives exact legacy finalize data recovery", () => {
  const requiredCorrection =
    "Call kestrel_finalize again with the same status and user-facing message, but omit changedFiles, checksRun, and checksFailed from data. The runtime derives changed files and validation evidence from observed tool results.";
  const feedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "Finalize data must not include legacy closeout evidence fields.",
    schemaCategory: "schema",
    details: {
      reason: "legacy_finalize_evidence_fields_removed",
      path: "nextAction.data",
      legacyFields: ["changedFiles", "checksRun", "checksFailed"],
      requiredCorrection,
    },
  });
  const context = buildKestrelAgentContext({
    reactState: {},
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Finalize data must not include legacy closeout evidence fields.",
        schemaCategory: "schema",
        details: {
          reason: "legacy_finalize_evidence_fields_removed",
          path: "nextAction.data",
          legacyFields: ["changedFiles", "checksRun", "checksFailed"],
          requiredCorrection,
          modelFeedback: feedback,
        },
      },
      previousResponse: {
        toolCalls: [{
          name: "kestrel_finalize",
          input: {
            status: "goal_satisfied",
            message: "Done.",
            data: { changedFiles: ["file.ts"] },
          },
        }],
      },
    },
    eventPayload: { message: "Continue." },
    eventType: "job.run",
    goal: "Fix the benchmark task.",
    interactionMode: "build",
  });

  const providerText = JSON.stringify(context.messages);
  assert.match(feedback, /omit changedFiles, checksRun, and checksFailed/u);
  assert.match(providerText, /runtime derives changed files and validation evidence/u);
  assert.match(providerText, /Previous rejected structured response/u);
});

test("Kestrel agent context builder gives an exact visible todo continuation action", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    retryContext: {
      failure: {
        code: "DECISION_POLICY_FAILED",
        message: "Visible checklist still has open work.",
        schemaCategory: "visible_todos",
        details: {
          reason: "visible_todo_finalize_continuation",
          openVisibleTodoItemId: "validate-fix",
          openVisibleTodoItemStatus: "in_progress",
        },
      },
      requiredCorrection: {
        visibleTodoBeforeFinalize: {
          action: "advance_or_close_visible_todo_before_finalize",
          openItem: {
            id: "validate-fix",
            text: "Run the focused regression test",
            status: "in_progress",
          },
          forbiddenActionWhileOpen: "kestrel_finalize by itself",
        },
      },
    },
    eventPayload: { message: "Continue." },
    eventType: "job.run",
    goal: "Fix the benchmark task.",
    interactionMode: "build",
  });

  const providerText = JSON.stringify(context.messages);
  assert.match(providerText, /Do not call kestrel_finalize by itself again/u);
  assert.match(providerText, /workspace tool that directly advances that item/u);
  assert.match(providerText, /kestrel_todo_update to mark that exact item done/u);
  assert.match(providerText, /validate-fix/u);
  assert.match(providerText, /Run the focused regression test/u);
});

test("Kestrel agent context builder renders duplicate exec_command start correction", () => {
  const feedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_POLICY_FAILED",
    message: "Cannot start the same command while that command already has a live process.",
    schemaCategory: "policy",
    details: {
      reason: "live_dev_process_start_replay_requires_process_continuation",
      toolName: "exec_command",
      processId: "tb-proc-123",
      requiredCorrection:
        "Continue the live session with exec_command sessionId + stdin/read, or stop it before starting a new process. Use fresh command only when intentionally resetting or starting unrelated work.",
    },
    loopAttempt: 1,
    maxLoopAttempts: 4,
  });

  assert.match(feedback, /Continue the live session with exec_command sessionId \+ stdin\/read/u);
  assert.match(feedback, /Use fresh command only when intentionally resetting or starting unrelated work/u);
});

test("Kestrel agent context builder renders plan document handoff correction", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    retryContext: {
      failure: {
        code: "DECISION_POLICY_FAILED",
        message: "handoff_to_build requires an active session plan document.",
        details: {
          reason: "handoff_without_plan_document",
          requiredAction: "write_session_plan_before_handoff",
        },
      },
      requiredCorrection: {
        planDocumentBeforeHandoff: {
          action: "write_session_plan_before_handoff",
          rejectedAction: "handoff_to_build",
          requiredTool: "planning.write_document",
          requiredModelTool: "planning_write_document",
          forbiddenActionUntilPlanExists: "kestrel_handoff_to_build",
        },
      },
    },
    eventPayload: {
      message: "Continue.",
    },
    eventType: "job.run",
    goal: "Continue.",
    interactionMode: "plan",
  });

  const providerText = JSON.stringify(context.messages);
  assert.match(providerText, /planning_write_document now/u);
  assert.match(providerText, /Do not call kestrel_handoff_to_build again/u);
  assert.match(providerText, /planning\.write_document/u);
});

test("Kestrel agent context builder does not duplicate persisted validation feedback", () => {
  const feedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "Missing tool call.",
    schemaCategory: "tool_call",
    loopAttempt: 1,
    maxLoopAttempts: 4,
  });
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "correction_1_1",
            createdAt: "2026-07-03T00:00:00.000Z",
            kind: "correction",
            content: feedback,
            stepIndex: 1,
          },
        ],
      },
    },
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Missing tool call.",
        details: {
          modelFeedback: feedback,
        },
        schemaCategory: "tool_call",
      },
    },
    eventPayload: {
      message: "Continue.",
    },
    eventType: "job.run",
    goal: "Continue.",
    interactionMode: "build",
  });

  assert.equal(context.transcript.items.filter((item) => item.kind === "correction").length, 1);
  assert.equal(context.transcript.items.find((item) => item.kind === "correction")?.content, feedback);
  assert.equal(context.transcript.items.at(-1)?.kind, "user");
  assert.equal(context.transcript.items.at(-1)?.content, "Continue.");
  const providerText = JSON.stringify(context.messages);
  assert.equal(countOccurrences(providerText, "Missing tool call."), 1);
  assert.match(providerText, /Correction needed: The previous action was rejected by validation/u);
  assert.match(providerText, /Call exactly one available tool or Kestrel control tool now; do not answer in prose/u);
  assert.doesNotMatch(providerText, /Correction: The previous action was rejected by validation/u);
});

test("Kestrel agent context builder keeps unrelated correction history visible", () => {
  const activeFeedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "Missing tool call.",
    schemaCategory: "tool_call",
    loopAttempt: 1,
    maxLoopAttempts: 4,
  });
  const historicalFeedback = "Earlier correction that should stay visible.";
  const context = buildKestrelAgentContext({
    reactState: {
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "correction_1_1",
            createdAt: "2026-07-03T00:00:00.000Z",
            kind: "correction",
            content: historicalFeedback,
            stepIndex: 1,
          },
          {
            id: "correction_1_2",
            createdAt: "2026-07-03T00:00:01.000Z",
            kind: "correction",
            content: activeFeedback,
            stepIndex: 2,
          },
        ],
      },
    },
    retryContext: {
      failure: {
        code: "DECISION_SCHEMA_FAILED",
        message: "Missing tool call.",
        details: {
          modelFeedback: activeFeedback,
        },
        schemaCategory: "tool_call",
      },
    },
    eventPayload: {
      message: "Continue.",
    },
    eventType: "job.run",
    goal: "Continue.",
    interactionMode: "build",
  });

  assert.equal(context.transcript.items.filter((item) => item.kind === "correction").length, 2);
  assert.equal(context.transcript.items.at(-1)?.kind, "user");
  assert.equal(context.transcript.items.at(-1)?.content, "Continue.");
  const providerText = JSON.stringify(context.messages);
  assert.equal(countOccurrences(providerText, "Missing tool call."), 1);
  assert.equal(countOccurrences(providerText, historicalFeedback), 1);
  assert.match(providerText, /Correction: Earlier correction that should stay visible\./u);
});

test("Kestrel agent context builder renders structured SWE Verified benchmark context", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: "Resolve SWE-bench Verified instance astropy__astropy-12907 in this checked-out repository.",
      metadata: {
        benchmark: {
          name: "swe-verified",
          instanceId: "astropy__astropy-12907",
          context: {
            source: "swe-verified",
            instanceId: "astropy__astropy-12907",
            problemStatement: "Fix separability.",
            hintsText: "Look at separable.py.",
            workspaceRoot: "/testbed",
          },
        },
      },
    },
    eventType: "job.run",
    goal: "Resolve SWE-bench Verified instance astropy__astropy-12907 in this checked-out repository.",
    interactionMode: "build",
  });

  assert.match(String(context.modelInput.taskInstruction), /Issue:\nFix separability/u);
  assert.match(String(context.modelInput.taskInstruction), /Hints:\nLook at separable\.py/u);
  assert.match(String(context.modelInput.taskInstruction), /Kestrel runner guidance/u);
  assert.match(String(context.modelInput.taskInstruction), /Treat issue hints and proposed causes as hypotheses/u);
  assert.match(String(context.modelInput.taskInstruction), /preserve the observed emitted semantics/u);
  assert.match(String(context.modelInput.taskInstruction), /Validate the exact emitted value or behavior at risk/u);
  assert.match(String(context.modelInput.taskInstruction), /Run a focused existing test for the changed behavior/u);
  assert.match(String(context.modelInput.taskInstruction), /do not create benchmark bookkeeping files/u);
  assert.equal(context.metadata.sections.find((section) => section.id === "benchmarkContext")?.rendered, true);
});

test("Kestrel agent context builder renders structured Terminal-Bench benchmark context", () => {
  const context = buildKestrelAgentContext({
    reactState: {},
    eventPayload: {
      message: "Solve it.",
      metadata: {
        benchmark: {
          name: "terminal-bench",
          taskId: "hello-world",
          context: {
            source: "terminal-bench",
            taskId: "hello-world",
            workspaceRoot: "/app",
          },
        },
      },
    },
    eventType: "job.run",
    goal: "Solve it.",
    interactionMode: "build",
  });

  assert.match(String(context.modelInput.taskInstruction), /^Solve it\.\n/u);
  assert.match(String(context.modelInput.taskInstruction), /Kestrel Terminal-Bench execution contract/u);
  assert.match(String(context.modelInput.taskInstruction), /Do not read, execute, copy, or infer answers from \/protected/u);
  assert.match(String(context.modelInput.taskInstruction), /Use exec_command for terminal work/u);
  assert.match(String(context.modelInput.taskInstruction), /reuse that sessionId to read, send stdin, or stop/u);
  assert.doesNotMatch(String(context.modelInput.taskInstruction), /dev\.shell\.run/u);
  assert.doesNotMatch(String(context.modelInput.taskInstruction), /dev\.process\.write/u);
  assert.doesNotMatch(String(context.modelInput.taskInstruction), /dev\.process\.read/u);
});

test("deliberator model requests use builder-rendered system messages", () => {
  const source = readFileSync(
    path.join(process.cwd(), "agents/reference-react/src/steps/deliberator.ts"),
    "utf8",
  );

  assert.match(source, /systemPrompt:/u);
  assert.match(source, /messages: messages \?\? \[\]/u);
  assert.doesNotMatch(source, /buildDeliberatorSystemPrompt/u);
  assert.doesNotMatch(source, /Summarize the older transcript for continuation/u);
  assert.doesNotMatch(source, /MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS/u);
  assert.doesNotMatch(source, /Earlier transcript was compacted/u);
  assert.match(source, /buildKestrelAgentCompactionMessages/u);
  assert.match(source, /buildKestrelAgentCompactedTranscript/u);
});

test("model tool action parsing delegates provider-facing tool rendering to the builder", () => {
  const source = readFileSync(
    path.join(process.cwd(), "agents/reference-react/src/modelToolCallActions.ts"),
    "utf8",
  );

  assert.match(source, /buildKestrelAgentToolSurface/u);
  assert.doesNotMatch(source, /Finish the run with a user-facing answer/u);
  assert.doesNotMatch(source, /Update the visible live checklist for multi-step work/u);
  assert.doesNotMatch(source, /name\.replace\(/u);
});

test("tool-result and benchmark repair renderers delegate model-visible text to the builder", () => {
  const toolResultSource = readFileSync(
    path.join(process.cwd(), "tools/toolResult.ts"),
    "utf8",
  );
  const evidenceLedgerSource = readFileSync(
    path.join(process.cwd(), "agents/reference-react/src/evidenceLedger.ts"),
    "utf8",
  );
  const terminalBenchSource = readFileSync(
    path.join(process.cwd(), "scripts/terminal-bench.ts"),
    "utf8",
  );

  assert.match(toolResultSource, /buildKestrelAgentToolModelContext/u);
  assert.doesNotMatch(toolResultSource, /Tool result: \$\{input\.toolName\}/u);
  assert.match(evidenceLedgerSource, /buildKestrelAgentToolResultSummary/u);
  assert.doesNotMatch(evidenceLedgerSource, /fs\.search_text.*returned.*matches/u);
  assert.match(terminalBenchSource, /buildKestrelTerminalBenchRepairPrompt/u);
  assert.doesNotMatch(terminalBenchSource, /You are repairing Kestrel based on a Terminal-Bench failure/u);
});

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return value.split(needle).length - 1;
}
