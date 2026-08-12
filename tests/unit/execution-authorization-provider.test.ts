import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionAuthorizationProvider } from "../../src/runtime/ExecutionAuthorizationProvider.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

function ticket(expiresAt: number, nonce: string) {
  return [
    "header",
    Buffer.from(JSON.stringify({ expiresAt, nonce }), "utf8").toString("base64url"),
    "signature",
  ].join(".");
}

test("execution authorization renews once for concurrent tools after five minutes", async () => {
  const realNow = Date.now;
  let now = Date.parse("2026-08-11T12:00:00.000Z");
  Date.now = () => now;
  const initialTicket = ticket(Math.floor(now / 1000) + 300, "initial");
  const renewedTicket = ticket(Math.floor(now / 1000) + 600, "renewed");
  let requests = 0;
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: initialTicket,
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "opaque-renewal-token",
      },
    },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization,
        "Bearer opaque-renewal-token");
      return Response.json({
        version: "execution-authorization-renewal-v1",
        executionTicket: renewedTicket,
        expiresAt: new Date(now + 300_000).toISOString(),
        renewAfter: new Date(now + 240_000).toISOString(),
      });
    }) as unknown as typeof fetch,
  });
  try {
    now += 301_000;
    const values = await Promise.all([
      provider.getTicket(),
      provider.getTicket(),
      provider.getTicket(),
    ]);
    assert.deepEqual(values, [renewedTicket, renewedTicket, renewedTicket]);
    assert.equal(requests, 1);
  } finally {
    provider.close();
    Date.now = realNow;
  }
});

test("execution authorization preserves an exact renewal denial", async () => {
  const initialTicket = ticket(Math.floor(Date.now() / 1000) + 300, "initial");
  let requests = 0;
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: initialTicket,
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "reclaimed-token",
      },
    },
    fetchImpl: (async () => {
      requests += 1;
      return Response.json(
        { error: { code: "EXECUTION_AUTH_RENEWAL_DENIED" } },
        { status: 403 },
      );
    }) as unknown as typeof fetch,
  });
  try {
    await assert.rejects(
      provider.getTicket({ forceRenew: true }),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.code === "EXECUTION_AUTH_RENEWAL_DENIED",
    );
    await assert.rejects(
      provider.getTicket({ forceRenew: true }),
      (error: unknown) =>
        error instanceof RuntimeFailure &&
        error.code === "EXECUTION_AUTH_RENEWAL_DENIED",
    );
    assert.equal(requests, 1);
  } finally {
    provider.close();
  }
});

test("execution authorization latches control-plane unavailability after expiry", async () => {
  const realNow = Date.now;
  let now = Date.parse("2026-08-11T14:00:00.000Z");
  Date.now = () => now;
  let requests = 0;
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: ticket(Math.floor(now / 1000) + 10, "expiring"),
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "unavailable-token",
      },
    },
    fetchImpl: (async () => {
      requests += 1;
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch,
  });
  try {
    now += 11_000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        provider.getTicket({ forceRenew: true }),
        (error: unknown) =>
          error instanceof RuntimeFailure &&
          error.code === "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      );
    }
    assert.equal(requests, 1);
  } finally {
    provider.close();
    Date.now = realNow;
  }
});
