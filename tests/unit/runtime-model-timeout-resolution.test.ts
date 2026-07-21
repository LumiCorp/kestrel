import assert from "node:assert/strict";

import {
  resolveModelRetryCount,
  resolveModelTimeoutMs,
} from "../../cli/runtime/KestrelChatRuntime.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "resolveModelTimeoutMs prefers profile override over env", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: 45_000 },
    { KCHAT_MODEL_TIMEOUT_MS: "12000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 45_000);
});

contractTest("runtime.hermetic", "resolveModelTimeoutMs uses env value when profile override is unset", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: undefined },
    { KCHAT_MODEL_TIMEOUT_MS: "12000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 12_000);
});

contractTest("runtime.hermetic", "resolveModelTimeoutMs ignores invalid profile override and falls back to env", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: 0 },
    { KCHAT_MODEL_TIMEOUT_MS: "9000" } as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 9000);
});

contractTest("runtime.hermetic", "resolveModelTimeoutMs defaults local OpenAI-compatible providers to a tighter timeout", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "ollama", modelTimeoutMs: undefined },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, 45_000);
});

contractTest("runtime.hermetic", "resolveModelTimeoutMs leaves hosted providers unchanged when profile and env are unset", () => {
  const timeout = resolveModelTimeoutMs(
    { modelProvider: "openrouter", modelTimeoutMs: undefined },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(timeout, undefined);
});

contractTest("runtime.hermetic", "resolveModelRetryCount prefers env override", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "ollama" },
    { KCHAT_MODEL_RETRY_COUNT: "2" } as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, 2);
});

contractTest("runtime.hermetic", "resolveModelRetryCount defaults local OpenAI-compatible providers to zero retries", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "lmstudio" },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, 0);
});

contractTest("runtime.hermetic", "resolveModelRetryCount leaves hosted providers unchanged when env is unset", () => {
  const retryCount = resolveModelRetryCount(
    { modelProvider: "openai" },
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(retryCount, undefined);
});
