import assert from "node:assert/strict";

import {
  appendAssistantToolCallsToTranscript,
  appendCorrectionToTranscript,
  appendModelTranscriptItems,
  appendToolResultToTranscript,
  appendUserTurnToTranscript,
  compactModelTranscript,
  normalizeModelTranscript,
  readActiveTaskGoalFromTranscript,
  rebaseModelTranscriptAfterCompaction,
  renderModelTranscriptMessages,
} from "../../src/runtime/modelTranscript.js";
import { buildManagedScratchpadFromRuntime } from "../../src/runtime/workspaceScratchpad.js";
import { buildKestrelAgentContext as buildContextRequest } from "../../src/runtime/KestrelAgentContextBuilder.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "tool result transcript renders fresh read content into next model messages", () => {
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Update src/App.jsx.",
    stepIndex: 1,
  });
  transcript = appendAssistantToolCallsToTranscript({
    transcript,
    stepIndex: 2,
    toolCalls: [
      {
        name: "fs.read_text",
        input: { path: "src/App.jsx" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 3,
    toolName: "fs.read_text",
    toolInput: { path: "src/App.jsx" },
    toolOutput: {
      path: "src/App.jsx",
      content: "export default function App() { return <h1>Starter</h1>; }",
    },
  });

  const messages = renderModelTranscriptMessages({ transcript });
  const rendered = JSON.stringify(messages);

  assert.equal(messages.some((message) =>
    message.role === "assistant" &&
    message.toolCalls?.some((toolCall) =>
      toolCall.name === "fs.read_text" &&
      toolCall.id === "mt_1_0002_tool_call"
    ) === true
  ), true);
  assert.equal(messages.some((message) =>
    message.role === "tool" &&
    message.toolCallId !== undefined
  ), true);
  assert.match(rendered, /export default function App/u);
  assert.doesNotMatch(rendered, /latestToolEvidence/u);
  assert.doesNotMatch(rendered, /evidenceRefs/u);
});

contractTest("runtime.hermetic", "parallel same-name tool results preserve explicit original tool call ids", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_command_a",
        name: "dev.shell.run",
        input: { command: "python - <<'PY'\nprint('A')\nPY" },
      },
      {
        id: "call_command_b",
        name: "dev.shell.run",
        input: { command: "rg B ." },
      },
    ],
  });

  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "dev.shell.run",
    toolInput: { command: "python - <<'PY'\nprint('A')\nPY" },
    toolOutput: { stdout: "output A\n", exitCode: 0 },
    toolCallId: "call_command_a",
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "dev.shell.run",
    toolInput: { command: "rg B ." },
    toolOutput: { stdout: "output B\n", exitCode: 0 },
    toolCallId: "call_command_b",
  });

  const messages = renderModelTranscriptMessages({ transcript });
  const toolMessages = messages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0]?.toolCallId, "call_command_a");
  assert.match(String(toolMessages[0]?.content), /output A/u);
  assert.equal(toolMessages[1]?.toolCallId, "call_command_b");
  assert.match(String(toolMessages[1]?.content), /output B/u);
});

contractTest("runtime.hermetic", "fs.write_text tool result renders compact factual output without raw JSON", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_write",
        name: "fs.write_text",
        input: { path: "/testbed/example_test.py", mode: "overwrite" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "fs.write_text",
    toolInput: { path: "/testbed/example_test.py", mode: "overwrite" },
    toolOutput: {
      status: "OK",
      path: "example_test.py",
      changed: true,
      existed: true,
      bytesBefore: 10_284,
      bytesAfter: 7538,
      lineCountBefore: 329,
      lineCountAfter: 241,
      lineCountDelta: -88,
      whitespaceTokenCountBefore: 1210,
      whitespaceTokenCountAfter: 897,
      whitespaceTokenCountDelta: -313,
      diffPreview: { before: "old", after: "new", truncated: true },
    },
    toolCallId: "call_write",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /^Tool result: fs\.write_text/u);
  assert.match(rendered, /- path: \/testbed\/example_test\.py/u);
  assert.match(rendered, /- mode: overwrite/u);
  assert.match(rendered, /- status: OK/u);
  assert.match(rendered, /- changed: true/u);
  assert.match(rendered, /- existed: true/u);
  assert.match(rendered, /- bytes: 10284 -> 7538/u);
  assert.match(rendered, /- lines: 329 -> 241 \(-88\)/u);
  assert.match(rendered, /- whitespace tokens: 1210 -> 897 \(-313\)/u);
  assert.match(rendered, /- diffPreview: present/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
  assert.doesNotMatch(rendered, /"lineCountDelta": -88/u);
  assert.doesNotMatch(rendered, /"status": "OK"/u);
});

