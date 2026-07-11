import assert from "node:assert/strict";
import test from "node:test";
import { buildChatSystemPrompt } from "./prompts";

test("chat system prompt enforces tight prose and notes-style citations", () => {
  const prompt = buildChatSystemPrompt({
    config: {
      id: "cfg_1",
      name: "Default",
      responseStyle: "concise",
      language: "en",
      citationFormat: "footnote",
      defaultModel: null,
      maxStepsMultiplier: 1,
      temperature: 0.7,
      isActive: true,
      searchInstructions: null,
      additionalPrompt: null,
    },
    routerDecision: {
      complexity: "moderate",
      maxSteps: 4,
      model: "openai/gpt-5-mini",
      reasoning: "balanced",
    },
    sourceSummary:
      "No knowledge sources are configured for this organization yet.",
    retrievalStrategy: "Start with uploaded documents when relevant.",
  });

  assert.match(prompt, /Default to tight prose/i);
  assert.match(prompt, /final `Notes` section/i);
  assert.match(prompt, /Do not paste raw tool output/i);
  assert.match(prompt, /numbered Notes section/i);
});
