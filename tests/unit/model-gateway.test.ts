import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { createOpenAiHttpError } from "../../models/openai/OpenAiErrors.js";
import {
  MODEL_REQUEST_V2_VERSION,
  createModelRequestV2,
  parseModelRequestV2,
} from "../../src/kestrel/contracts/model-registration.js";


test("RetryingModelGateway retries timeout and surfaces IO_MODEL_TIMEOUT code", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async <T>() => {
      calls += 1;
      return await new Promise<T>((resolve) => {
        setTimeout(() => resolve({ ok: true } as T), 40);
      });
    },
    {
      timeoutMs: 10,
      retryCount: 1,
      timingPolicy: {
        phaseCapMs: 10,
        reserveMs: 0,
        minTimeoutMs: 10,
      },
    },
  );

  await assert.rejects(
    () =>
      gateway.call({
        input: "slow",
      }),
    (error: unknown) => {
      assert.equal(calls, 2);
      assert.equal(typeof error, "object");
      const code = (error as { code?: unknown })?.code;
      const message = (error as { message?: unknown })?.message;
      assert.equal(code, "IO_MODEL_TIMEOUT");
      assert.equal(typeof message, "string");
      assert.match(String(message), /timed out after 10ms \(attempt 2\/2\)/);
      return true;
    },
  );
});

test("RetryingModelGateway returns immediately when invocation resolves before timeout", async () => {
  const gateway = new RetryingModelGateway(
    async <T>() => ({ ok: true } as T),
    {
      timeoutMs: 20,
      retryCount: 1,
      timingPolicy: {
        phaseCapMs: 20,
        reserveMs: 0,
        minTimeoutMs: 10,
      },
    },
  );

  const response = await gateway.call<{ ok: boolean }>({ input: "fast" });
  assert.equal(response.ok, true);
});

test("RetryingModelGateway retries transient provider 502 failures", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async <T>() => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("OpenAI server error (502): Bad gateway") as Error & {
          code: string;
          status: number;
        };
        error.code = "MODEL_PROVIDER_ERROR";
        error.status = 502;
        throw error;
      }
      return { ok: true } as T;
    },
    {
      retryCount: 2,
    },
  );

  const response = await gateway.call<{ ok: boolean }>({ input: "retry transient" });
  assert.equal(response.ok, true);
  assert.equal(calls, 3);
});

test("RetryingModelGateway honors a zero per-call retry override without changing the default", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async <T>() => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("rate limited"), {
          code: "MODEL_RATE_LIMITED",
          status: 429,
          retryAfterMs: 1,
        });
      }
      return { ok: true } as T;
    },
    { retryCount: 2 },
  );

  await assert.rejects(
    () => gateway.call({ input: "maintenance" }, { retryCount: 0 }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(calls, 1);
      assert.equal(details?.gatewayAttempts, 1);
      assert.equal(details?.gatewayMaxAttempts, 1);
      return true;
    },
  );

  calls = 0;
  const response = await gateway.call<{ ok: boolean }>({ input: "action" });
  assert.equal(response.ok, true);
  assert.equal(calls, 3);
});

test("RetryingModelGateway rejects invalid per-call retry counts before dispatch", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    calls += 1;
    return { ok: true } as T;
  });

  for (const retryCount of [-1, 0.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => gateway.call({ input: "invalid retries" }, { retryCount }),
      RangeError,
    );
  }
  assert.equal(calls, 0);
});

test("RetryingModelGateway retries HTTP 408 three total attempts and preserves the timeout", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async () => {
      calls += 1;
      throw createOpenAiHttpError(408, "request timeout", "OpenAI", 1);
    },
    { retryCount: 2 },
  );

  await assert.rejects(
    () => gateway.call({ input: "retry timeout" }),
    (error: unknown) => {
      const failure = error as {
        code?: unknown;
        status?: unknown;
        details?: Record<string, unknown>;
      };
      assert.equal(calls, 3);
      assert.equal(failure.code, "MODEL_TIMEOUT");
      assert.equal(failure.status, 408);
      assert.equal(failure.details?.gatewayAttempts, 3);
      assert.equal(failure.details?.gatewayMaxAttempts, 3);
      assert.deepEqual(failure.details?.gatewayRetryDelaysMs, [1, 1]);
      return true;
    },
  );
});

test("RetryingModelGateway lets retryable HTTP status override a generic provider code", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(async <T>() => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("generic bad response"), {
        code: "MODEL_BAD_RESPONSE",
        status: 408,
        retryAfterMs: 1,
      });
    }
    return { ok: true } as T;
  }, { retryCount: 1 });

  assert.deepEqual(await gateway.call({ input: "status wins" }), { ok: true });
  assert.equal(calls, 2);
});

test("RetryingModelGateway does not retry bare fetch-failed message text", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(async () => {
    calls += 1;
    throw new Error("fetch failed");
  }, { retryCount: 2 });

  await assert.rejects(() => gateway.call({ input: "no heuristic retry" }), /fetch failed/u);
  assert.equal(calls, 1);
});

test("RetryingModelGateway retries native network failures", async () => {
  for (const failure of [
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" }),
    }),
  ]) {
    let calls = 0;
    const gateway = new RetryingModelGateway(
      async <T>() => {
        calls += 1;
        if (calls === 1) throw failure;
        return { ok: true } as T;
      },
      { retryCount: 1 },
    );

    const response = await gateway.call<{ ok: boolean }>({ input: "retry network" });
    assert.equal(response.ok, true);
    assert.equal(calls, 2);
  }
});

