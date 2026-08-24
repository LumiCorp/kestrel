import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPENROUTER_MODEL,
  loadOpenRouterEnv,
} from "../../models/openrouter/OpenRouterEnv.js";

test("OpenRouter env defaults to GPT-5.6 Luna", () => {
  const config = loadOpenRouterEnv({ OPENROUTER_API_KEY: "test-key" });

  assert.equal(DEFAULT_OPENROUTER_MODEL, "openai/gpt-5.6-luna");
  assert.equal(config.model, DEFAULT_OPENROUTER_MODEL);
});

test("OpenRouter env preserves an explicit model override", () => {
  const config = loadOpenRouterEnv({
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "custom/model",
  });

  assert.equal(config.model, "custom/model");
});
