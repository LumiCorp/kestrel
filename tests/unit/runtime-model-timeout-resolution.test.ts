import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveModelRetryCount,
  resolveModelTimeoutMs,
} from "../../cli/runtime/KestrelChatRuntime.js";

test("resolveModelTimeoutMs prefers profile override over env", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: 45_000 },
    { KCHAT_MODEL_TIMEOUT_MS: "12000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 45_000);
});

test("resolveModelTimeoutMs uses env value when profile override is unset", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: undefined },
    { KCHAT_MODEL_TIMEOUT_MS: "12000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 12_000);
});

test("resolveModelTimeoutMs ignores invalid profile override and falls back to env", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: 0 },
    { KCHAT_MODEL_TIMEOUT_MS: "9000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 9000);
});

test("resolveModelTimeoutMs defaults local OpenAI-compatible providers to a tighter timeout", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: undefined },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 45_000);
});

test("resolveModelTimeoutMs leaves hosted providers unchanged when profile and env are unset", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "openrouter", modelTimeoutMs: undefined },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, undefined);
});

test("resolveModelRetryCount prefers env override", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "ollama" },
    { KCHAT_MODEL_RETRY_COUNT: "2" } as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, 2);
});

test("resolveModelRetryCount defaults local OpenAI-compatible providers to zero retries", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "lmstudio" },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, 0);
});

test("resolveModelRetryCount leaves hosted providers unchanged when env is unset", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "openai" },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, undefined);
});
