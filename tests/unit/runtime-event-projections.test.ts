import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPersistedRuntimeEventFromProgressUpdate,
  buildPersistedRuntimeEventFromReasoningUpdate,
  buildPersistedRuntimeEventFromToolUpdate,
  readProgressUpdateFromPersistedRuntimeEvent,
  readReasoningUpdateFromPersistedRuntimeEvent,
  readToolUpdateFromPersistedRuntimeEvent,
} from "../../src/events/RuntimeEventProjections.js";


test("progress updates project through persisted runtime events", () => {
  const update = {
    version: "v1" as const,
    runId: "run-progress",
    sessionId: "session-progress",
    ts: "2026-06-08T18:00:00.000Z",
    seq: 4,
    kind: "tool" as const,
    phase: "acter" as const,
    code: "TOOL_CALL_DONE" as const,
    message: "Tool finished.",
    stepIndex: 2,
    stepAgent: "agent.loop",
    tool: {
      name: "fs.read_text",
      status: "DONE" as const,
      latencyMs: 42,
    },
    progress: {
      completedSteps: 2,
      maxSteps: 5,
    },
    persist: true,
  };

  const event = buildPersistedRuntimeEventFromProgressUpdate(update);
  const projected = readProgressUpdateFromPersistedRuntimeEvent(event);
  assert.deepEqual(projected, update);
});

test("reasoning updates project through persisted runtime events", () => {
  const update = {
    version: "v1" as const,
    runId: "run-reasoning",
    sessionId: "session-reasoning",
    ts: "2026-06-08T18:00:01.000Z",
    seq: 7,
    milestone: "phase_changed" as const,
    message: "Switching to finalize.",
    stepIndex: 3,
    stepAgent: "agent.finalize",
    model: {
      provider: "openrouter",
      model: "gpt-test",
      latencyMs: 12,
    },
  };

  const event = buildPersistedRuntimeEventFromReasoningUpdate(update);
  const projected = readReasoningUpdateFromPersistedRuntimeEvent(event);
  assert.deepEqual(projected, update);
});

test("tool updates project through persisted runtime events", () => {
  const update = {
    version: "v1" as const,
    runId: "run-tool",
    sessionId: "session-tool",
    ts: "2026-06-08T18:00:02.000Z",
    seq: 12,
    toolCallId: "tool:run-tool:123",
    toolName: "fs.replace_text",
    phase: "completed" as const,
    stepIndex: 4,
    stepAgent: "agent.tools",
    displayName: "Fs Replace Text",
    toolFamily: "filesystem",
    provider: "kestrel",
    input: {
      path: "apps/web/app/page.tsx",
      search: "old",
      replacement: "new",
    },
    output: {
      changed: true,
      replacements: 2,
      bytesWritten: 128,
    },
    durationMs: 17,
  };

  const event = buildPersistedRuntimeEventFromToolUpdate(update);
  assert.equal(event.type, "run.tool.completed");
  assert.equal(event.level, "INFO");
  const projected = readToolUpdateFromPersistedRuntimeEvent(event);
  assert.deepEqual(projected, update);
});

test("v2 tool outcome evidence survives persisted runtime projection", () => {
  const activation = {
    version: "v1" as const,
    descriptor: {
      version: "v1" as const,
      toolId: "mcp.test.mutate",
      sourceKind: "mcp" as const,
      sourceId: "test",
      contractRevision: `sha256:${"a".repeat(64)}`,
      inputSchemaHash: `sha256:${"b".repeat(64)}`,
      outputContractHash: `sha256:${"c".repeat(64)}`,
    },
    registryGeneration: "generation-1",
    scopeFingerprint: `sha256:${"d".repeat(64)}`,
  };
  const update = {
    version: "v2" as const,
    runId: "run-approved-continuation",
    sessionId: "session-approved",
    ts: "2026-08-26T18:00:00.000Z",
    seq: 3,
    toolCallId: "prepared-call-1",
    toolName: "mcp.test.mutate",
    activation,
    phase: "completed" as const,
    outcome: {
      version: "v1" as const,
      callId: "prepared-call-1",
      activation,
      kind: "success" as const,
      startedAt: "2026-08-26T17:59:59.000Z",
      completedAt: "2026-08-26T18:00:00.000Z",
      effectState: "committed" as const,
      rawOutput: { changed: true },
    },
    output: { changed: true },
  };

  const event = buildPersistedRuntimeEventFromToolUpdate(update);
  assert.deepEqual(readToolUpdateFromPersistedRuntimeEvent(event), update);
});