contractTest("runtime.hermetic", "fs.write_text shaped large output renders compact digest facts", () => {
  const longContent = `${"line\n".repeat(140)}final marker that should not appear in compact input`;
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_large_write",
        name: "fs.write_text",
        input: { path: "/testbed/astropy/timeseries/tests/test_sampled.py", content: longContent, mode: "overwrite" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "fs.write_text",
    toolInput: { path: "/testbed/astropy/timeseries/tests/test_sampled.py", content: longContent, mode: "overwrite" },
    toolOutput: {
      path: "astropy/timeseries/tests/test_sampled.py",
      changed: true,
      existed: true,
      bytesBefore: 16_402,
      bytesAfter: 4883,
      lineCountBefore: 421,
      lineCountAfter: 133,
      lineCountDelta: -288,
      whitespaceTokenCountBefore: 1576,
      whitespaceTokenCountAfter: 493,
      whitespaceTokenCountDelta: -1083,
      diffPreview: { truncated: true },
      truncated: true,
    },
    toolCallId: "call_large_write",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /- path: \/testbed\/astropy\/timeseries\/tests\/test_sampled\.py/u);
  assert.match(rendered, /- mode: overwrite/u);
  assert.match(rendered, /- changed: true/u);
  assert.match(rendered, /- existed: true/u);
  assert.match(rendered, /- bytes: 16402 -> 4883/u);
  assert.match(rendered, /- lines: 421 -> 133 \(-288\)/u);
  assert.match(rendered, /- whitespace tokens: 1576 -> 493 \(-1083\)/u);
  assert.match(rendered, /- diffPreview: present/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /"contentBytes":/u);
  assert.doesNotMatch(rendered, /"contentPreview":/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
  assert.doesNotMatch(rendered, /final marker that should not appear/u);
});

contractTest("runtime.hermetic", "fs.replace_text tool result renders compact factual output without raw JSON", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_replace",
        name: "fs.replace_text",
        input: { path: "/testbed/module.py", all: false },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "fs.replace_text",
    toolInput: { path: "/testbed/module.py", all: false },
    toolOutput: {
      status: "NO_CHANGE",
      path: "module.py",
      changed: false,
      replacements: 0,
      bytesBefore: 2562,
      bytesAfter: 2562,
      lineCountBefore: 89,
      lineCountAfter: 89,
      lineCountDelta: 0,
      whitespaceTokenCountBefore: 306,
      whitespaceTokenCountAfter: 306,
      whitespaceTokenCountDelta: 0,
    },
    toolCallId: "call_replace",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /^Tool result: fs\.replace_text/u);
  assert.match(rendered, /- path: \/testbed\/module\.py/u);
  assert.match(rendered, /- all: false/u);
  assert.match(rendered, /- status: NO_CHANGE/u);
  assert.match(rendered, /- changed: false/u);
  assert.match(rendered, /- replacements: 0/u);
  assert.match(rendered, /- bytes: 2562 -> 2562/u);
  assert.match(rendered, /- lines: 89 -> 89 \(0\)/u);
  assert.match(rendered, /- whitespace tokens: 306 -> 306 \(0\)/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
  assert.doesNotMatch(rendered, /"status": "NO_CHANGE"/u);
});

contractTest("runtime.hermetic", "dev shell run tool result renders process fields and raw stdout without classification", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_shell",
        name: "dev.shell.run",
        input: { command: "git grep pattern | head", cwd: "/testbed", timeoutMs: 10_000 },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "dev.shell.run",
    toolInput: { command: "git grep pattern | head", cwd: "/testbed", timeoutMs: 10_000 },
    toolOutput: {
      command: "git grep pattern | head",
      cwd: "/testbed",
      commandKind: "single_line",
      status: "COMPLETED",
      exitCode: 0,
      truncated: false,
      stdout: "fatal: option '-n' must come before non-option arguments\n",
      stderr: "",
    },
    toolCallId: "call_shell",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /- command: git grep pattern \| head/u);
  assert.match(rendered, /- cwd: \/testbed/u);
  assert.match(rendered, /- commandKind: single_line/u);
  assert.match(rendered, /- timeoutMs: 10000/u);
  assert.match(rendered, /- status: COMPLETED/u);
  assert.match(rendered, /- exitCode: 0/u);
  assert.match(rendered, /- truncated: false/u);
  assert.match(rendered, /- stdout:\n {2}fatal: option '-n' must come before non-option arguments/u);
  assert.match(rendered, /- stderr:\n {2}<empty>/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
  assert.doesNotMatch(rendered, /"sourceWriteGuard"/u);
  assert.doesNotMatch(rendered, /"preflight"/u);
  assert.doesNotMatch(rendered, /"startedAt"/u);
  assert.doesNotMatch(rendered, /"status": "COMPLETED"/u);
  assert.doesNotMatch(rendered, /suspicious|risky|regression|failed-looking|likely blocker|may indicate/u);
});

