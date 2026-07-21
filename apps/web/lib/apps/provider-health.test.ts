import assert from "node:assert/strict";
import { appProviderHealthTransition } from "./provider-health";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "provider connection health degrades on credential rejection and recovers on success", () => {
  const degradedStatusCodes = [401, 403];
  assert.equal(
    appProviderHealthTransition({ status: 401, degradedStatusCodes }),
    "degraded"
  );
  assert.equal(
    appProviderHealthTransition({ status: 403, degradedStatusCodes }),
    "degraded"
  );
  assert.equal(
    appProviderHealthTransition({ status: 200, degradedStatusCodes }),
    "healthy"
  );
  assert.equal(
    appProviderHealthTransition({ status: 503, degradedStatusCodes }),
    "unchanged"
  );
});
