import assert from "node:assert/strict";
import test from "node:test";
import { notifyKestrel } from "../../scripts/build-production-image.js";

const REQUIRED_MIGRATION = "0073_application_owned_production_delivery";

test("publisher waits through transient readiness responses then posts once", async () => {
  const calls: string[] = [];
  const readiness = [404, 503, 200];
  await withNotifierEnvironment(async () => {
    await notifyKestrel(
      { kind: "platform" },
      notifierOptions(calls, async (_input, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST") return new Response(null, { status: 200 });
        const status = readiness.shift() ?? 500;
        return status === 200
          ? readyResponse()
          : new Response(null, { status });
      }),
    );
  });
  assert.deepEqual(calls, ["GET", "GET", "GET", "POST"]);
});

test("publisher treats a readiness network failure as transient", async () => {
  const calls: string[] = [];
  let first = true;
  await withNotifierEnvironment(async () => {
    await notifyKestrel(
      { kind: "platform" },
      notifierOptions(calls, async (_input, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && first) {
          first = false;
          throw new Error("network unavailable");
        }
        return method === "POST"
          ? new Response(null, { status: 200 })
          : readyResponse();
      }),
    );
  });
  assert.deepEqual(calls, ["GET", "GET", "POST"]);
});

test("publisher fails immediately when readiness authentication fails", async () => {
  const calls: string[] = [];
  await withNotifierEnvironment(async () => {
    await assert.rejects(
      notifyKestrel(
        { kind: "platform" },
        notifierOptions(calls, async () =>
          Promise.resolve(new Response(null, { status: 401 })),
        ),
      ),
      /readiness returned HTTP 401/u,
    );
  });
  assert.deepEqual(calls, ["GET"]);
});

test("publisher times out without posting when readiness never arrives", async () => {
  const calls: string[] = [];
  await withNotifierEnvironment(async () => {
    await assert.rejects(
      notifyKestrel(
        { kind: "platform" },
        notifierOptions(
          calls,
          async () => Promise.resolve(new Response(null, { status: 404 })),
          10,
        ),
      ),
      /not ready within 15 minutes/u,
    );
  });
  assert.deepEqual(calls, ["GET", "GET"]);
});

test("publisher never retries a failed deployment post", async () => {
  const calls: string[] = [];
  await withNotifierEnvironment(async () => {
    await assert.rejects(
      notifyKestrel(
        { kind: "platform" },
        notifierOptions(calls, async (_input, init) =>
          Promise.resolve(
            init?.method === "POST"
              ? new Response(null, { status: 500 })
              : readyResponse(),
          ),
        ),
      ),
      /Kestrel returned HTTP 500/u,
    );
  });
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("publisher rejects an old receiver that cannot prove the migration", async () => {
  const calls: string[] = [];
  await withNotifierEnvironment(async () => {
    await assert.rejects(
      notifyKestrel(
        { kind: "platform" },
        notifierOptions(
          calls,
          async () => Promise.resolve(Response.json({ ok: true })),
          10,
        ),
      ),
      /not ready within 15 minutes/u,
    );
  });
  assert.deepEqual(calls, ["GET", "GET"]);
});

function readyResponse() {
  return Response.json({ ok: true, migration: REQUIRED_MIGRATION });
}

function notifierOptions(
  calls: string[],
  response: typeof fetch,
  readinessTimeoutMs = 20,
) {
  let now = 0;
  return {
    fetchImpl: (async (input, init) => {
      calls.push(init?.method ?? "GET");
      return response(input, init);
    }) satisfies typeof fetch,
    now: () => now,
    readinessPollIntervalMs: 5,
    readinessTimeoutMs,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function withNotifierEnvironment(run: () => Promise<void>) {
  const previousUrl = process.env.KESTREL_ONE_PRODUCTION_URL;
  const previousToken = process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN;
  process.env.KESTREL_ONE_PRODUCTION_URL = "https://kestrel.example";
  process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN = "exact-token";
  try {
    await run();
  } finally {
    restoreEnvironment("KESTREL_ONE_PRODUCTION_URL", previousUrl);
    restoreEnvironment("PRODUCTION_IMAGE_DEPLOY_TOKEN", previousToken);
  }
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