contractTest("runtime.hermetic", "unknown tool result renders generic envelope fallback", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_custom",
        name: "custom.tool",
        input: { value: "x" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "custom.tool",
    toolInput: { value: "x" },
    toolOutput: { ok: true },
    toolCallId: "call_custom",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /^Tool result: custom\.tool/u);
  assert.match(rendered, /- status: OK/u);
  assert.match(rendered, /- ok: true/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.doesNotMatch(rendered, /Summary:/u);
  assert.doesNotMatch(rendered, /\nInput:/u);
  assert.doesNotMatch(rendered, /\nOutput:/u);
});

contractTest("runtime.hermetic", "weather forecast transcript renders nested daily and hourly evidence", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_weather",
        name: "free.weather.forecast",
        input: { city: "Cincinnati, OH", days: 4 },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "free.weather.forecast",
    toolInput: { city: "Cincinnati, OH", days: 4 },
    toolOutput: {
      source: "open-meteo",
      timezone: "America/New_York",
      requestedDays: 4,
      granularity: "mixed",
      target: { time: "2026-07-12T15:00", temperatureC: 27, windSpeedKph: 9 },
      daily: [
        {
          date: "2026-07-15",
          minTemperatureC: 21,
          maxTemperatureC: 31,
          precipitationProbabilityPct: 40,
          precipitationMm: 2.1,
          windSpeedKph: 12,
          weatherCode: 61,
        },
      ],
      nextHours: [
        {
          time: "2026-07-12T16:00",
          temperatureC: 28,
          apparentTemperatureC: 30,
          precipitationProbabilityPct: 25,
          precipitationMm: 0,
          windSpeedKph: 10,
        },
      ],
    },
    toolCallId: "call_weather",
  });

  const rendered = String(renderModelTranscriptMessages({ transcript }).find((message) =>
    message.role === "tool"
  )?.content);

  assert.match(rendered, /date=2026-07-15/u);
  assert.match(rendered, /maxTemperatureC=31/u);
  assert.match(rendered, /precipitationProbabilityPct=40/u);
  assert.match(rendered, /condition=rain/u);
  assert.match(rendered, /time=2026-07-12T16:00/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
});

contractTest("runtime.hermetic", "re-appending same user task after tool results does not duplicate transcript user items", () => {
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Fix the bug.",
    stepIndex: 1,
  });
  transcript = appendAssistantToolCallsToTranscript({
    transcript,
    stepIndex: 2,
    toolCalls: [
      {
        id: "call_read",
        name: "fs.read_text",
        input: { path: "src/index.ts" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 3,
    toolName: "fs.read_text",
    toolInput: { path: "src/index.ts" },
    toolOutput: { path: "src/index.ts", content: "export {};" },
    toolCallId: "call_read",
  });
  transcript = appendUserTurnToTranscript({
    transcript,
    message: "  Fix the bug.  ",
    stepIndex: 4,
  });

  assert.equal(transcript.items.filter((item) => item.kind === "user").length, 1);

  transcript = appendUserTurnToTranscript({
    transcript,
    message: "Now fix the other bug.",
    stepIndex: 5,
  });

  const userItems = transcript.items.filter((item) => item.kind === "user");
  assert.equal(userItems.length, 2);
  assert.equal(userItems[1]?.content, "Now fix the other bug.");
});

contractTest("runtime.hermetic", "transcript append trimming preserves the original active task", () => {
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Initial task",
  });
  for (let index = 0; index < 130; index += 1) {
    transcript = appendUserTurnToTranscript({
      transcript,
      message: `Follow-up ${index}`,
    });
  }

  assert.equal(transcript.items.length, 120);
  assert.equal(transcript.items[0]?.content, "Initial task");
  assert.equal(transcript.items.at(-1)?.content, "Follow-up 129");
  assert.equal(readActiveTaskGoalFromTranscript(transcript), "Initial task");
});

contractTest("runtime.hermetic", "transcript normalization preserves the original active task when loading long state", () => {
  const transcript = normalizeModelTranscript({
    version: 1,
    windowId: 1,
    items: [
      {
        id: "turn_0",
        createdAt: "2026-07-06T12:00:00.000Z",
        kind: "user",
        content: "Initial task",
      },
      ...Array.from({ length: 130 }, (_, index) => ({
        id: `turn_${index + 1}`,
        createdAt: "2026-07-06T12:00:01.000Z",
        kind: "assistant_text",
        content: `Assistant update ${index}`,
      })),
    ],
  });

  assert.ok(transcript);
  assert.equal(transcript.items.length, 120);
  assert.equal(transcript.items[0]?.content, "Initial task");
  assert.equal(transcript.items.at(-1)?.content, "Assistant update 129");
  assert.equal(readActiveTaskGoalFromTranscript(transcript), "Initial task");
});

