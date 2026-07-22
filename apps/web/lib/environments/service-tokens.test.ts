import assert from "node:assert/strict";
import {
  createEnvironmentServiceToken,
  hashEnvironmentServiceToken,
  verifyEnvironmentServiceToken,
} from "./service-tokens";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "Environment service identities store only a one-way token hash", () => {
  const token = createEnvironmentServiceToken();
  const hash = hashEnvironmentServiceToken(token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(hash, token);
  assert.equal(verifyEnvironmentServiceToken({ token, expectedHash: hash }), true);
  assert.equal(
    verifyEnvironmentServiceToken({ token: createEnvironmentServiceToken(), expectedHash: hash }),
    false
  );
});
