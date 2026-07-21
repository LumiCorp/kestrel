import assert from "node:assert/strict";
import { tool } from "ai";
import { z } from "zod";
import { resolveWeatherToolSettings } from "@/lib/ai/tools/get-weather";
import { applyToolRuntimeConfigurations } from "./runtime-config";
import { resolveSearchKnowledgeDocumentsToolSettings } from "./settings";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "runtime configuration enables approval for ask tools and omits unknown tools", () => {
  const configured = applyToolRuntimeConfigurations(
    {
      getWeather: tool({
        description: "weather",
        inputSchema: z.object({ city: z.string() }),
        execute: async () => ({ ok: true }),
      }),
      searchKnowledgeDocuments: tool({
        description: "search",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ ok: true }),
      }),
    },
    {
      getWeather: {
        providerKey: "built_in.weather",
        capabilityKey: "getWeather",
        runtimeName: "getWeather",
        approvalMode: "ask",
        rateLimitMode: "default",
        loggingMode: "full",
        settings: {},
      },
    }
  );

  assert.equal(Object.keys(configured).length, 1);
  assert.equal("getWeather" in configured, true);
  assert.equal(configured.getWeather.needsApproval, true);
});

contractTest("web.hermetic", "weather settings resolver clamps and normalizes persisted values", () => {
  assert.deepEqual(
    resolveWeatherToolSettings({
      units: "celsius",
      timeoutMs: 3200.2,
      retryCount: -5,
    }),
    {
      units: "celsius",
      timeoutMs: 3200,
      retryCount: 0,
    }
  );
});

contractTest("web.hermetic", "knowledge search settings resolver clamps default result limits", () => {
  assert.deepEqual(
    resolveSearchKnowledgeDocumentsToolSettings({ defaultLimit: 99 }),
    { defaultLimit: 12 }
  );
});