contractTest("runtime.hermetic", "normalizing transcript duplicate ids keeps the latest occurrence", () => {
  const transcript = normalizeModelTranscript({
    version: 1,
    windowId: 1,
    items: [
      {
        id: "mt_1_0001_user",
        createdAt: "2026-06-15T00:00:00.000Z",
        kind: "user",
        content: "old task",
      },
      {
        id: "mt_1_0001_user",
        createdAt: "2026-06-15T00:00:01.000Z",
        kind: "user",
        content: "latest task",
      },
    ],
  });

  assert.equal(transcript?.items.length, 1);
  assert.equal(transcript?.items[0]?.content, "latest task");
});

contractTest("runtime.hermetic", "appending after compaction allocates from max existing window ordinal", () => {
  const transcript = appendModelTranscriptItems(
    {
      version: 1,
      windowId: 7,
      items: [
        {
          id: "mt_7_0010_user",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "user",
          content: "existing",
        },
      ],
    },
    [
      {
        id: "pending_user_x",
        createdAt: "2026-06-15T00:00:01.000Z",
        kind: "user",
        content: "new",
      },
    ],
  );

  assert.equal(transcript.items.at(-1)?.id, "mt_7_0011_user");
});

contractTest("runtime.hermetic", "compaction removes duplicate tail ids from retained items", () => {
  const compacted = compactModelTranscript({
    retainedTailItems: 4,
    summary: "Summary",
    transcript: {
      version: 1,
      windowId: 1,
      items: [
        {
          id: "mt_1_0001_user",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "user",
          content: "old duplicate",
        },
        {
          id: "mt_1_0001_user",
          createdAt: "2026-06-15T00:00:01.000Z",
          kind: "user",
          content: "latest duplicate",
        },
        {
          id: "mt_1_0002_assistant_text",
          createdAt: "2026-06-15T00:00:02.000Z",
          kind: "assistant_text",
          content: "answer",
        },
      ],
    },
  });

  assert.deepEqual(
    compacted.items.map((item) => item.content),
    ["Summary", "latest duplicate", "answer"],
  );
  assert.equal(new Set(compacted.compactions?.[0]?.retainedItemIds).size, compacted.compactions?.[0]?.retainedItemIds.length);
});

contractTest("runtime.hermetic", "rebase after compaction skips retained and replaced outgoing ids", () => {
  const compacted = compactModelTranscript({
    retainedTailItems: 1,
    summary: "Summary",
    transcript: {
      version: 1,
      windowId: 1,
      items: [
        {
          id: "mt_1_0001_user",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "user",
          content: "replaced",
        },
        {
          id: "mt_1_0002_assistant_text",
          createdAt: "2026-06-15T00:00:01.000Z",
          kind: "assistant_text",
          content: "retained",
        },
      ],
    },
  });
  const rebased = rebaseModelTranscriptAfterCompaction({
    compactedTranscript: compacted,
    outgoingTranscript: {
      version: 1,
      windowId: 1,
      items: [
        {
          id: "mt_1_0001_user",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "user",
          content: "replaced",
        },
        {
          id: "mt_1_0002_assistant_text",
          createdAt: "2026-06-15T00:00:01.000Z",
          kind: "assistant_text",
          content: "retained",
        },
        {
          id: "mt_1_0003_user",
          createdAt: "2026-06-15T00:00:02.000Z",
          kind: "user",
          content: "new after compaction",
        },
      ],
    },
  });

  assert.equal(rebased?.items.length, 4);
  assert.equal(rebased?.items[1]?.content, "replaced");
  assert.equal(rebased?.items.at(-1)?.content, "new after compaction");
  assert.equal(rebased?.items.at(-1)?.id, "mt_2_0002_user");
});

contractTest("runtime.hermetic", "large tool results store bounded visible output with an internal raw-output ref", () => {
  const transcript = appendToolResultToTranscript({
    transcript: undefined,
    toolName: "dev.shell.run",
    toolInput: { command: "npm run build" },
    toolOutput: {
      stdout: "x".repeat(13_000),
      exitCode: 0,
    },
  });

  const item = transcript.items[0];
  const rendered = JSON.stringify(renderModelTranscriptMessages({ transcript }));

  assert.equal(item?.kind, "tool_result");
  assert.equal(item?.truncated, true);
  assert.match(String(item?.rawOutputRef), /^tool-output:[a-f0-9]{16}$/u);
  assert.match(rendered, /- command: npm run build/u);
  assert.match(rendered, /Raw output ref: tool-output:[a-f0-9]{16}/u);
  assert.match(rendered, /\[omitted \d+ chars\]/u);
});

