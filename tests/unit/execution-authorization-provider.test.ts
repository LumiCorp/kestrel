import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ExecutionAuthorizationProvider,
  type ExecutionAuthorizationRenewalDiagnostic,
} from "../../src/runtime/ExecutionAuthorizationProvider.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

function ticket(expiresAt: number, nonce: string) {
  return [
    "header",
    Buffer.from(JSON.stringify({ expiresAt, nonce }), "utf8").toString("base64url"),
    "signature",
  ].join(".");
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

test("execution authorization renews once for concurrent tools before expiry", async () => {
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
    onDiagnostic: () => {},
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
    now += 241_000;
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

test("an in-flight renewal remains authoritative while the old ticket expires", async () => {
  const realNow = Date.now;
  let now = Date.parse("2026-08-11T12:30:00.000Z");
  Date.now = () => now;
  const renewedTicket = ticket(Math.floor(now / 1000) + 600, "renewed");
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: ticket(Math.floor(now / 1000) + 300, "initial"),
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "renewal-token",
      },
    },
    onDiagnostic: () => {},
    fetchImpl: (() => response) as unknown as typeof fetch,
  });
  try {
    const first = provider.getTicket({ forceRenew: true });
    now += 301_000;
    const second = provider.getTicket();
    resolveResponse(Response.json({
      version: "execution-authorization-renewal-v1",
      executionTicket: renewedTicket,
      expiresAt: new Date(now + 300_000).toISOString(),
      renewAfter: new Date(now + 240_000).toISOString(),
    }));
    assert.deepEqual(await Promise.all([first, second]), [
      renewedTicket,
      renewedTicket,
    ]);
  } finally {
    provider.close();
    Date.now = realNow;
  }
});

test("execution authorization retries every fifteen seconds until renewal succeeds", async (context) => {
  const now = Date.parse("2026-08-11T13:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const initialTicket = ticket(Math.floor(now / 1000) + 300, "initial");
  const renewedTicket = ticket(Math.floor(now / 1000) + 600, "renewed");
  const diagnostics: ExecutionAuthorizationRenewalDiagnostic[] = [];
  let requests = 0;
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: initialTicket,
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew/private-execution-id",
        token: "opaque-renewal-token",
      },
    },
    runId: "run-renewal-retry",
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: (async () => {
      requests += 1;
      if (requests < 3) throw new TypeError("network unavailable");
      return Response.json({
        version: "execution-authorization-renewal-v1",
        executionTicket: renewedTicket,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        renewAfter: new Date(Date.now() + 240_000).toISOString(),
      });
    }) as unknown as typeof fetch,
  });
  try {
    context.mock.timers.tick(240_000);
    await flushAsyncWork();
    assert.equal(requests, 1);

    context.mock.timers.tick(15_000);
    await flushAsyncWork();
    assert.equal(requests, 2);

    context.mock.timers.tick(15_000);
    await flushAsyncWork();
    assert.equal(requests, 3);
    assert.equal(await provider.getTicket(), renewedTicket);
    assert.equal(provider.currentTicket, renewedTicket);
    assert.deepEqual(
      diagnostics.map(({ attempt, outcome }) => ({ attempt, outcome })),
      [
        { attempt: 1, outcome: "transport_failure" },
        { attempt: 2, outcome: "transport_failure" },
        { attempt: 3, outcome: "renewed" },
      ],
    );
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /opaque-renewal-token/u);
    assert.doesNotMatch(serialized, /private-execution-id/u);
    assert.doesNotMatch(serialized, new RegExp(initialTicket, "u"));
  } finally {
    provider.close();
    context.mock.timers.reset();
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
    onDiagnostic: () => {},
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

test("execution authorization stops retrying and latches unavailability at expiry", async (context) => {
  const now = Date.parse("2026-08-11T14:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let requests = 0;
  const diagnostics: ExecutionAuthorizationRenewalDiagnostic[] = [];
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: ticket(Math.floor(now / 1000) + 30, "expiring"),
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "unavailable-token",
      },
    },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: (async () => {
      requests += 1;
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch,
  });
  try {
    context.mock.timers.tick(1);
    await flushAsyncWork();
    context.mock.timers.tick(15_000);
    await flushAsyncWork();
    context.mock.timers.tick(14_999);
    await flushAsyncWork();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        provider.getTicket({ forceRenew: true }),
        (error: unknown) =>
          error instanceof RuntimeFailure &&
          error.code === "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      );
    }
    assert.equal(requests, 2);
    assert.deepEqual(
      diagnostics.map(({ attempt, outcome }) => ({ attempt, outcome })),
      [
        { attempt: 1, outcome: "transport_failure" },
        { attempt: 2, outcome: "transport_failure" },
        { attempt: 2, outcome: "expired" },
      ],
    );
  } finally {
    provider.close();
    context.mock.timers.reset();
  }
});

test("execution authorization latches an invalid successful response", async () => {
  let requests = 0;
  const diagnostics: ExecutionAuthorizationRenewalDiagnostic[] = [];
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: ticket(Math.floor(Date.now() / 1000) + 300, "initial"),
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "renewal-token",
      },
    },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: (async () => {
      requests += 1;
      return Response.json({ version: "wrong-version" });
    }) as unknown as typeof fetch,
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        provider.getTicket({ forceRenew: true }),
        (error: unknown) =>
          error instanceof RuntimeFailure &&
          error.code === "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      );
    }
    assert.equal(requests, 1);
    assert.deepEqual(
      diagnostics.map(({ outcome }) => outcome),
      ["invalid_response"],
    );
  } finally {
    provider.close();
  }
});

test("execution authorization force-renews through HTTP and reuses the renewed ticket", async () => {
  const now = Date.now();
  const initialTicket = ticket(Math.floor(now / 1000) + 300, "initial-http");
  const renewedTicket = ticket(Math.floor(now / 1000) + 600, "renewed-http");
  let renewalAuthorization = "";
  let renewedAuthorization = "";
  const server = createServer((request, response) => {
    if (request.url === "/renew") {
      renewalAuthorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        version: "execution-authorization-renewal-v1",
        executionTicket: renewedTicket,
        expiresAt: new Date(now + 300_000).toISOString(),
        renewAfter: new Date(now + 240_000).toISOString(),
      }));
      return;
    }
    renewedAuthorization = request.headers.authorization ?? "";
    response.statusCode = renewedAuthorization === `Bearer ${renewedTicket}`
      ? 204
      : 401;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new ExecutionAuthorizationProvider({
    authorization: {
      executionTicket: initialTicket,
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: `http://127.0.0.1:${address.port}/renew`,
        token: "http-renewal-token",
      },
    },
    onDiagnostic: () => {},
  });
  try {
    assert.equal(
      await provider.getTicket({ forceRenew: true }),
      renewedTicket,
    );
    const response = await fetch(`http://127.0.0.1:${address.port}/no-effect`, {
      headers: { authorization: `Bearer ${await provider.getTicket()}` },
    });
    assert.equal(response.status, 204);
    assert.equal(renewalAuthorization, "Bearer http-renewal-token");
    assert.equal(renewedAuthorization, `Bearer ${renewedTicket}`);
  } finally {
    provider.close();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});
