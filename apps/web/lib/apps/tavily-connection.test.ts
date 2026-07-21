import assert from "node:assert/strict";
import {
  TavilyConnectionError,
  validateTavilyConnection,
} from "./tavily-connection";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "validates Tavily credentials without exposing them in the result", async () => {
  let authorization = "";
  const result = await validateTavilyConnection({
    apiKey: "tvly-secret",
    projectId: "project-1",
    fetchImpl: (async (_url, init) => {
      authorization = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization
      );
      assert.equal(
        (init?.headers as Record<string, string> | undefined)?.["X-Project-ID"],
        "project-1"
      );
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(authorization, "Bearer tvly-secret");
  assert.equal(result.status, "connected");
  assert.equal(JSON.stringify(result).includes("tvly-secret"), false);
});

contractTest("web.hermetic", "rejects credentials Tavily does not authorize", async () => {
  await assert.rejects(
    validateTavilyConnection({
      apiKey: "wrong",
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof TavilyConnectionError &&
      error.code === "APP_CONNECTION_INVALID"
  );
});
