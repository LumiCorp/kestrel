import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

function modelResponse(output: unknown): ModelResponse<unknown> {
  const record = output !== null && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : undefined;
  const toolIntents = actionToolIntents(record?.nextAction);
  const normalizedOutput =
    record !== undefined &&
    record.understanding === undefined &&
    record.nextAction !== undefined &&
    typeof record.reason === "string"
      ? {
          understanding: {
            task: "Handle the requested reference recovery task.",
            facts: ["The deterministic test model selected the next agent action."],
            currentGap: "The test run still needs that action to continue.",
            actionBasis: "The selected action advances the deterministic scenario.",
          },
          ...record,
        }
      : output;
  return {
    output: normalizedOutput,
    toolIntents,
    provider: {
      name: "openrouter",
      model: "test-model",
      endpoint: "chat",
    },
  };
}

function actionToolIntents(action: unknown): ModelResponse<unknown>["toolIntents"] {
  const record = action !== null && typeof action === "object" && !Array.isArray(action)
    ? action as Record<string, unknown>
    : undefined;
  const kind = typeof record?.kind === "string" ? record.kind : undefined;
  if (kind === "tool") {
    const name = typeof record?.name === "string" ? record.name : undefined;
    const input = record?.input !== null && typeof record?.input === "object" && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    return name !== undefined ? [{ name: name.replace(/[^A-Za-z0-9_]/gu, "_"), input }] : [];
  }
  if (kind === "finalize") {
    return [{
      name: "kestrel_finalize",
      input: {
        status: typeof record?.status === "string" ? record.status : "goal_satisfied",
        message: typeof record?.message === "string" ? record.message : "Done.",
      },
    }];
  }
  if (kind === "ask_user") {
    return [{
      name: "kestrel_ask_user",
      input: {
        prompt: typeof record?.prompt === "string" ? record.prompt : "Please clarify.",
      },
    }];
  }
  return [];
}

test("reference harness uses free.weather.current for 'whats the weather in cincy'", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "free.weather.current") {
        return {
          source: "test-weather",
          temperatureC: 12,
          apparentTemperatureC: 11,
          humidityPct: 55,
          windSpeedKph: 6,
          observedAt: "2026-03-12T13:24:00.000Z",
        } as T;
      }
      if (name === "FinalizeAnswer") {
        finalized.push(input as Record<string, unknown>);
        return {
          accepted: true,
          payload: input,
        } as T;
      }
      throw new Error(`Unexpected tool call '${name}'`);
    },
    async preRun(): Promise<void> {
      // no-op
    },
  };

  const modelGateway = new RetryingModelGateway(async <T>(request: ModelRequest) => {
    const schemaName = request.providerOptions?.openrouter?.responseSchemaName;

    if (schemaName === "kestrel_agent_action" || request.tools !== undefined) {
      if (toolCalls.some((entry) => entry.name === "free.weather.current")) {
        return modelResponse({
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "Cincinnati is 12C with light wind around 6 kph.",
          },
          reason: "The agent loop state says the weather tool evidence is ready, so this finalizes the tool-backed answer.",
        }) as T;
      }
      return modelResponse({
        nextAction: {
          kind: "tool",
          name: "free.weather.current",
          input: {
            city: "Cincinnati, OH",
          },
        },
        reason: "This gathers current weather evidence for Cincinnati before answering.",
      }) as T;
    }

    throw new Error(`Unexpected model schema '${schemaName ?? "unknown"}'`);
  });

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway,
  });

  const registration = registerAgentReferenceRuntime(kestrel, {
    thinkerToolsProvider: () => [
      {
        name: "free.weather.current",
        description: "Current weather",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ],
    capabilityManifestProvider: () => [
      {
        name: "free.weather.current",
        description: "Current weather",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["weather.current"],
      },
    ],
  });

  const output = await kestrel.run({
    id: "evt-weather-1",
    type: "user.message",
    sessionId: "session-weather-1",
    payload: {
      message: "whats the weather in cincy",
      modeSystemV2Enabled: true,
      interactionMode: "build",
      actSubmode: "safe",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(output.status, "COMPLETED", JSON.stringify(output.errors));
  assert.equal(toolCalls.some((entry) => entry.name === "free.weather.current"), true);
  assert.deepEqual(toolCalls.find((entry) => entry.name === "free.weather.current")?.input, {
    city: "Cincinnati, OH",
  });
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.message, "Cincinnati is 12C with light wind around 6 kph.");

  const runEvents = store.getRunEvents();
  assert.equal(
    runEvents.some(
      (event) => event.type === "tool.queue.enqueued" && event.metadata?.tool === "free.weather.current",
    ),
    true,
  );
  assert.equal(
    runEvents.some(
      (event) =>
        event.type === "progress.tool" &&
        (event.metadata?.tool as { name?: string } | undefined)?.name === "free.weather.current",
    ),
    true,
  );
});

test("reference harness uses free.time.current for 'what time is it in utc'", async () => {
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-time-1",
    message: "what time is it in utc",
    extractorObjective: "Get the current time in UTC",
    toolName: "free.time.current",
    toolInputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string" },
      },
      additionalProperties: false,
    },
    capabilityClasses: ["time.current"],
    toolResult: {
      source: "test-time",
      timezone: "Etc/UTC",
      datetime: "2026-03-12T13:24:00.000Z",
    },
    expectedToolInput: {
      timezone: "Etc/UTC",
    },
    expectedLoopEvidence: "Etc/UTC",
    finalMessage: "UTC time is 2026-03-12T13:24:00.000Z.",
  });

  assert.equal(result.finalized[0]?.message, "UTC time is 2026-03-12T13:24:00.000Z.");
  assert.equal(
    result.runEvents.some((event) => event.type === "tool.queue.enqueued" && event.metadata?.tool === "free.time.current"),
    true,
  );
});

