import test from "node:test";
import assert from "node:assert/strict";
import { errorResponse } from "./http";


test("errorResponse classifies revoked API keys as unauthorized", async () => {
  const response = errorResponse(new Error("Invalid API key."));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid API key." });
});

test("protected route authentication failures return 401", async () => {
  const response = errorResponse(new Error("Unauthorized"));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("attachment availability errors preserve retryable HTTP semantics", async () => {
  const temporary = errorResponse(
    Object.assign(new Error("The attachment service is temporarily unavailable."), {
      code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
    }),
    404,
  );
  const missing = errorResponse(
    Object.assign(new Error("The attached file content is unavailable."), {
      code: "ATTACHMENT_BLOB_MISSING",
    }),
    400,
  );

  assert.equal(temporary.status, 503);
  assert.equal(missing.status, 404);
});