contractTest("runtime.hermetic", "context request uses transcript and omits projection-era model fields", () => {
  const request = buildContextRequest({
    reactState: {
      modelTranscript: appendUserTurnToTranscript({
        transcript: undefined,
        message: "Build a Vite app.",
      }),
      visibleTodos: {
        objective: "Build a Vite app.",
        items: [
          { id: "build", text: "Build the app", status: "in_progress" },
        ],
      },
    },
    eventPayload: {
      message: "continue",
    },
    eventType: "user.message",
    goal: "Build a Vite app.",
    interactionMode: "build",
    activeWorkspace: {
      workspaceRoot: "/repo",
    },
  });

  assert.equal(request.modelInput.version, "transcript-v1");
  assert.equal(Object.hasOwn(request.modelInput, "supportingFacts"), false);
  assert.equal(Object.hasOwn(request.modelInput, "currentTurnSummary"), false);
  assert.equal(Object.hasOwn(request.modelInput, "evidencePack"), false);
  assert.equal(Object.hasOwn(request.modelInput, "latestToolEvidence"), false);
  assert.equal(JSON.stringify(request.messages).includes("Current work:"), true);
  assert.equal(JSON.stringify(request.messages).includes("Build the app"), true);
});

contractTest("runtime.hermetic", "context request does not render the current task twice as runtime context and transcript", () => {
  const task = "Resolve SWE-bench Verified instance sympy__sympy-20916.";
  const request = buildContextRequest({
    reactState: {},
    eventPayload: {
      message: task,
    },
    eventType: "job.run",
    goal: task,
    interactionMode: "build",
    activeWorkspace: {
      workspaceRoot: "/testbed",
    },
  });

  const userMessages = request.messages.filter((message) =>
    message.role === "user" && typeof message.content === "string"
  );
  const rendered = userMessages.map((message) => message.content).join("\n\n");

  assert.equal(userMessages.length, 2);
  assert.match(rendered, /<runtime_context>/u);
  assert.equal(rendered.split(task).length - 1, 1);
  assert.equal(request.transcript.items.some((item) => item.kind === "user"), true);
});

contractTest("runtime.hermetic", "context request still renders a new user reply separately from the current task", () => {
  const request = buildContextRequest({
    reactState: {},
    eventPayload: {
      message: "Use SQLite for storage.",
    },
    eventType: "user.message",
    goal: "Build the app.",
    interactionMode: "build",
    activeWorkspace: {
      workspaceRoot: "/repo",
    },
  });

  const userMessages = request.messages.filter((message) =>
    message.role === "user" && typeof message.content === "string"
  );
  const rendered = userMessages.map((message) => message.content).join("\n\n");

  assert.equal(userMessages.length, 3);
  assert.match(rendered, /Build the app\./u);
  assert.match(rendered, /Use SQLite for storage\./u);
  assert.deepEqual(
    request.transcript.items.filter((item) => item.kind === "user").map((item) => item.content),
    ["Build the app.", "Use SQLite for storage."],
  );
});

contractTest("runtime.hermetic", "context request surfaces recent filesystem result from runtime state", () => {
  const request = buildContextRequest({
    reactState: {
      lastActionResult: {
        kind: "tool",
        status: "ok",
        name: "fs.search_text",
        input: {
          path: "app/page.tsx",
          query: "tv/",
        },
        output: {
          path: "app/page.tsx",
          query: "tv/",
          matches: [
            {
              path: "app/page.tsx",
              line: 42,
              preview: "href={`https://api.themoviedb.org/3/tv/${id}`}",
            },
          ],
        },
      },
    },
    eventPayload: {
      message: "continue",
    },
    eventType: "user.message",
    goal: "Fix TV detail modals.",
    interactionMode: "build",
  });

  const rendered = JSON.stringify(request.messages);

  assert.match(rendered, /Recent filesystem evidence/u);
  assert.match(rendered, /fs\.search_text app\/page\.tsx/u);
  assert.match(rendered, /api\.themoviedb\.org\/3\/tv/u);
  assert.match(rendered, /before repeating the same filesystem inspection/u);
});