test("RetryingModelGateway does not retry non-transient provider errors", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async <T>() => {
      calls += 1;
      const error = new Error("OpenAI auth failed (401)") as Error & {
        code: string;
        status: number;
      };
      error.code = "MODEL_AUTH_ERROR";
      error.status = 401;
      throw error;
    },
    {
      retryCount: 2,
    },
  );

  await assert.rejects(
    () => gateway.call({ input: "auth failed" }),
    (error: unknown) => {
      assert.equal(calls, 1);
      assert.equal((error as { code?: unknown })?.code, "MODEL_AUTH_ERROR");
      return true;
    },
  );
});

test("RetryingModelGateway reduces retry timeout as run budget burns", async () => {
  let calls = 0;
  const gateway = new RetryingModelGateway(
    async <T>() => {
      calls += 1;
      return await new Promise<T>((resolve) => {
        setTimeout(() => resolve({ ok: true } as T), 120);
      });
    },
    {
      timeoutMs: 20,
      retryCount: 1,
      timingPolicy: {
        phaseCapMs: 20,
        reserveMs: 0,
        minTimeoutMs: 10,
      },
    },
  );

  await assert.rejects(
    () =>
      gateway.call({
        input: "slow",
        metadata: {
          runtimeBudgetRemainingMs: 25,
        },
    }),
    (error: unknown) => {
      const message = String((error as { message?: unknown })?.message ?? "");
      assert.equal(calls, 1);
      assert.match(message, /timed out after 20ms \(attempt 1\/2\)/);
      return true;
    },
  );
});

test("RetryingModelGateway forwards attempt timeout metadata to the invoker", async () => {
  let seenRemaining: unknown;
  const gateway = new RetryingModelGateway(
    async <T>(request: ModelRequest) => {
      seenRemaining = request.metadata?.runtimeBudgetRemainingMs;
      return { ok: true } as T;
    },
    {
      timeoutMs: 20,
      retryCount: 0,
      timingPolicy: {
        phaseCapMs: 20,
        reserveMs: 0,
        minTimeoutMs: 10,
      },
    },
  );

  const response = await gateway.call<{ ok: boolean }>({
    input: "fast",
    metadata: {
      runtimeBudgetRemainingMs: 25,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(typeof seenRemaining, "number");
  assert.equal((seenRemaining as number) <= 25, true);
});

test("RetryingModelGateway does not mutate a fingerprinted V2 request before invocation", async () => {
  let seen: ModelRequest | undefined;
  const gateway = new RetryingModelGateway(
    async <T>(request: ModelRequest) => {
      seen = request;
      throw new Error("stop after capture") as unknown as T;
    },
    { retryCount: 0 },
  );
  const request = createModelRequestV2({
    version: MODEL_REQUEST_V2_VERSION,
    model: "test-model",
    input: "plain text",
    requirements: {
      runtimeRole: "agent.loop",
      output: { kind: "text", assurance: "none" },
      tools: { choice: "none", strictArguments: false, parallelism: "forbidden" },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" },
      inputModalities: ["text"],
      endpoint: "chat",
    },
  });

  await assert.rejects(() => gateway.call(request), /stop after capture/u);
  assert.deepEqual(seen, request);
  assert.doesNotThrow(() => parseModelRequestV2(seen));
});

test("RetryingModelGateway preserves timeout diagnostics from request metadata", async () => {
  const gateway = new RetryingModelGateway(
    async <T>() => await new Promise<T>((resolve) => {
        setTimeout(() => resolve({ ok: true } as T), 40);
      }),
    {
      timeoutMs: 10,
      retryCount: 1,
      timingPolicy: {
        phaseCapMs: 10,
        reserveMs: 0,
        minTimeoutMs: 10,
      },
    },
  );

  await assert.rejects(
    () =>
      gateway.call({
        input: "slow",
        model: "openai/gpt-4.1-mini",
        metadata: {
          runId: "run-123",
          phase: "ACT",
          stepAgent: "agent.loop",
          runtimeBudgetRemainingMs: 25,
          objective: "investigate tesla and xai",
          lastToolName: "internet.news",
          lastToolInputHash: "hash-123",
        },
      }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> })?.details ?? {};
      assert.equal(details.runId, "run-123");
      assert.equal(details.phase, "ACT");
      assert.equal(details.stepAgent, "agent.loop");
      assert.equal(details.model, "openai/gpt-4.1-mini");
      assert.equal(typeof details.runtimeBudgetRemainingMs, "number");
      assert.equal((details.runtimeBudgetRemainingMs as number) <= 25, true);
      assert.equal(details.objective, "investigate tesla and xai");
      assert.equal(details.lastToolName, "internet.news");
      assert.equal(details.lastToolInputHash, "hash-123");
      return true;
    },
  );
});

test("RetryingModelGateway never retries 409, 425, or malformed responses", async () => {
  for (const failure of [
    { code: "MODEL_PROVIDER_ERROR", status: 409 },
    { code: "MODEL_PROVIDER_ERROR", status: 425 },
    { code: "MODEL_MALFORMED_RESPONSE", status: undefined },
  ]) {
    let calls = 0;
    const gateway = new RetryingModelGateway(
      async () => {
        calls += 1;
        throw Object.assign(new Error("terminal"), failure);
      },
      { retryCount: 2, timeoutMs: 1000 },
    );
    await assert.rejects(() => gateway.call({ input: "test" }));
    assert.equal(calls, 1);
  }
});
