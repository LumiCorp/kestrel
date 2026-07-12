import assert from "node:assert/strict";
import test from "node:test";
import { errorResponse } from "./http";

test("errorResponse classifies revoked API keys as unauthorized", async () => {
  const response = errorResponse(new Error("Invalid API key."));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid API key." });
});
