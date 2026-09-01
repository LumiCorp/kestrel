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

test("workflow policy errors preserve their public code", async () => {
  const response = errorResponse(
    Object.assign(new Error("Choose another model."), {
      code: "WORKFLOW_MODEL_UNSUPPORTED",
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Choose another model.",
    code: "WORKFLOW_MODEL_UNSUPPORTED",
  });
});

test("database failures never expose query text or parameters", async () => {
  const error = Object.assign(
    new Error('Failed query: insert into "file_scope_grants" params: private-id'),
    { code: "23505" },
  );
  const response = errorResponse(error, 400);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Database operation failed.",
    code: "DATABASE_OPERATION_FAILED",
    category: "query_failed",
  });
});
