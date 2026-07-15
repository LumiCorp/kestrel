import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import { buildAnthropicHttpRequest, mapAnthropicResponse } from "../../models/index.js";

test("Anthropic request builder serializes assistant tool-call history with provider aliases", () => {
  const request: ModelRequest = {
    model: "claude-test",
    input: {},
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_shell",
            name: "dev.shell.run",
            input: { command: "npm run build" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_shell",
        name: "dev.shell.run",
        content: "build passed",
      },
    ],
    tools: [
      {
        name: "dev_shell_run",
        description: "Run a bounded shell command.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
    providerOptions: {
      anthropic: {
        toolChoice: "auto",
      },
    },
  };

  const mapped = buildAnthropicHttpRequest(request, {
    apiKey: "key",
    model: "claude-test",
    baseUrl: "https://api.anthropic.com",
    version: "2023-06-01",
  });
  const messages = mapped.body.messages as Array<Record<string, unknown>>;
  const assistantContent = messages[0]?.content as Array<Record<string, unknown>>;
  const toolResultContent = messages[1]?.content as Array<Record<string, unknown>>;

  assert.deepEqual(assistantContent[0], {
    type: "tool_use",
    id: "call_shell",
    name: "dev_shell_run",
    input: { command: "npm run build" },
  });
  assert.deepEqual(toolResultContent[0], {
    type: "tool_result",
    tool_use_id: "call_shell",
    content: "build passed",
  });
});

test("Anthropic adaptive thinking is visible and its signed block is preserved exactly", () => {
  const signedThinking = {
    type: "thinking",
    thinking: "I checked the provider contract.",
    signature: "opaque-signature",
  };
  const mapped = mapAnthropicResponse({
    model: "claude-sonnet-4-5",
    content: [signedThinking, { type: "text", text: "Ready." }],
  }, { requestedModel: "claude-sonnet-4-5" });

  assert.deepEqual(mapped.reasoning?.visible, [
    { format: "provider_thinking", text: "I checked the provider contract." },
  ]);
  assert.deepEqual(mapped.reasoning?.continuation, [
    { provider: "anthropic", kind: "signature", value: signedThinking },
  ]);

  const request = buildAnthropicHttpRequest({
    model: "claude-sonnet-4-5",
    input: "continue",
    reasoning: {
      mode: "provider_visible",
      effort: "high",
      continuation: mapped.reasoning?.continuation,
    },
    messages: [{ role: "assistant", content: "Ready." }, { role: "user", content: "Continue." }],
  }, {
    apiKey: "key",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
    version: "2023-06-01",
  });
  assert.deepEqual(request.body.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(request.body.output_config, { effort: "high" });
  const messages = request.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual((messages[0]?.content as unknown[])[0], signedThinking);
});
