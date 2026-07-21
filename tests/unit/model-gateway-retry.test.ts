import assert from "node:assert/strict";

import { createOpenRouterHttpError } from "../../models/openrouter/OpenRouterErrors.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type { ModelGatewayCallOptions, ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "createOpenRouterHttpError preserves retry-after seconds for rate limits", () => {
  const error = createOpenRouterHttpError(
    429,
    JSON.stringify({
      error: {
        message: "Provider returned error",
      },
    }),
    {
      retryAfter: "7",
    },
  );

  assert.equal(error.code, "MODEL_RATE_LIMITED");
  assert.equal(error.status, 429);
  assert.equal(error.details?.retryAfterSeconds, 7);
});

contractTest("runtime.hermetic", "RetryingModelGateway honors retry-after hints on rate-limited model calls", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("rate limited") as Error & {
        code: string;
        status: number;
        details: Record<string, unknown>;
      };
      error.code = "MODEL_RATE_LIMITED";
      error.status = 429;
      error.details = {
        retryAfterSeconds: 0.25,
      };
      throw error;
    }
    return { ok: true } as T;
  }, {
    retryCount: 1,
  });

  const startedAt = Date.now();
  try {
    const result = await gateway.call<{ ok: true }>({
      input: { task: "retry-rate-limit-with-hint" },
      messages: [],
      responseFormat: "json",
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt >= 200, "expected retry-after wait before retry");
  } finally {
    Math.random = originalRandom;
  }
});

contractTest("runtime.hermetic", "RetryingModelGateway uses slower backoff for rate limits without retry-after hints", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("rate limited") as Error & {
        code: string;
        status: number;
      };
      error.code = "MODEL_RATE_LIMITED";
      error.status = 429;
      throw error;
    }
    return { ok: true } as T;
  }, {
    retryCount: 1,
  });

  const startedAt = Date.now();
  try {
    const result = await gateway.call<{ ok: true }>({
      input: { task: "retry-rate-limit-without-hint" },
      messages: [],
      responseFormat: "json",
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt >= 1550, "expected rate-limit backoff to exceed the old 250ms retry");
  } finally {
    Math.random = originalRandom;
  }
});

contractTest("runtime.hermetic", "RetryingModelGateway retries OpenRouter provider-wrapper bad responses", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    if (attempts === 1) {
      throw createOpenRouterHttpError(
        400,
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
          },
        }),
      );
    }
    return { ok: true } as T;
  }, {
    retryCount: 1,
  });

  try {
    const result = await gateway.call<{ ok: true }>({
      input: { task: "retry-provider-wrapper-bad-response" },
      messages: [],
      responseFormat: "json",
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
  } finally {
    Math.random = originalRandom;
  }
});

contractTest("runtime.hermetic", "RetryingModelGateway does not retry ordinary bad responses", async () => {
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    throw createOpenRouterHttpError(
      400,
      JSON.stringify({
        error: {
          message: "Invalid request body",
          code: 400,
        },
      }),
    ) as T;
  }, {
    retryCount: 1,
  });

  await assert.rejects(
    () => gateway.call({
      input: { task: "do-not-retry-ordinary-bad-response" },
      messages: [],
      responseFormat: "json",
    }),
    /Invalid request body/,
  );
  assert.equal(attempts, 1);
});

contractTest("runtime.hermetic", "RetryingModelGateway does not retry provider schema bad responses", async () => {
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    throw createOpenRouterHttpError(
      400,
      JSON.stringify({
        error: {
          message: "Provider returned error",
          metadata: {
            raw: JSON.stringify({
              error: {
                message: "tools.0.function.parameters must be a valid JSON Schema",
              },
            }),
          },
        },
      }),
    ) as T;
  }, {
    retryCount: 1,
  });

  await assert.rejects(
    () => gateway.call({
      input: { task: "do-not-retry-provider-schema" },
      messages: [],
      responseFormat: "json",
    }),
    /valid JSON Schema/,
  );
  assert.equal(attempts, 1);
});

contractTest("runtime.hermetic", "RetryingModelGateway annotates exhausted provider retries", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  let attempts = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    attempts += 1;
    throw createOpenRouterHttpError(
      502,
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 502,
        },
      }),
    ) as T;
  }, {
    retryCount: 2,
  });

  try {
    await assert.rejects(
      () => gateway.call({
        input: { task: "annotate-exhausted-provider-retries" },
        messages: [],
        responseFormat: "json",
      }),
      (error: unknown) => {
        const record = error as {
          details?: Record<string, unknown>;
        };
        assert.equal(attempts, 3);
        assert.equal(record.details?.gatewayAttempts, 3);
        assert.equal(record.details?.gatewayMaxAttempts, 3);
        assert.deepEqual(record.details?.gatewayRetryDelaysMs, [200, 400]);
        return true;
      },
    );
  } finally {
    Math.random = originalRandom;
  }
});

contractTest("runtime.hermetic", "RetryingModelGateway never starts a hidden retry after visible provider output", async () => {
  let attempts = 0;
  const events: string[] = [];
  const gateway = new RetryingModelGateway(async <T>(_request: ModelRequest, options?: ModelGatewayCallOptions) => {
    attempts += 1;
    await options?.onEvent?.({
      type: "reasoning.delta",
      attempt: 1,
      format: "summary",
      delta: "Visible summary.",
    });
    throw createOpenRouterHttpError(502, JSON.stringify({ error: { message: "transient" } })) as T;
  }, { retryCount: 2 });

  await assert.rejects(() => gateway.call({ input: "test" }, {
    onEvent: (event) => { events.push(`${event.type}:${event.attempt}`); },
  }));

  assert.equal(attempts, 1);
  assert.deepEqual(events, [
    "attempt.started:1",
    "reasoning.delta:1",
    "reasoning.failed:1",
  ]);
});
