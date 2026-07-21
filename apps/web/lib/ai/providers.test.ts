import assert from "node:assert/strict";
import { resolveLanguageModelTransport } from "./model-transport";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "tool-loop calls use chat transport for openrouter", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openrouter",
      usage: "tool-loop",
    }),
    "chat"
  );
});

contractTest("web.hermetic", "default calls keep responses transport for openrouter", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openrouter",
      usage: "default",
    }),
    "responses"
  );
});

contractTest("web.hermetic", "tool-loop calls keep responses transport for openai", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openai",
      usage: "tool-loop",
    }),
    "responses"
  );
});
