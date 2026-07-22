import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import { buildAnthropicHttpRequest, mapAnthropicResponse } from "../../models/index.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "Anthropic mapper preserves cache read and cache write token classes", () => {
  const mapped = mapAnthropicResponse({
    model: "claude-test",
    content: [{ type: "text", text: "done" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 7,
    },
  }, { requestedModel: "claude-test" });

  assert.deepEqual(mapped.usage, {
    inputTokens: 37,
    outputTokens: 5,
    totalTokens: 42,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 7,
  });
});

contractTest("runtime.hermetic", "Anthropic request builder places explicit ephemeral cache breakpoints on stable system and tool blocks", () => {
  const mapped = buildAnthropicHttpRequest({
    model: "claude-test",
    input: "Act now",
    messages: [
      { role: "system", content: "Stable system instructions." },
      { role: "user", content: "Act now" },
    ],
    tools: [
      { name: "read", description: "Read.", inputSchema: { type: "object" } },
      { name: "write", description: "Write.", inputSchema: { type: "object" } },
    ],
    providerOptions: { anthropic: { cacheControl: "ephemeral" } },
  }, {
    apiKey: "key",
    model: "claude-test",
    baseUrl: "https://api.anthropic.com",
    version: "2023-06-01",
  });

  assert.deepEqual(mapped.body.system, [{
    type: "text",
    text: "Stable system instructions.",
    cache_control: { type: "ephemeral" },
  }]);
  const tools = mapped.body.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.cache_control, undefined);
  assert.deepEqual(tools[1]?.cache_control, { type: "ephemeral" });
});


contractTest("runtime.hermetic", "Anthropic request builder serializes assistant tool-call history with provider aliases", () => {
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

contractTest("runtime.hermetic", "Anthropic request builder honors direct and OpenRouter fallback parallel-call controls", () => {
  const baseRequest: ModelRequest = {
    model: "claude-test",
    input: "Act now",
    tools: [{
      name: "calendar_create_event",
      description: "Create an event.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    }],
  };
  const env = {
    apiKey: "key",
    model: "claude-test",
    baseUrl: "https://api.anthropic.com",
    version: "2023-06-01",
  };

  const direct = buildAnthropicHttpRequest({
    ...baseRequest,
    providerOptions: {
      anthropic: { toolChoice: "required", parallelToolCalls: false },
    },
  }, env);
  assert.deepEqual(direct.body.tool_choice, {
    type: "any",
    disable_parallel_tool_use: true,
  });

  const fallback = buildAnthropicHttpRequest({
    ...baseRequest,
    providerOptions: {
      openrouter: { toolChoice: "required", parallelToolCalls: false },
    },
  }, env);
  assert.deepEqual(fallback.body.tool_choice, {
    type: "any",
    disable_parallel_tool_use: true,
  });
});

contractTest("runtime.hermetic", "Anthropic adaptive thinking is visible and its signed block is preserved exactly", () => {
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
