import assert from "node:assert/strict";
import { mobileMessageParts, mobileV2DurablePartTypes } from "./message-parts";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "mobile v2 retains progress and tool activity after reload", () => {
  assert.equal(mobileV2DurablePartTypes.has("progress"), true);
  assert.equal(mobileV2DurablePartTypes.has("tool_status"), true);
});

contractTest("web.hermetic", "mobile snapshots preserve the durable Kestrel presentation timeline", () => {
  const parts = mobileMessageParts([
    {
      type: "data-kestrel-progress",
      data: {
        id: "progress-1",
        phase: "agent",
        text: "Inspecting sources.",
        timestamp: "2026-07-15T12:00:00.000Z",
      },
    },
    {
      type: "data-kestrel-agent-progress",
      data: {
        id: "agent-progress-1",
        label: "Agent progress",
        text: "Comparing the results.",
        timestamp: "2026-07-15T12:00:01.000Z",
      },
    },
    {
      type: "data-kestrel-tool",
      data: {
        toolCallId: "tool-1",
        toolName: "knowledge.search",
        phase: "completed",
      },
    },
    {
      type: "data-kestrel-citation",
      data: { id: "citation-1", title: "Project brief", documentId: "doc-1" },
    },
    {
      type: "data-kestrel-artifact",
      data: { id: "artifact-1", title: "Analysis", kind: "document" },
    },
    {
      type: "data-kestrel-interaction",
      data: {
        requestId: "request-1",
        kind: "user_input",
        prompt: "Which project?",
        status: "resolved",
      },
    },
    {
      type: "data-kestrel-status",
      data: { status: "completed" },
    },
    {
      type: "data-kestrel-provider-reasoning",
      data: { delta: "private provider reasoning" },
    },
    { type: "text", text: "The answer." },
  ]);

  assert.deepEqual(
    parts.map((part) => part.type),
    [
      "progress",
      "progress",
      "tool_status",
      "citation",
      "artifact",
      "interaction_status",
      "assistant_status",
      "text",
    ]
  );
  assert.equal(
    parts.some((part) =>
      JSON.stringify(part).includes("private provider reasoning")
    ),
    false
  );
  assert.deepEqual(
    parts.filter((part) => part.type === "tool_status"),
    [
      {
        type: "tool_status",
        toolCallId: "tool-1",
        toolName: "knowledge.search",
        state: "completed",
      },
    ]
  );
  assert.deepEqual(
    parts.filter((part) => part.type === "interaction_status"),
    [
      {
        type: "interaction_status",
        requestId: "request-1",
        kind: "question",
        prompt: "Which project?",
        status: "resolved",
      },
    ]
  );
});

contractTest("web.hermetic", "mobile snapshots never label runtime progress as agent progress", () => {
  const parts = mobileMessageParts([
    {
      type: "data-kestrel-progress",
      data: {
        id: "progress-runtime-1",
        code: "MODEL_CALL_STARTED",
        text: "Calling decision model (Qwen/Qwen3-8B).",
        timestamp: "2026-07-15T12:00:00.000Z",
      },
    },
  ]);

  assert.deepEqual(parts, [
    {
      type: "progress",
      id: "progress-runtime-1",
      category: "runtime",
      label: "Runtime activity",
      text: "Working",
      timestamp: "2026-07-15T12:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(parts).includes("Qwen"), false);
});

contractTest("web.hermetic", "mobile snapshots expose contract failure without leaking internal errors", () => {
  assert.deepEqual(
    mobileMessageParts([
      {
        type: "data-kestrel-status",
        data: {
          status: "contract_failure",
          errorMessage: "database-password-was-here",
        },
      },
    ]),
    [
      {
        type: "assistant_status",
        status: "contract_failure",
        errorCode: "PRESENTATION_CONTRACT_FAILURE",
        message: "The agent returned a malformed response.",
      },
    ]
  );
});

contractTest("web.hermetic", "mobile snapshots collapse internal tool states to a stable public enum", () => {
  const states = [
    "input-streaming",
    "input-available",
    "approval-requested",
    "approval-responded",
    "output-available",
    "output-error",
    "output-denied",
    "future-internal-state",
  ];
  assert.deepEqual(
    mobileMessageParts(
      states.map((state, index) => ({
        type: "dynamic-tool",
        toolCallId: `tool-${index}`,
        toolName: "test.tool",
        state,
      }))
    ).map((part) => (part.type === "tool_status" ? part.state : null)),
    [
      "pending",
      "running",
      "waiting_for_approval",
      "running",
      "completed",
      "failed",
      "denied",
      "unavailable",
    ]
  );
});

contractTest("web.hermetic", "mobile snapshots omit unrecognized internal interaction and status values", () => {
  assert.deepEqual(
    mobileMessageParts([
      {
        type: "data-kestrel-interaction",
        data: {
          requestId: "internal-interaction",
          kind: "provider_secret",
          prompt: "Do not expose this",
          status: "pending",
        },
      },
      {
        type: "data-kestrel-status",
        data: { status: "provider_internal_failure" },
      },
    ]),
    []
  );
});

contractTest("web.hermetic", "mobile snapshots replace MCP sampling prompts with safe copy", () => {
  const parts = mobileMessageParts([
    {
      type: "data-kestrel-interaction",
      data: {
        requestId: "sampling-1",
        kind: "mcp_sampling",
        prompt: "Secret provider prompt with tool credentials",
        status: "pending",
      },
    },
  ]);
  assert.deepEqual(parts, [
    {
      type: "interaction_status",
      requestId: "sampling-1",
      kind: "approval",
      prompt: "The agent requested a protected operation.",
      status: "pending",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(parts), /provider|credentials/iu);
});
