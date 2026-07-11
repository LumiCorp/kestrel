import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";

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

test("RetryingModelGateway preserves timeout diagnostics from request metadata", async () => {
  const gateway = new RetryingModelGateway(
    async <T>() => {
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
