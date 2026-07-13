import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedEnvironmentsEnabled,
  requireHostedEnvironmentsEnabled,
} from "./config";

test("Environment rollout flag fails closed without legacy runner fallback", () => {
  assert.equal(hostedEnvironmentsEnabled({}), false);
  assert.equal(
    hostedEnvironmentsEnabled({ KESTREL_ENVIRONMENTS_ENABLED: "true" }),
    true
  );
  assert.throws(() => requireHostedEnvironmentsEnabled({}));
});
