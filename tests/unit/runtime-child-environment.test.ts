import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeChildEnvironment } from "../../src/runtimes/RuntimeChildEnvironment.js";

test("foreign Runtime child environments expose only approved provider variables", () => {
  const base = {
    PATH: "/bin",
    DATABASE_URL: "postgres://secret",
    KESTREL_SIGNING_KEY: "signing-secret",
    OPENAI_API_KEY: "host-openai-secret",
    ANTHROPIC_API_KEY: "host-anthropic-secret",
  };
  const codex = buildRuntimeChildEnvironment({
    runtimeId: "codex",
    baseEnvironment: base,
    runtimeEnvironment: {
      OPENAI_API_KEY: "leased-openai-key",
      OPENAI_BASE_URL: "https://gateway.example/v1",
      ANTHROPIC_API_KEY: "wrong-provider-key",
    },
    configurationDirectory: "/isolated/codex",
  });
  assert.deepEqual(codex, {
    PATH: "/bin",
    OPENAI_API_KEY: "leased-openai-key",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    CODEX_HOME: "/isolated/codex",
  });
  assert.equal(base.OPENAI_API_KEY, "host-openai-secret");
});
