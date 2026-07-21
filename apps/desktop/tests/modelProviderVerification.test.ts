import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopModelProviderVerificationError,
  verifyDesktopModelCapability,
  verifyDesktopModelProviderCredential,
} from "../src/modelProviderVerification.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";

test("model credential verification uses provider-specific endpoints and headers", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const settings = {
    ...createDefaultDesktopSettings(),
    openaiBaseUrl: "https://example.test/openai/v1/",
    openaiOrgId: "org-example",
    openaiProjectId: "project-example",
    anthropicBaseUrl: "https://example.test/anthropic",
    anthropicVersion: "2025-01-01",
  };

  await verifyDesktopModelProviderCredential({ provider: "openrouter", apiKey: "openrouter-key", settings, fetchImpl });
  await verifyDesktopModelProviderCredential({ provider: "openai", apiKey: "openai-key", settings, fetchImpl });
  await verifyDesktopModelProviderCredential({ provider: "anthropic", apiKey: "anthropic-key", settings, fetchImpl });

  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/models");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer openrouter-key");
  assert.equal(requests[1]?.url, "https://example.test/openai/v1/models");
  assert.equal(requests[1]?.headers.get("openai-organization"), "org-example");
  assert.equal(requests[1]?.headers.get("openai-project"), "project-example");
  assert.equal(requests[2]?.url, "https://example.test/anthropic/v1/models");
  assert.equal(requests[2]?.headers.get("x-api-key"), "anthropic-key");
  assert.equal(requests[2]?.headers.get("anthropic-version"), "2025-01-01");
});

test("local model verification confirms endpoint inventory", async () => {
  const settings = {
    ...createDefaultDesktopSettings(),
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "qwen3:8b",
  };
  let requestedUrl = "";
  await verifyDesktopModelCapability({
    provider: "ollama",
    settings,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), { status: 200 });
    },
  });
  assert.equal(requestedUrl, "http://localhost:11434/api/tags");
});

test("local model verification rejects unavailable configured model", async () => {
  await assert.rejects(
    verifyDesktopModelCapability({
      provider: "lmstudio",
      settings: {
        ...createDefaultDesktopSettings(),
        lmstudioModel: "missing-model",
      },
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "available-model" }] }), { status: 200 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopModelProviderVerificationError);
      assert.match(error.message, /missing-model.*not available/u);
      return true;
    },
  );
});

test("failed model credential verification reports no credential value", async () => {
  const secret = "secret-value-that-must-not-leak";
  await assert.rejects(
    verifyDesktopModelProviderCredential({
      provider: "openai",
      apiKey: secret,
      settings: createDefaultDesktopSettings(),
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopModelProviderVerificationError);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /HTTP 401/u);
      return true;
    },
  );
});