contractTest("runtime.hermetic", "context request surfaces ledger filesystem facts after newer actions", () => {
  const request = buildContextRequest({
    reactState: {
      lastActionResult: {
        kind: "tool",
        name: "dev.shell.run",
        status: "ok",
        output: {
          status: "COMPLETED",
          exitCode: 0,
          text: "pdflatex still has one overfull hbox",
        },
      },
      evidenceLedger: [
        {
          id: "ev-search",
          version: "v1",
          source: "tool",
          kind: "file_content",
          status: "passed",
          summary: 'fs.search_text /app/synonyms.txt for "privileged" returned 0 matches.',
          target: { type: "path", value: "/app/synonyms.txt", normalizedValue: "/app/synonyms.txt" },
          facts: {
            toolName: "fs.search_text",
            inputPath: "/app/synonyms.txt",
            outputPath: "/app/synonyms.txt",
            query: "privileged",
            matchCount: 0,
            matches: [],
          },
        },
        {
          id: "ev-replace",
          version: "v1",
          source: "tool",
          kind: "tool_result",
          status: "passed",
          summary: 'fs.replace_text "a great deal more" -> "a lot more" (1 replacement, token delta -1).',
          target: { type: "path", value: "/app/input.tex", normalizedValue: "/app/input.tex" },
          facts: {
            toolName: "fs.replace_text",
            inputPath: "/app/input.tex",
            outputPath: "/app/input.tex",
            find: "a great deal more",
            replace: "a lot more",
            replacements: 1,
            changed: true,
            findWhitespaceTokenCount: 4,
            replaceWhitespaceTokenCount: 3,
            perReplacementWhitespaceTokenDelta: -1,
            whitespaceTokenCountBefore: 939,
            whitespaceTokenCountAfter: 938,
            whitespaceTokenCountDelta: -1,
            lineCountDelta: 0,
          },
        },
        {
          id: "ev-write",
          version: "v1",
          source: "tool",
          kind: "tool_result",
          status: "passed",
          summary: "fs.write_text overwrote existing file /app/input.tex with 5120 bytes (token delta -1, line delta +0).",
          target: { type: "path", value: "/app/input.tex", normalizedValue: "/app/input.tex" },
          facts: {
            toolName: "fs.write_text",
            inputPath: "/app/input.tex",
            outputPath: "/app/input.tex",
            mode: "overwrite",
            existed: true,
            changed: true,
            bytesWritten: 5120,
            lineCountBefore: 92,
            lineCountAfter: 92,
            whitespaceTokenCountBefore: 939,
            whitespaceTokenCountAfter: 938,
          },
        },
        {
          id: "ev-shell",
          version: "v1",
          source: "tool",
          kind: "process_result",
          status: "passed",
          summary: "dev.shell.run changed input.tex.",
          target: { type: "tool", value: "dev.shell.run" },
          facts: {
            toolName: "dev.shell.run",
            command: "python3 edit.py",
            exitCode: 0,
            workspaceRoot: "/app",
            changedFiles: ["input.tex"],
          },
        },
      ],
    },
    eventPayload: {
      message: "continue",
    },
    eventType: "user.message",
    goal: "Fix the LaTeX overfull hboxes.",
    interactionMode: "build",
  });

  const rendered = JSON.stringify(request.messages);

  assert.match(rendered, /Recent filesystem evidence/u);
  assert.match(rendered, /fs\.write_text overwrote existing file \/app\/input\.tex with 5120 bytes \(token delta -1, line delta \+0\)/u);
  assert.match(rendered, /fs\.replace_text \/app\/input\.tex/u);
  assert.match(rendered, /a great deal more/u);
  assert.match(rendered, /a lot more/u);
  assert.match(rendered, /token delta -1/u);
  assert.match(rendered, /dev\.shell\.run changed files: input\.tex/u);
  assert.match(rendered, /fs\.search_text \/app\/synonyms\.txt for \\"privileged\\" returned 0 matches/u);
});

contractTest("runtime.hermetic", "context request includes compact mission control task queue context for project-backed turns", () => {
  const request = buildContextRequest({
    reactState: {},
    eventPayload: {
      message: "track the follow-ups",
    },
    eventType: "user.message",
    goal: "track the follow-ups",
    interactionMode: "chat",
    projectSnapshot: {
      sessionId: "project-session-1",
      taskQueue: {
        version: 1,
        queueVersion: 1,
        nextTaskNumber: 3,
        tasks: {
          "T-1": {
            id: "T-1",
            title: "Fix auth callback",
            instructions: "Repair the auth callback and verify login succeeds.",
            status: "running",
            priority: "high",
            order: 1,
            assignedAgentId: "agent-1",
            evidence: [
              {
                id: "evidence-1",
                timestamp: "2026-06-15T12:00:00.000Z",
                source: "agent",
                summary: "Narrowed to callback regression.",
              },
            ],
          },
          "T-2": {
            id: "T-2",
            title: "Add auth regression test",
            instructions: "Add coverage for the callback regression.",
            status: "queued",
            priority: "medium",
            order: 2,
            evidence: [],
          },
        },
      },
    },
  });

  const rendered = JSON.stringify(request.messages);
  assert.match(rendered, /Mission Control task queue/u);
  assert.match(rendered, /sessionId: project-session-1/u);
  assert.match(rendered, /T-1 \[order 1\] Fix auth callback/u);
  assert.match(rendered, /agent agent-1/u);
  assert.match(rendered, /avoid duplicates/u);
  assert.match(rendered, /task\.propose/u);
  assert.match(JSON.stringify(request.modelInput.projectTaskQueueContext), /T-2 \[order 2\] Add auth regression test/u);
});

contractTest("runtime.hermetic", "context request includes every proposed task for Plan reconciliation", () => {
  const tasks = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => {
      const taskNumber = index + 1;
      return [`T-${taskNumber}`, {
        id: `T-${taskNumber}`,
        title: `Proposal ${taskNumber}`,
        instructions: `Implement proposal ${taskNumber}.`,
        status: "proposed",
        createdBy: "agent",
        priority: "medium",
        order: taskNumber,
        evidence: [],
      }];
    }),
  );
  const request = buildContextRequest({
    reactState: {},
    eventPayload: { message: "Republish the plan." },
    eventType: "user.message",
    goal: "Republish the plan.",
    interactionMode: "plan",
    projectSnapshot: {
      sessionId: "project-session-1",
      taskQueue: {
        version: 1,
        queueVersion: 1,
        nextTaskNumber: 10,
        tasks,
      },
    },
  });

  const rendered = JSON.stringify(request.modelInput.projectTaskQueueContext);
  assert.match(rendered, /T-1 \[order 1\] Proposal 1/u);
  assert.match(rendered, /T-9 \[order 9\] Proposal 9/u);
  assert.match(rendered, /taskId/u);
});

