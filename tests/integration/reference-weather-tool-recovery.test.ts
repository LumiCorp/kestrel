import assert from "node:assert/strict";

import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import { weatherForecastTool } from "../../tools/free/weatherForecast.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


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
    return name !== undefined
      ? [{
          name: name.replace(/[^A-Za-z0-9_]/gu, "_"),
          input: {
            ...input,
            assistantProgress: `I am using ${name} to continue the requested work.`,
          },
        }]
      : [];
  }
  if (kind === "finalize") {
    return [{
      name: "kestrel_finalize",
      input: {
        status: typeof record?.status === "string" ? record.status : "goal_satisfied",
        message: typeof record?.message === "string" ? record.message : "Done.",
        assistantProgress: "I have completed the requested work.",
      },
    }];
  }
  if (kind === "ask_user") {
    return [{
      name: "kestrel_ask_user",
      input: {
        prompt: typeof record?.prompt === "string" ? record.prompt : "Please clarify.",
        assistantProgress: "I need one detail from you before I can continue.",
      },
    }];
  }
  return [];
}

contractTest("runtime.process", "reference harness uses free.weather.current for 'whats the weather in cincy'", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "free.weather.current") {
        return buildAgentToolSuccessResult({ toolName: name, input, output: {
          source: "test-weather",
          temperatureC: 12,
          apparentTemperatureC: 11,
          humidityPct: 55,
          windSpeedKph: 6,
          observedAt: "2026-03-12T13:24:00.000Z",
        } }) as T;
      }
      if (name === "FinalizeAnswer") {
        finalized.push(input as Record<string, unknown>);
        return buildAgentToolSuccessResult({ toolName: name, input, output: {
          accepted: true,
          payload: input,
        } }) as T;
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

contractTest("runtime.process", "reference harness uses free.time.current for 'what time is it in utc'", async () => {
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

contractTest("runtime.process", "reference harness uses read-only tools directly in Chat mode", async () => {
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-weather-chat-1",
    message: "whats the weather in cincy",
    extractorObjective: "Get the current weather for Cincinnati",
    toolName: "free.weather.current",
    toolInputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    capabilityClasses: ["weather.current"],
    toolResult: { source: "test-weather", temperatureC: 12 },
    expectedToolInput: { city: "Cincinnati, OH" },
    expectedLoopEvidence: "temperatureC",
    finalMessage: "Cincinnati is 12C.",
    interactionMode: "chat",
    expectedExecutionLane: "tooling",
  });

  assert.equal(result.toolCalls.some((entry) => entry.name === "free.weather.current"), true);
  assert.equal(result.finalized[0]?.message, "Cincinnati is 12C.");
});

contractTest("runtime.process", "reference harness routes default plan-mode weather asks into tooling route", async () => {
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

contractTest("runtime.process", "reference harness answers Cincinnati through Wednesday from one model-visible forecast", async () => {
  const forecastHandler = weatherForecastTool.createHandler({
    fetchImpl: async (url) => {
      const target = typeof url === "string" ? url : String(url);
      if (target.includes("geocoding-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            results: [{ latitude: 39.1031, longitude: -84.512 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const hourlyTimes = Array.from(
        { length: 24 },
        (_, hour) => `2026-07-12T${String(hour).padStart(2, "0")}:00`,
      );
      return new Response(
        JSON.stringify({
          timezone: "America/New_York",
          current: { time: "2026-07-12T15:45", temperature_2m: 27 },
          hourly: {
            time: hourlyTimes,
            temperature_2m: hourlyTimes.map((_, hour) => 20 + hour / 2),
            apparent_temperature: hourlyTimes.map((_, hour) => 21 + hour / 2),
            precipitation_probability: hourlyTimes.map((_, hour) => hour),
            precipitation: hourlyTimes.map(() => 0),
            wind_speed_10m: hourlyTimes.map(() => 9),
          },
          daily: {
            time: ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15"],
            temperature_2m_max: [30, 32, 33, 31],
            temperature_2m_min: [21, 22, 23, 21],
            precipitation_probability_max: [20, 30, 50, 40],
            precipitation_sum: [0, 0.5, 2.4, 1.2],
            wind_speed_10m_max: [9, 10, 14, 12],
            weather_code: [1, 2, 61, 80],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await runReferenceRecoveryScenario({
    sessionId: "session-weather-range-1",
    message: "whats the weather in cincinnati oh between now and wednesday",
    extractorObjective: "Get Cincinnati weather from now through Wednesday",
    toolName: "free.weather.forecast",
    toolInputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        days: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["city", "days"],
      additionalProperties: false,
    },
    capabilityClasses: ["weather.forecast"],
    toolResult: async (toolInput) =>
      await forecastHandler(toolInput) as Record<string, unknown>,
    expectedToolInput: {
      city: "Cincinnati, OH",
      days: 4,
    },
    expectedLoopEvidence: [
      "time=2026-07-12T15:00",
      "maxTemperatureC=31",
    ],
    finalMessage: "Cincinnati stays warm through Wednesday, with highs near 30-33C and the best rain chances Tuesday and Wednesday.",
  });

  assert.deepEqual(
    result.toolCalls.map((entry) => entry.name),
    ["free.weather.forecast", "FinalizeAnswer"],
  );
});

contractTest("runtime.process", "reference harness uses free.exchange.rate for 'usd to eur exchange rate'", async () => {
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

contractTest("runtime.process", "reference harness uses internet.search for direct research intent", async () => {
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
  toolResult:
    | Record<string, unknown>
    | ((toolInput: unknown) => Promise<Record<string, unknown>>);
  expectedToolInput: Record<string, unknown>;
  expectedLoopEvidence: string | string[];
  finalMessage: string;
  interactionMode?: "chat" | "plan" | "build";
  expectedExecutionLane?: "chat" | "tooling";
}): Promise<{
  toolCalls: Array<{ name: string; input: unknown }>;
  finalized: Record<string, unknown>[];
  runEvents: ReturnType<InMemorySessionStore["getRunEvents"]>;
}> {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];
  let observedLoopEvidence = false;

  const toolGateway: ToolGateway = {
    async call<T>(name: string, payload: unknown): Promise<T> {
      toolCalls.push({ name, input: payload });
      if (name === input.toolName) {
        const toolResult = typeof input.toolResult === "function"
          ? await input.toolResult(payload)
          : input.toolResult;
        return buildAgentToolSuccessResult({
          toolName: name,
          input: payload,
          output: toolResult,
        }) as T;
      }
      if (name === "FinalizeAnswer") {
        finalized.push(payload as Record<string, unknown>);
        return buildAgentToolSuccessResult({ toolName: name, input: payload, output: {
          accepted: true,
          payload,
        } }) as T;
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
        const modelVisibleRequest = JSON.stringify({
          input: request.input,
          messages: request.messages,
        });
        const expectedLoopEvidence = Array.isArray(input.expectedLoopEvidence)
          ? input.expectedLoopEvidence
          : [input.expectedLoopEvidence];
        observedLoopEvidence = expectedLoopEvidence.every((evidence) =>
          modelVisibleRequest.includes(evidence)
        );
        assert.equal(
          observedLoopEvidence,
          true,
          `Expected next model request to include tool evidence '${expectedLoopEvidence.join("', '")}'.`,
        );
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
  assert.equal(observedLoopEvidence, true);
  assert.equal(input.expectedExecutionLane === undefined || input.expectedExecutionLane === "tooling", true);

  return {
    toolCalls,
    finalized,
    runEvents: store.getRunEvents(),
  };
}
