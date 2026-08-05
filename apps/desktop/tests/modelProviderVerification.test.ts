import test from "node:test";
import assert from "node:assert/strict";

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

  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/key");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer openrouter-key");
  assert.equal(requests[1]?.url, "https://openrouter.ai/api/v1/models");
  assert.equal(requests[2]?.url, "https://example.test/openai/v1/models");
  assert.equal(requests[2]?.headers.get("openai-organization"), "org-example");
  assert.equal(requests[2]?.headers.get("openai-project"), "project-example");
  assert.equal(requests[3]?.url, "https://example.test/anthropic/v1/models");
  assert.equal(requests[3]?.headers.get("x-api-key"), "anthropic-key");
  assert.equal(requests[3]?.headers.get("anthropic-version"), "2025-01-01");
});

test("OpenRouter authentication cannot be satisfied by its public model catalog", async () => {
  await assert.rejects(
    verifyDesktopModelCapability({
      provider: "openrouter",
      apiKey: "invalid-openrouter-key",
      settings: {
        ...createDefaultDesktopSettings(),
        openrouterModel: "provider/model",
      },
      fetchImpl: async (input) =>
        String(input).endsWith("/api/v1/key")
          ? new Response("unauthorized", { status: 401 })
          : new Response(
              JSON.stringify({ data: [{ id: "provider/model" }] }),
              { status: 200 },
            ),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopModelProviderVerificationError);
      assert.equal(error.kind, "invalid_credential");
      return true;
    },
  );
});

test("OpenRouter authentication succeeds before model availability is checked", async () => {
  const requests: string[] = [];
  await assert.rejects(
    verifyDesktopModelCapability({
      provider: "openrouter",
      apiKey: "valid-openrouter-key",
      settings: {
        ...createDefaultDesktopSettings(),
        openrouterModel: "provider/missing-model",
      },
      fetchImpl: async (input) => {
        requests.push(String(input));
        return String(input).endsWith("/api/v1/key")
          ? new Response(JSON.stringify({ data: { label: "ignored" } }), {
              status: 200,
            })
          : new Response(
              JSON.stringify({ data: [{ id: "provider/available-model" }] }),
              { status: 200 },
            );
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopModelProviderVerificationError);
      assert.equal(error.kind, "model_unavailable");
      return true;
    },
  );
  assert.deepEqual(requests, [
    "https://openrouter.ai/api/v1/key",
    "https://openrouter.ai/api/v1/models",
  ]);
});

test("provider verification preserves rejection, timeout, and unreachable failure kinds", async () => {
  const settings = createDefaultDesktopSettings();
  const cases: Array<{
    expected: DesktopModelProviderVerificationError["kind"];
    fetchImpl: typeof fetch;
    timeoutMs?: number | undefined;
  }> = [
    {
      expected: "provider_rejected",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    },
    {
      expected: "timeout",
      timeoutMs: 1,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    },
    {
      expected: "unreachable",
      fetchImpl: async () => {
        throw new TypeError("connection refused");
      },
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      verifyDesktopModelProviderCredential({
        provider: "openai",
        apiKey: "write-only-key",
        settings,
        fetchImpl: entry.fetchImpl,
        ...(entry.timeoutMs !== undefined
          ? { timeoutMs: entry.timeoutMs }
          : {}),
      }),
      (error: unknown) => {
        assert.ok(error instanceof DesktopModelProviderVerificationError);
        assert.equal(error.kind, entry.expected);
        return true;
      },
    );
  }
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

test("hosted model verification confirms the chosen model without inference", async () => {
  const methods: string[] = [];
  await verifyDesktopModelCapability({
    provider: "openai",
    apiKey: "openai-key",
    settings: {
      ...createDefaultDesktopSettings(),
      openaiModel: "gpt-5",
    },
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), {
        status: 200,
      });
    },
  });
  assert.deepEqual(methods, ["GET"]);
});

test("hosted model verification rejects a model missing from the catalog", async () => {
  await assert.rejects(
    verifyDesktopModelCapability({
      provider: "anthropic",
      apiKey: "anthropic-key",
      settings: {
        ...createDefaultDesktopSettings(),
        anthropicModel: "missing-model",
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-available" }] }), {
          status: 200,
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopModelProviderVerificationError);
      assert.equal(error.kind, "model_unavailable");
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
