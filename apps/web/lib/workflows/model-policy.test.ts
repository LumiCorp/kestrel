import assert from "node:assert/strict";
import test from "node:test";
import { isWorkflowModelSupported } from "./model-policy";

test("workflow model policy accepts supported gateway and desktop models", () => {
  assert.equal(
    isWorkflowModelSupported({ provider: "openai", rawModelId: "gpt-5.6" }),
    true,
  );
  assert.equal(
    isWorkflowModelSupported({ provider: "ollama", rawModelId: "qwen3:32b" }),
    true,
  );
});

test("workflow model policy rejects every admitted GLM 5.2 identity", () => {
  for (const identity of [
    { provider: "openrouter", rawModelId: "z-ai/glm-5.2" },
    { provider: "openrouter", rawModelId: "z-ai/glm-5.2:free" },
    { provider: "openrouter", rawModelId: "z-ai/glm-5.2-20260616" },
    { provider: "ollama", rawModelId: "glm-5.2" },
  ]) {
    assert.equal(isWorkflowModelSupported(identity), false, identity.rawModelId);
  }
});
