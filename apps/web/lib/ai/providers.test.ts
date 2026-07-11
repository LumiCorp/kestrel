import assert from "node:assert/strict";
import test from "node:test";
import { resolveLanguageModelTransport } from "./model-transport";

test("tool-loop calls use chat transport for openrouter", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openrouter",
      usage: "tool-loop",
    }),
    "chat"
  );
});

test("default calls keep responses transport for openrouter", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openrouter",
      usage: "default",
    }),
    "responses"
  );
});

test("tool-loop calls keep responses transport for openai", () => {
  assert.equal(
    resolveLanguageModelTransport({
      provider: "openai",
      usage: "tool-loop",
    }),
    "responses"
  );
});
