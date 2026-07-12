import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicHttpError } from "../../models/anthropic/AnthropicErrors.js";

test("Anthropic authentication failures use the shared refreshable error code", () => {
  const unauthorized = createAnthropicHttpError(401, "unauthorized");
  const forbidden = createAnthropicHttpError(403, "forbidden");

  assert.equal(unauthorized.code, "MODEL_AUTH_ERROR");
  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.code, "MODEL_AUTH_ERROR");
  assert.equal(forbidden.status, 403);
});
