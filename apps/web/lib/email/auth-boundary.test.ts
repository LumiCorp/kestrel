import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const authSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../auth.ts"),
  "utf8"
);

contractTest("web.hermetic", "all Better Auth email flows use the centralized delivery service", () => {
  assert.match(authSource, /deliverTransactionalEmail/);
  for (const kind of [
    "verification",
    "password_reset",
    "organization_invitation",
    "two_factor_otp",
  ]) {
    assert.match(authSource, new RegExp(`kind: "${kind}"`));
  }
  assert.doesNotMatch(authSource, /new Resend|resend\.emails\.send/);
});

contractTest("web.hermetic", "auth boundary does not directly log sensitive fallback values", () => {
  assert.doesNotMatch(authSource, /console\.(?:log|info|warn|error)/);
  assert.doesNotMatch(authSource, /TEST_EMAIL/);
});
