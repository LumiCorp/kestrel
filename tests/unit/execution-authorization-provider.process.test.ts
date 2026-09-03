import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { ExecutionAuthorizationProvider } from "../../src/runtime/ExecutionAuthorizationProvider.js";

function ticket(expiresAt: number, nonce: string) {
  return [
    "header",
    Buffer.from(JSON.stringify({ expiresAt, nonce })).toString("base64url"),
    "signature",
  ].join(".");
}

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
