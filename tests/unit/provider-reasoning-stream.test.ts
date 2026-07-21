import assert from "node:assert/strict";

import {
  createAnthropicInvoker,
  createOpenAiInvoker,
  createOpenRouterInvoker,
} from "../../models/index.js";
import { readServerSentEvents } from "../../models/SseStream.js";
import type { ModelGatewayStreamEvent } from "../../src/kestrel/contracts/model-io.js";
import { contractTest } from "../helpers/contract-test.js";


function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

contractTest("runtime.hermetic", "OpenAI Responses streams labeled summary deltas and returns opaque continuation", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const encrypted = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Verified the contract." }],
    encrypted_content: "opaque",
  };
  const invoker = createOpenAiInvoker({
    env: {
      providerName: "openai",
      providerLabel: "OpenAI",
      apiKey: "key",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com",
    },
    fetchImpl: (async () => sse([
      { type: "response.reasoning_summary_text.delta", delta: "Verified " },
      { type: "response.reasoning_summary_text.delta", delta: "the contract." },
      { type: "response.reasoning_summary_text.done" },
      { type: "response.output_text.delta", delta: "Done." },
      { type: "response.completed", response: { model: "gpt-5.2", output: [encrypted, { type: "message", content: [{ type: "output_text", text: "Done." }] }] } },
    ])) as typeof fetch,
  });
  const response = await invoker({ input: "decide", reasoning: { mode: "summary" } }, {
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.started",
    "reasoning.delta",
    "reasoning.delta",
    "reasoning.completed",
    "output.delta",
  ]);
  assert.equal(response.text, "Done.");
  assert.equal(response.reasoning?.continuation[0]?.kind, "encrypted_content");
});

contractTest("runtime.hermetic", "Anthropic streams thinking separately and preserves the signature block", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const invoker = createAnthropicInvoker({
    env: { apiKey: "key", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", version: "2023-06-01" },
    fetchImpl: (async () => sse([
      { type: "message_start", message: { model: "claude-sonnet-4-5", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checked." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ])) as typeof fetch,
  });
  const response = await invoker({ input: "decide", reasoning: { mode: "provider_visible" } }, {
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.started", "reasoning.delta", "reasoning.completed", "output.delta",
  ]);
  assert.equal(response.reasoning?.visible[0]?.text, "Checked.");
  assert.equal((response.reasoning?.continuation[0]?.value as { signature?: string }).signature, "opaque-signature");
});

contractTest("runtime.hermetic", "OpenRouter streams summary details without folding them into answer text", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const details = [{ type: "reasoning.summary", summary: "Checked." }];
  const invoker = createOpenRouterInvoker({
    env: { apiKey: "key", model: "openai/gpt-5.2", baseUrl: "https://openrouter.ai" },
    fetchImpl: (async () => sse([
      { model: "openai/gpt-5.2", choices: [{ delta: { reasoning_details: details } }] },
      { choices: [{ delta: { content: "Done." } }] },
      "[DONE]",
    ])) as typeof fetch,
  });
  const response = await invoker({ input: "decide", reasoning: { mode: "provider_visible" } }, {
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(response.text, "Done.");
  assert.equal(response.reasoning?.visible[0]?.text, "Checked.");
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.started", "reasoning.delta", "output.delta", "reasoning.completed",
  ]);
});

contractTest("runtime.hermetic", "OpenRouter emits one reasoning delta when chat aliases carry the same fragment", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const invoker = createOpenRouterInvoker({
    env: { apiKey: "key", model: "z-ai/glm-5.2", baseUrl: "https://openrouter.ai" },
    fetchImpl: (async () => sse([
      {
        model: "z-ai/glm-5.2",
        choices: [{
          delta: {
            reasoning: "Let me gather content.",
            reasoning_details: [{ type: "reasoning.text", text: "Let me gather content." }],
          },
        }],
      },
      { choices: [{ delta: { content: "Done." } }] },
      "[DONE]",
    ])) as typeof fetch,
  });

  await invoker({ input: "compare birds", reasoning: { mode: "provider_visible" } }, {
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(
    events.flatMap((event) => event.type === "reasoning.delta" ? [event.delta] : []),
    ["Let me gather content."],
  );
});

contractTest("runtime.hermetic", "the SSE reader preserves frames when CRLF separators are split across chunks", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: update\r\ndata: first\r",
    "\n\r",
    "\ndata: second\r\n\r\n",
  ];
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
  const events: Array<{ event?: string | undefined; data: string }> = [];
  await readServerSentEvents(response, (event) => { events.push(event); });
  assert.deepEqual(events, [
    { event: "update", data: "first" },
    { data: "second" },
  ]);
});

contractTest("runtime.hermetic", "OpenAI emits a neutral unavailable state when a requested summary is absent", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const invoker = createOpenAiInvoker({
    env: {
      providerName: "openai",
      providerLabel: "OpenAI",
      apiKey: "key",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com",
    },
    fetchImpl: (async () => sse([
      { type: "response.output_text.delta", delta: "Done." },
      { type: "response.completed", response: { model: "gpt-5.2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] } },
    ])) as typeof fetch,
  });
  await invoker({ input: "decide", reasoning: { mode: "summary" } }, {
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(events.map((event) => event.type), [
    "output.delta",
    "reasoning.unavailable",
  ]);
});

contractTest("runtime.hermetic", "Anthropic emits a neutral unavailable state when visible thinking is absent", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const invoker = createAnthropicInvoker({
    env: { apiKey: "key", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", version: "2023-06-01" },
    fetchImpl: (async () => sse([
      { type: "message_start", message: { model: "claude-sonnet-4-5", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ])) as typeof fetch,
  });
  await invoker({ input: "decide", reasoning: { mode: "provider_visible" } }, {
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(events.map((event) => event.type), [
    "output.delta",
    "reasoning.unavailable",
  ]);
});

contractTest("runtime.hermetic", "OpenRouter emits a neutral unavailable state when reasoning details are absent", async () => {
  const events: ModelGatewayStreamEvent[] = [];
  const invoker = createOpenRouterInvoker({
    env: { apiKey: "key", model: "openai/gpt-5.2", baseUrl: "https://openrouter.ai" },
    fetchImpl: (async () => sse([
      { model: "openai/gpt-5.2", choices: [{ delta: { content: "Done." } }] },
      "[DONE]",
    ])) as typeof fetch,
  });
  await invoker({ input: "decide", reasoning: { mode: "provider_visible" } }, {
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(events.map((event) => event.type), [
    "output.delta",
    "reasoning.unavailable",
  ]);
});

contractTest("runtime.hermetic", "a provider reasoning delta is observable before the model call completes", async () => {
  const encoder = new TextEncoder();
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  let sawDelta!: () => void;
  const deltaSeen = new Promise<void>((resolve) => { sawDelta = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Checking" })}\n\n`));
      await completionGate;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.reasoning_summary_text.done" })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-5.2", output: [] } })}\n\n`));
      controller.close();
    },
  }));
  const invoker = createOpenAiInvoker({
    env: {
      providerName: "openai",
      providerLabel: "OpenAI",
      apiKey: "key",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com",
    },
    fetchImpl: (async () => response) as typeof fetch,
  });
  let completed = false;
  const call = invoker({ input: "decide", reasoning: { mode: "summary" } }, {
    onEvent: (event) => {
      if (event.type === "reasoning.delta") sawDelta();
    },
  }).then((result) => {
    completed = true;
    return result;
  });
  await deltaSeen;
  assert.equal(completed, false);
  releaseCompletion();
  await call;
});
