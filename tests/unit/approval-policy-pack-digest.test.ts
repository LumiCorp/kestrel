import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionPolicyFromPack,
  digestApprovalPolicyPack,
  getApprovalPolicyPack,
  listApprovalPolicyPacks,
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

test("default-deny policy packs compile an explicit decision for every tool class", () => {
  for (const pack of listApprovalPolicyPacks()) {
    const policy = buildExecutionPolicyFromPack(pack.id).toolClassPolicy;
    assert.deepEqual(Object.keys(policy ?? {}).sort(), [
      "external_side_effect",
      "planning_write",
      "read_only",
      "sandboxed_only",
    ]);
    for (const toolClass of Object.keys(policy ?? {})) {
      assert.equal(
        policy?.[toolClass as keyof typeof policy],
        pack.allowedToolClasses.includes(
          toolClass as (typeof pack.allowedToolClasses)[number],
        ),
      );
    }
  }
});

test("policy packs preserve planning writes except in the read-only production pack", () => {
  for (const packId of [
    "dev",
    "isolated_code",
    "ci_bot",
    "hosted_workspace",
  ] as const) {
    assert.equal(
      buildExecutionPolicyFromPack(packId).toolClassPolicy?.planning_write,
      true,
    );
  }
  assert.equal(
    buildExecutionPolicyFromPack("production").toolClassPolicy?.planning_write,
    false,
  );
});
