import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicHttpError } from "../../models/anthropic/AnthropicErrors.js";


test("Anthropic authentication failures use the shared refreshable error code", () => {
  const unauthorized = createAnthropicHttpError(401, "unauthorized");
  const forbidden = createAnthropicHttpError(403, "forbidden");

  assert.equal(unauthorized.code, "MODEL_AUTH_ERROR");
  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.code, "MODEL_AUTH_ERROR");
  assert.equal(forbidden.status, 403);
});

test("Anthropic normalizes retryable HTTP failures and safe retry hints", () => {
  const timeout = createAnthropicHttpError(408, "timeout", 1250);
  const rateLimited = createAnthropicHttpError(429, "slow down", 2000);
  const unavailable = createAnthropicHttpError(503, "unavailable");

  assert.equal(timeout.code, "MODEL_TIMEOUT");
  assert.equal(timeout.retryAfterMs, 1250);
  assert.equal(rateLimited.code, "MODEL_RATE_LIMITED");
  assert.equal(rateLimited.retryAfterMs, 2000);
  assert.equal(unavailable.code, "MODEL_PROVIDER_ERROR");
});
