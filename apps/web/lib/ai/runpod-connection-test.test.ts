import assert from "node:assert/strict";
import test from "node:test";
import {
  getRunPodValidationEvidence,
  preserveTrustedRunPodValidation,
  RUNPOD_VALIDATION_METADATA_KEY,
  validateRunPodToolRoundTrip,
} from "./runpod-connection-test";

function eventStream(events: unknown[]) {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
}

test("RunPod validation proves streaming and a complete tool-result round trip", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const evidence = await validateRunPodToolRoundTrip({
    apiKey: "runpod-secret",
    baseUrl: "https://api.runpod.ai/v2/endpoint_1/openai/v1",
    model: "Qwen/Qwen3-32B",
    now: new Date("2026-07-12T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer runpod-secret"
      );
      const messages = body.messages as Array<Record<string, unknown>>;
      const tokenMatch = /kestrel-[a-f0-9-]+/u.exec(
        String(messages[0]?.content)
      );
      assert.ok(tokenMatch);
      const token = tokenMatch[0];
      if (requests.length === 1) {
        return eventStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_",
                      function: {
                        name: "kestrel_connection_",
                        arguments: `{"token":"${token.slice(0, 10)}`,
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "probe",
                      function: {
                        name: "probe",
                        arguments: `${token.slice(10)}"}`,
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]);
      }
      assert.equal(
        messages.some((message) => message.role === "tool"),
        true
      );
      return eventStream([
        { choices: [{ delta: { content: token.slice(0, 12) } }] },
        { choices: [{ delta: { content: token.slice(12) } }] },
      ]);
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body.temperature, 0);
  assert.equal(requests[0]?.body.seed, 0);
  assert.equal(requests[1]?.body.temperature, 0);
  assert.equal(requests[1]?.body.seed, 0);
  assert.equal(
    requests[0]?.url,
    "https://api.runpod.ai/v2/endpoint_1/openai/v1/chat/completions"
  );
  assert.deepEqual(evidence, {
    version: "runpod-tool-round-trip-v2",
    streaming: true,
    toolRoundTrip: true,
    rawModelId: "Qwen/Qwen3-32B",
    baseUrl: "https://api.runpod.ai/v2/endpoint_1/openai/v1",
    validatedAt: "2026-07-12T12:00:00.000Z",
  });
});

test("RunPod validation rejects a non-streaming provider response safely", async () => {
  await assert.rejects(
    validateRunPodToolRoundTrip({
      apiKey: "secret-not-in-error",
      baseUrl: "https://api.runpod.ai/v2/endpoint/openai/v1",
      model: "model",
      fetchImpl: async () => Response.json({ choices: [] }),
    }),
    (error: unknown) => {
      assert.equal(String(error).includes("secret-not-in-error"), false);
      assert.equal(
        (error as { code?: string }).code,
        "RUNPOD_STREAMING_UNSUPPORTED"
      );
      return true;
    }
  );
});

test("RunPod validation explains missing OpenAI routes without assuming the cause", async () => {
  await assert.rejects(
    validateRunPodToolRoundTrip({
      apiKey: "secret-not-in-error",
      baseUrl: "https://api.runpod.ai/v2/endpoint/openai/v1",
      model: "model",
      fetchImpl: async () => new Response(null, { status: 404 }),
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "RUNPOD_OPENAI_CHAT_UNAVAILABLE"
      );
      assert.match(String(error), /Confirm the endpoint ID and template/u);
      assert.match(String(error), /queue-only \/run and \/runsync/u);
      assert.equal(String(error).includes("secret-not-in-error"), false);
      return true;
    }
  );
});

test("RunPod validation classifies cold starts and provider throttling as retryable", async () => {
  await assert.rejects(
    validateRunPodToolRoundTrip({
      apiKey: "secret",
      baseUrl: "https://api.runpod.ai/v2/endpoint/openai/v1",
      model: "model",
      fetchImpl: async () => {
        throw new Error("cold start");
      },
    }),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, true);
      assert.equal((error as { status?: number | null }).status, null);
      return true;
    }
  );
  await assert.rejects(
    validateRunPodToolRoundTrip({
      apiKey: "secret",
      baseUrl: "https://api.runpod.ai/v2/endpoint/openai/v1",
      model: "model",
      fetchImpl: async () => new Response(null, { status: 429 }),
    }),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, true);
      assert.equal((error as { status?: number | null }).status, 429);
      return true;
    }
  );
});

test("RunPod validation retries an interrupted event stream", async () => {
  await assert.rejects(
    validateRunPodToolRoundTrip({
      apiKey: "secret",
      baseUrl: "https://api.runpod.ai/v2/endpoint/openai/v1",
      model: "model",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream interrupted"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "RUNPOD_STREAM_INTERRUPTED"
      );
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    }
  );
});

test("client metadata cannot forge RunPod validation evidence", () => {
  const forged = {
    [RUNPOD_VALIDATION_METADATA_KEY]: {
      version: "runpod-tool-round-trip-v2",
      streaming: true,
      toolRoundTrip: true,
      rawModelId: "forged-model",
      baseUrl: "https://api.runpod.ai/v2/forged/openai/v1",
      validatedAt: "2026-07-12T12:00:00.000Z",
    },
    providerField: "preserved",
  };
  const sanitized = preserveTrustedRunPodValidation({
    incomingMetadata: forged,
    storedMetadata: null,
    storedRawModelId: "",
    storedModality: "",
    nextRawModelId: "Qwen/Qwen3-32B",
    nextModality: "language",
    baseUrl: "https://api.runpod.ai/v2/endpoint_1/openai/v1",
  });
  assert.equal(getRunPodValidationEvidence(sanitized), null);
  assert.equal(sanitized.providerField, "preserved");
});

test("trusted RunPod validation is preserved only for the same model and endpoint", () => {
  const baseUrl = "https://api.runpod.ai/v2/endpoint_1/openai/v1";
  const storedMetadata = {
    [RUNPOD_VALIDATION_METADATA_KEY]: {
      version: "runpod-tool-round-trip-v2",
      streaming: true,
      toolRoundTrip: true,
      rawModelId: "Qwen/Qwen3-32B",
      baseUrl,
      validatedAt: "2026-07-12T12:00:00.000Z",
    },
  };
  const preserve = (
    overrides: Partial<{
      nextRawModelId: string;
      nextModality: string;
      baseUrl: string;
    }> = {}
  ) =>
    preserveTrustedRunPodValidation({
      incomingMetadata: { providerField: "preserved" },
      storedMetadata,
      storedRawModelId: "Qwen/Qwen3-32B",
      storedModality: "language",
      nextRawModelId: overrides.nextRawModelId ?? "Qwen/Qwen3-32B",
      nextModality: overrides.nextModality ?? "language",
      baseUrl: overrides.baseUrl ?? baseUrl,
    });

  assert.ok(getRunPodValidationEvidence(preserve()));
  assert.equal(
    getRunPodValidationEvidence(preserve({ nextRawModelId: "other-model" })),
    null
  );
  assert.equal(
    getRunPodValidationEvidence(preserve({ nextModality: "embedding" })),
    null
  );
  assert.equal(
    getRunPodValidationEvidence(
      preserve({
        baseUrl: "https://api.runpod.ai/v2/other-endpoint/openai/v1",
      })
    ),
    null
  );
});