test("reference harness prompts for mode change when chat mode blocks read-only tooling", async () => {
  const store = new InMemorySessionStore();
  const modelGateway = new RetryingModelGateway(async <T>(request: ModelRequest) => {
    const schemaName = request.providerOptions?.openrouter?.responseSchemaName;
    if (schemaName === "kestrel_agent_action" || request.tools !== undefined) {
      return modelResponse({
        nextAction: {
          kind: "ask_user",
          prompt: "Switch to Build so I can use the available weather tool?",
          waitFor: {
            kind: "user",
            eventType: "user.reply",
            metadata: {
              reason: "mode_blocks_tooling",
            },
          },
        },
        reason: "Chat mode blocks the tool-backed answer, so this asks for permission to continue in an acting mode.",
      }) as T;
    }
    throw new Error(`Unexpected model schema '${schemaName ?? "unknown"}'`);
  });

  const kestrel = new Kestrel({
    store,
    modelGateway,
    toolGateway: {
      async call() {
        throw new Error("chat-mode block should not call tools");
      },
      async preRun() {
        // no-op
      },
    },
  });

  const registration = registerAgentReferenceRuntime(kestrel, {
    thinkerToolsProvider: () => [],
    capabilityManifestProvider: () => [
      {
        name: "free.weather.current",
        description: "Current weather",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["weather.current"],
      },
    ],
  });

  const output = await kestrel.run({
    id: "evt-chat-blocked",
    type: "user.message",
    sessionId: "session-chat-blocked",
    payload: {
      message: "whats the weather in cincy",
      modeSystemV2Enabled: true,
      interactionMode: "chat",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.waitFor?.eventType, "user.reply");
});

test("reference harness routes default plan-mode weather asks into tooling route", async () => {
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-weather-plan-1",
    message: "ayy whats the weather in cincy",
    extractorObjective: "Get the current weather for Cincinnati",
    toolName: "free.weather.current",
    toolInputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    },
    capabilityClasses: ["weather.current"],
    toolResult: {
      source: "test-weather",
      temperatureC: 12,
      windSpeedKph: 6,
    },
    expectedToolInput: {
      city: "Cincinnati, OH",
    },
    expectedLoopEvidence: "temperatureC",
    finalMessage: "Cincinnati is 12C with light wind around 6 kph.",
    interactionMode: "plan",
    expectedExecutionLane: "tooling",
  });

  assert.equal(result.toolCalls.some((entry) => entry.name === "free.weather.current"), true);
});

test("reference harness uses free.exchange.rate for 'usd to eur exchange rate'", async () => {
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-fx-1",
    message: "usd to eur exchange rate",
    extractorObjective: "Get the exchange rate from USD to EUR",
    toolName: "free.exchange.rate",
    toolInputSchema: {
      type: "object",
      properties: {
        base: { type: "string" },
        quote: { type: "string" },
      },
      additionalProperties: false,
    },
    capabilityClasses: ["finance.fx_rate"],
    toolResult: {
      source: "test-fx",
      base: "USD",
      quote: "EUR",
      rate: 0.92,
    },
    expectedToolInput: {
      base: "USD",
      quote: "EUR",
    },
    expectedLoopEvidence: "0.92",
    finalMessage: "USD/EUR is 0.92.",
  });

  assert.equal(result.finalized[0]?.message, "USD/EUR is 0.92.");
  assert.equal(
    result.toolCalls.some((entry) => entry.name === "free.exchange.rate"),
    true,
  );
});