contractTest("runtime.hermetic", "context request omits mission control task queue context for non-project turns", () => {
  const request = buildContextRequest({
    reactState: {},
    eventPayload: {
      message: "hello",
    },
    eventType: "user.message",
    goal: "hello",
    interactionMode: "chat",
  });

  assert.equal(Object.hasOwn(request.modelInput, "projectTaskQueueContext"), false);
  assert.doesNotMatch(JSON.stringify(request.messages), /Mission Control task queue/u);
});

contractTest("runtime.hermetic", "context request surfaces loop-stall recovery checkpoint after resume", () => {
  const request = buildContextRequest({
    reactState: {
      loopStall: {
        reason: "loop_visit_stall",
        status: "resumed",
        resumeInstruction: "Reply continue to resume.",
        target: {
          kind: "path",
          label: "app/page.tsx",
          path: "app/page.tsx",
        },
        diagnostic: {
          guardType: "NO_PROGRESS_REASONING_LOOP",
          actionSignature: "tool:fs.read_text app/page.tsx",
        },
        blockedAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "app/page.tsx",
          },
        },
      },
    },
    eventPayload: {
      message: "continue",
    },
    eventType: "user.reply",
    goal: "Finish the implementation.",
    interactionMode: "build",
  });

  const rendered = JSON.stringify(request.messages);

  assert.match(rendered, /Recovery checkpoint/u);
  assert.match(rendered, /Do not issue the blocked action/u);
  assert.match(rendered, /choose a different next action, finalize, or ask/u);
  assert.match(rendered, /fs\.read_text/u);
  assert.match(JSON.stringify(request.modelInput.recoveryContext), /tool:fs\.read_text app\/page\.tsx/u);
  assert.doesNotMatch(rendered, /Active wait/u);
});

contractTest("runtime.hermetic", "workspace scratchpad preserves recent filesystem result summary", () => {
  const scratchpad = buildManagedScratchpadFromRuntime({
    output: {
      status: "WAITING",
      sessionId: "session-1",
      runId: "run-1",
      quality: {
        citationCoverage: 0,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      errors: [],
      telemetry: {
        stepsExecuted: 1,
        toolCalls: 1,
        modelCalls: 1,
        durationMs: 1,
      },
    },
    session: {
      sessionId: "session-1",
      version: 1,
      updatedAt: "2026-06-12T00:00:00.000Z",
      state: {
        agent: {
          goal: "Keep going.",
          modelTranscript: appendUserTurnToTranscript({
            transcript: undefined,
            message: "Fix TV detail modals.",
            stepIndex: 1,
          }),
          lastActionResult: {
            kind: "tool",
            name: "fs.read_text",
            input: { path: "app/page.tsx" },
            output: {
              path: "app/page.tsx",
              content: "const href = `https://api.themoviedb.org/3/tv/${id}`;",
            },
          },
        },
      },
    },
  });

  assert.equal(scratchpad.goal, "Fix TV detail modals.");
  assert.equal(
    scratchpad.recentDecisions.some((item) =>
      item.includes("Ran fs.read_text on app/page.tsx") &&
      item.includes("api.themoviedb.org/3/tv")
    ),
    true,
  );
});

contractTest("runtime.hermetic", "tool result transcript correlates normalized tool inputs by canonical tool name", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_shell",
        name: "dev.shell.run",
        input: { command: "pwd" },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "dev.shell.run",
    toolInput: { command: "pwd", timeoutMs: 30_000 },
    toolOutput: { exitCode: 0, stdout: "/repo\n" },
  });

  const toolResult = renderModelTranscriptMessages({ transcript }).find((message) => message.role === "tool");

  assert.equal(toolResult?.toolCallId, "call_shell");
});

contractTest("runtime.hermetic", "rendering repairs dangling tool calls instead of sending provider-invalid history", () => {
  const transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_missing_result",
        name: "kestrel.finalize",
        input: {
          status: "goal_satisfied",
          message: "Done.",
        },
      },
    ],
  });

  const messages = renderModelTranscriptMessages({ transcript });
  const rendered = JSON.stringify(messages);

  assert.equal(messages.some((message) => message.role === "assistant" && message.toolCalls !== undefined), false);
  assert.equal(messages.some((message) => message.role === "tool"), false);
  assert.match(rendered, /Transcript repair/u);
  assert.match(rendered, /call_missing_result/u);
});

