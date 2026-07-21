import assert from "node:assert/strict";
import { assertTavilyProxyTarget, TavilyRuntimeError } from "./tavily-runtime";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Tavily runtime proxy allows only the endpoint owned by a capability", () => {
  assert.doesNotThrow(() =>
    assertTavilyProxyTarget({
      capability: "search_advanced",
      method: "POST",
      path: ["search"],
    })
  );
  assert.doesNotThrow(() =>
    assertTavilyProxyTarget({
      capability: "research_status",
      method: "GET",
      path: ["research", "request_123"],
    })
  );
});

contractTest("web.hermetic", "Tavily runtime proxy rejects capability and upstream path mismatches", () => {
  assert.throws(
    () =>
      assertTavilyProxyTarget({
        capability: "search",
        method: "POST",
        path: ["research"],
      }),
    (error: unknown) =>
      error instanceof TavilyRuntimeError &&
      error.code === "TAVILY_PROXY_TARGET_DENIED"
  );
  assert.throws(() =>
    assertTavilyProxyTarget({
      capability: "usage",
      method: "POST",
      path: ["usage"],
    })
  );
});