test("reference harness uses internet.search for direct research intent", async () => {
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-search-1",
    message: "search wikipedia for Ada Lovelace",
    extractorObjective: "Search Wikipedia for Ada Lovelace",
    toolName: "internet.search",
    toolInputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        freshness: { type: "string" },
        domainAllow: {
          type: "array",
          items: { type: "string" },
        },
        domainDeny: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    capabilityClasses: ["web.search"],
    toolResult: {
      source: "wikipedia.title_search",
      query: "Search Wikipedia for Ada Lovelace",
      results: [
        {
          title: "Ada Lovelace",
          url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        },
      ],
    },
    expectedToolInput: {
      query: "Search Wikipedia for Ada Lovelace",
    },
    expectedLoopEvidence: "Ada Lovelace",
    finalMessage: "Top result: Ada Lovelace - https://en.wikipedia.org/wiki/Ada_Lovelace",
  });

  assert.equal(
    result.runEvents.some(
      (event) => event.type === "tool.queue.enqueued" && event.metadata?.tool === "internet.search",
    ),
    true,
  );
});

async function runReferenceRecoveryScenario(input: {
  sessionId: string;
  message: string;
  extractorObjective: string;
  toolName: string;
  toolInputSchema: Record<string, unknown>;
  capabilityClasses: string[];
  toolResult: Record<string, unknown>;
  expectedToolInput: Record<string, unknown>;
  expectedLoopEvidence: string;
  finalMessage: string;
  interactionMode?: "plan" | "build";
  expectedExecutionLane?: "chat" | "tooling";
}): Promise<{
  toolCalls: Array<{ name: string; input: unknown }>;
  finalized: Record<string, unknown>[];
  runEvents: ReturnType<InMemorySessionStore["getRunEvents"]>;
}> {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];

  const toolGateway: ToolGateway = {
    async call<T>(name: string, payload: unknown): Promise<T> {
      toolCalls.push({ name, input: payload });
      if (name === input.toolName) {
        return input.toolResult as T;
      }
      if (name === "FinalizeAnswer") {
        finalized.push(payload as Record<string, unknown>);
        return {
          accepted: true,
          payload,
        } as T;
      }
      throw new Error(`Unexpected tool call '${name}'`);
    },
    async preRun(): Promise<void> {
      // no-op
    },
  };

  const modelGateway = new RetryingModelGateway(async <T>(request: ModelRequest) => {
    const schemaName = request.providerOptions?.openrouter?.responseSchemaName;

    if (schemaName === "kestrel_agent_action" || request.tools !== undefined) {
      if (toolCalls.some((entry) => entry.name === input.toolName)) {
        return modelResponse({
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: input.finalMessage,
          },
          reason: "The agent loop state says the tool evidence is ready, so this finalizes the tool-backed answer.",
        }) as T;
      }
      return modelResponse({
        nextAction: {
          kind: "tool",
          name: input.toolName,
          input: input.expectedToolInput,
        },
        reason: `This gathers ${input.toolName} evidence before answering.`,
      }) as T;
    }

    throw new Error(`Unexpected model schema '${schemaName ?? "unknown"}'`);
  });

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway,
  });

  const registration = registerAgentReferenceRuntime(kestrel, {
    thinkerToolsProvider: () => [
      {
        name: input.toolName,
        description: input.toolName,
        inputSchema: input.toolInputSchema,
      },
    ],
    capabilityManifestProvider: () => [
      {
        name: input.toolName,
        description: input.toolName,
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: [...input.capabilityClasses],
      },
    ],
  });

  const output = await kestrel.run({
    id: `evt-${input.sessionId}`,
    type: "user.message",
    sessionId: input.sessionId,
    payload: {
      message: input.message,
      modeSystemV2Enabled: true,
      interactionMode: input.interactionMode ?? "build",
      actSubmode: "safe",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(output.status, "COMPLETED", JSON.stringify(output.errors));
  assert.deepEqual(toolCalls.find((entry) => entry.name === input.toolName)?.input, input.expectedToolInput);
  assert.equal(finalized.length, 1);
  assert.equal(input.expectedExecutionLane === undefined || input.expectedExecutionLane === "tooling", true);

  return {
    toolCalls,
    finalized,
    runEvents: store.getRunEvents(),
  };
}
