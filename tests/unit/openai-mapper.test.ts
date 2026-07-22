import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import {
  buildOpenAiHttpRequest,
  mapOpenAiResponse,
} from "../../models/index.js";
import { contractTest } from "../helpers/contract-test.js";


const env = {
  providerName: "openai" as const,
  providerLabel: "OpenAI",
  model: "gpt-5.2",
  baseUrl: "https://api.openai.com",
};

contractTest("runtime.hermetic", "OpenAI mapper preserves cache and reasoning token classes", () => {
  const mapped = mapOpenAiResponse({
    model: "gpt-5.2",
    choices: [{ message: { content: "done" } }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  }, { providerName: "openai", requestedModel: "gpt-5.2" });

  assert.deepEqual(mapped.usage, {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cachedInputTokens: 8,
    reasoningTokens: 4,
  });
});

contractTest("runtime.hermetic", "OpenAI request builder enables native parallel tool calls", () => {
  const request: ModelRequest = {
    input: {
      taskInstruction: "Run the check.",
    },
    model: "gpt-5.2",
    messages: [
      {
        role: "user",
        content: "Run the check.",
      },
    ],
    tools: [
      {
        name: "dev_shell_run",
        description: "Run a bounded shell command.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ],
    providerOptions: {
      openai: {
        endpoint: "chat",
        toolChoice: "auto",
      },
    },
  };

  const mapped = buildOpenAiHttpRequest(request, env);

  assert.equal(mapped.body.tool_choice, "auto");
  assert.equal(mapped.body.parallel_tool_calls, true);
  assert.deepEqual(mapped.body.tools, [
    {
      type: "function",
      function: {
        name: "dev_shell_run",
        description: "Run a bounded shell command.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
  ]);
});

contractTest("runtime.hermetic", "OpenAI mapper ignores JSON toolIntents when native tool calls are absent", () => {
  const mapped = mapOpenAiResponse<{
    toolIntents: Array<{ name: string; input: Record<string, unknown> }>;
  }>(
    {
      model: "gpt-5.2",
      choices: [
        {
          message: {
            content: JSON.stringify({
              toolIntents: [
                {
                  name: "dev_shell_run",
                  input: { command: "pnpm test" },
                },
              ],
            }),
          },
        },
      ],
    },
    {
      providerName: "openai",
      requestedModel: "gpt-5.2",
    },
  );

  assert.equal(mapped.toolIntents.length, 0);
});

contractTest("runtime.hermetic", "OpenAI-compatible request builder serializes assistant tool-call history with provider aliases", () => {
  const request: ModelRequest = {
    model: "local-model",
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
      openai: {
        toolChoice: "auto",
      },
    },
  };

  const mapped = buildOpenAiHttpRequest(request, {
    providerName: "lmstudio",
    providerLabel: "LM Studio",
    model: "local-model",
    baseUrl: "http://localhost:1234",
  });
  const messages = mapped.body.messages as Array<Record<string, unknown>>;
  const assistant = messages[0] as Record<string, unknown>;
  const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>;
  const tool = messages[1] as Record<string, unknown>;

  assert.equal(toolCalls[0]?.id, "call_shell");
  assert.equal(((toolCalls[0]?.function as Record<string, unknown>) ?? {}).name, "dev_shell_run");
  assert.equal(tool.tool_call_id, "call_shell");
  assert.equal(tool.name, "dev_shell_run");
});

contractTest("runtime.hermetic", "OpenAI-compatible response mapper returns canonical provider tool intent names from local providers", () => {
  const mapped = mapOpenAiResponse(
    {
      model: "local-model",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_final",
                type: "function",
                function: {
                  name: "kestrel_finalize",
                  arguments: JSON.stringify({
                    status: "goal_satisfied",
                    message: "Done.",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      providerName: "ollama",
      requestedModel: "local-model",
    },
  );

  assert.deepEqual(mapped.toolIntents, [
    {
      id: "call_final",
      name: "kestrel_finalize",
      input: {
        status: "goal_satisfied",
        message: "Done.",
      },
    },
  ]);
  assert.equal(mapped.provider.name, "ollama");
});

contractTest("runtime.hermetic", "Ollama OpenAI-compatible request builder serializes tool history with provider aliases", () => {
  const request: ModelRequest = {
    model: "llama-local",
    input: {},
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read",
            name: "fs.read_text",
            input: { path: "src/App.jsx" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read",
        name: "fs.read_text",
        content: "export default function App() {}",
      },
    ],
    tools: [
      {
        name: "fs_read_text",
        description: "Read a text file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    providerOptions: {
      openai: {
        toolChoice: "auto",
      },
    },
  };

  const mapped = buildOpenAiHttpRequest(request, {
    providerName: "ollama",
    providerLabel: "Ollama",
    model: "llama-local",
    baseUrl: "http://localhost:11434",
  });
  const messages = mapped.body.messages as Array<Record<string, unknown>>;
  const assistant = messages[0] as Record<string, unknown>;
  const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>;
  const tool = messages[1] as Record<string, unknown>;

  assert.equal(((toolCalls[0]?.function as Record<string, unknown>) ?? {}).name, "fs_read_text");
  assert.equal(tool.name, "fs_read_text");
  assert.equal(mapped.body.tool_choice, "auto");
  assert.equal(mapped.body.parallel_tool_calls, true);
});

contractTest("runtime.hermetic", "LM Studio OpenAI-compatible response mapper returns native tool intents", () => {
  const mapped = mapOpenAiResponse(
    {
      model: "qwen-local",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_shell",
                type: "function",
                function: {
                  name: "dev_shell_run",
                  arguments: JSON.stringify({ command: "npm run build" }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      providerName: "lmstudio",
      requestedModel: "qwen-local",
    },
  );

  assert.deepEqual(mapped.toolIntents, [
    {
      id: "call_shell",
      name: "dev_shell_run",
      input: { command: "npm run build" },
    },
  ]);
  assert.equal(mapped.provider.name, "lmstudio");
});

contractTest("runtime.hermetic", "OpenAI Responses requests provider summaries without storing raw reasoning", () => {
  const mapped = buildOpenAiHttpRequest({
    model: "gpt-5.2",
    input: "decide",
    reasoning: { mode: "summary", effort: "medium" },
  }, env);

  assert.equal(mapped.endpoint, "responses");
  assert.equal(mapped.body.store, false);
  assert.deepEqual(mapped.body.reasoning, { summary: "auto", effort: "medium" });
  assert.deepEqual(mapped.body.include, ["reasoning.encrypted_content"]);
});

contractTest("runtime.hermetic", "OpenAI Responses maps summaries separately and keeps encrypted state opaque", () => {
  const encryptedItem = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Checked the constraints." }],
    encrypted_content: "opaque-ciphertext",
  };
  const mapped = mapOpenAiResponse({
    model: "gpt-5.2",
    output: [
      encryptedItem,
      { type: "message", content: [{ type: "output_text", text: "Done." }] },
    ],
  }, {
    providerName: "openai",
    endpoint: "responses",
    requestedModel: "gpt-5.2",
  });

  assert.equal(mapped.text, "Done.");
  assert.deepEqual(mapped.reasoning?.visible, [
    { format: "summary", text: "Checked the constraints." },
  ]);
  assert.deepEqual(mapped.reasoning?.continuation, [
    { provider: "openai", kind: "encrypted_content", value: encryptedItem },
  ]);
});
