import assert from "node:assert/strict";
import { errorResponse } from "./http";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "errorResponse classifies revoked API keys as unauthorized", async () => {
  const response = errorResponse(new Error("Invalid API key."));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid API key." });
});

contractTest("web.hermetic", "protected route authentication failures return 401", async () => {
  const response = errorResponse(new Error("Unauthorized"));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});
