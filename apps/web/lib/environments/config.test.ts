import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedEnvironmentsDeploymentEnabled,
  hostedEnvironmentsEnabled,
} from "./config";

test("Environment rollout requires both deployment and organization flags", () => {
  assert.equal(hostedEnvironmentsDeploymentEnabled({}), false);
  assert.equal(
    hostedEnvironmentsDeploymentEnabled({
      KESTREL_ENVIRONMENTS_ENABLED: "true",
    }),
    true
  );
  assert.equal(
    hostedEnvironmentsEnabled({
      organizationEnabled: false,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    false
  );
  assert.equal(
    hostedEnvironmentsEnabled({
      organizationEnabled: true,
      env: { KESTREL_ENVIRONMENTS_ENABLED: "true" },
    }),
    true
  );
  assert.equal(
    hostedEnvironmentsEnabled({ organizationEnabled: true, env: {} }),
    false
  );
});