contractTest("runtime.hermetic", "rendering repairs orphan tool results instead of sending provider-invalid tool output", () => {
  const transcript = appendToolResultToTranscript({
    transcript: undefined,
    toolName: "fs.read_text",
    toolInput: { path: "src/App.jsx" },
    toolOutput: { content: "hello" },
  });

  const messages = renderModelTranscriptMessages({ transcript });
  const rendered = JSON.stringify(messages);

  assert.equal(messages.some((message) => message.role === "tool"), false);
  assert.equal(messages.some((message) => message.role === "assistant" && message.toolCalls !== undefined), false);
  assert.match(rendered, /Transcript repair/u);
  assert.match(rendered, /Tool result: fs.read_text/u);
});

contractTest("runtime.hermetic", "compaction stores visible summary and retained transcript tail", () => {
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Initial task",
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "fs.read_text",
    toolInput: { path: "old.txt" },
    toolOutput: { content: "old content" },
  });
  transcript = appendUserTurnToTranscript({
    transcript,
    message: "Continue from here",
  });

  const compacted = compactModelTranscript({
    transcript,
    summary: "Summary of older work.",
    retainedTailItems: 1,
  });

  assert.equal(compacted.windowId, transcript.windowId + 1);
  assert.equal(compacted.items[0]?.kind, "compaction_summary");
  assert.equal(compacted.items[0]?.id, "mt_2_0001_compaction_summary");
  assert.equal(compacted.items[0]?.content, "Summary of older work.");
  assert.equal(compacted.items[1]?.kind, "user");
  assert.equal(compacted.items[1]?.content, "Initial task");
  assert.equal(compacted.items.at(-1)?.content, "Continue from here");
  assert.equal(readActiveTaskGoalFromTranscript(compacted), "Initial task");
  assert.equal(compacted.compactions?.length, 1);
  assert.deepEqual(compacted.compactions?.[0]?.replacedItemIds, [transcript.items[1]?.id]);
  assert.deepEqual(compacted.compactions?.[0]?.retainedItemIds, [transcript.items[0]?.id, transcript.items[2]?.id]);
});

contractTest("runtime.hermetic", "compaction preserves active task plus latest correction", () => {
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Build the dashboard.",
  });
  transcript = appendToolResultToTranscript({
    transcript,
    toolName: "fs.read_text",
    toolInput: { path: "src/old.ts" },
    toolOutput: { content: "old evidence" },
  });
  transcript = appendCorrectionToTranscript({
    transcript,
    message: "Use the existing chart library.",
  });

  const compacted = compactModelTranscript({
    transcript,
    summary: "Older evidence was summarized.",
    retainedTailItems: 1,
  });

  assert.equal(readActiveTaskGoalFromTranscript(compacted), "Build the dashboard.");
  assert.deepEqual(
    compacted.items.map((item) => item.kind),
    ["compaction_summary", "user", "correction"],
  );
  assert.equal(compacted.items[2]?.content, "Use the existing chart library.");
  assert.deepEqual(compacted.compactions?.[0]?.replacedItemIds, [transcript.items[1]?.id]);
  assert.deepEqual(compacted.compactions?.[0]?.retainedItemIds, [transcript.items[0]?.id, transcript.items[2]?.id]);
});

contractTest("runtime.hermetic", "compaction retains matched tool call and result pairs in retained tails", () => {
  let transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        name: "fs.read_text",
        input: {
          path: "src/App.jsx",
        },
      },
    ],
  });
  transcript = appendToolResultToTranscript({
    transcript,
    stepIndex: 2,
    toolName: "fs.read_text",
    toolInput: {
      path: "src/App.jsx",
    },
    toolOutput: {
      content: "export default function App() { return null; }",
    },
  });

  const compacted = compactModelTranscript({
    transcript,
    summary: "Older work summary.",
    retainedTailItems: 1,
  });
  const rendered = JSON.stringify(renderModelTranscriptMessages({ transcript: compacted }));

  assert.equal(compacted.items.some((item) => item.kind === "tool_call"), true);
  assert.equal(compacted.items.some((item) => item.kind === "tool_result"), true);
  assert.doesNotMatch(rendered, /Transcript repair/u);
  assert.match(rendered, /export default function App/u);
});

contractTest("runtime.hermetic", "compaction drops dangling tool calls from retained tails instead of preserving repair spam", () => {
  const transcript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_without_result",
        name: "fs.read_text",
        input: {
          path: "missing.txt",
        },
      },
    ],
  });

  const compacted = compactModelTranscript({
    transcript,
    summary: "Older work summary.",
    retainedTailItems: 1,
  });
  const rendered = JSON.stringify(renderModelTranscriptMessages({ transcript: compacted }));

  assert.equal(compacted.items.some((item) => item.kind === "tool_call"), false);
  assert.doesNotMatch(rendered, /Transcript repair/u);
  assert.doesNotMatch(rendered, /missing\.txt/u);
});
