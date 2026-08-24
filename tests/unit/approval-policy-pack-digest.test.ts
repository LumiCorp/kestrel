import test from "node:test";
import assert from "node:assert/strict";

import {
  digestApprovalPolicyPack,
  getApprovalPolicyPack,
} from "../../cli/runtime/approvalPolicyPacks.js";

test("approval policy pack digest is deterministic and excludes presentation metadata", () => {
  const pack = getApprovalPolicyPack("dev");
  const expected = digestApprovalPolicyPack(pack);
  assert.match(expected, /^[a-f0-9]{64}$/u);
  assert.equal(digestApprovalPolicyPack({ ...pack, label: "Renamed" }), expected);
  assert.equal(
    digestApprovalPolicyPack({
      ...pack,
      allowedToolClasses: [...pack.allowedToolClasses].reverse(),
      allowedCapabilities: [...pack.allowedCapabilities].reverse(),
    }),
    expected,
  );
  assert.notEqual(
    digestApprovalPolicyPack({ ...pack, strictApprovalPerCall: true }),
    expected,
  );
});
