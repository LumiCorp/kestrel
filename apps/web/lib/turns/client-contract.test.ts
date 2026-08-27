import assert from "node:assert/strict";
import test from "node:test";
import { runtimeApprovalPolicyViewSchema } from "./client-contract";

const policy = {
  projectId: "project-1",
  environmentId: "environment-1",
  appKey: "tavily",
  capabilityKey: "research",
  capabilityDisplayName: "Run research",
  environmentApprovalMode: "ask",
  projectApprovalMode: "ask",
  minimumApprovalMode: "auto",
  reasonCode: "environment_policy",
  canEditProject: true,
};

test("runtime approval client contract contains policy evidence without approval detours", () => {
  assert.deepEqual(runtimeApprovalPolicyViewSchema.parse(policy), policy);
  assert.equal(
    runtimeApprovalPolicyViewSchema.safeParse({
      ...policy,
      alwaysApprovalAction: "open_environment_apps",
      environmentAppsHref:
        "/organization/environments/environment-1/apps/tavily",
    }).success,
    true,
    "Zod object parsing remains compatible with older server payloads",
  );
  const parsed = runtimeApprovalPolicyViewSchema.parse({
    ...policy,
    alwaysApprovalAction: "open_environment_apps",
    environmentAppsHref: "/organization/environments/environment-1/apps/tavily",
  });
  assert.equal("alwaysApprovalAction" in parsed, false);
  assert.equal("environmentAppsHref" in parsed, false);
});
