import assert from "node:assert/strict";
import test from "node:test";
import { createKestrelOneTavilyProvider } from "./kestrel-one-provider.js";

test("Kestrel One Tavily proxy uses an execution ticket instead of provider credentials", async () => {
  let requestUrl = "";
  let authorization = "";
  const provider = createKestrelOneTavilyProvider({
    appUrl: "https://kestrel.example",
    executionTicket: "execution-ticket",
    approvalModes: { "internet.usage": "ask" },
    fetchImpl: (async (url, init) => {
      requestUrl = String(url);
      authorization = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization
      );
      return new Response(JSON.stringify({ key: { usage: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const result = await provider.usage();
  assert.equal(
    requestUrl,
    "https://kestrel.example/api/runtime/apps/tavily/usage/confirmed/usage"
  );
  assert.equal(authorization, "Bearer execution-ticket");
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("execution-ticket"), false);
});
