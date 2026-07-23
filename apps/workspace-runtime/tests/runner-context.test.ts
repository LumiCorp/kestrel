import assert from "node:assert/strict";
import {
  createWorkspaceRunnerContext,
} from "../src/runner-context.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest("services.hermetic", "store-only runner commands do not resolve a profile", async () => {
  let profileLoads = 0;
  const context = await createWorkspaceRunnerContext({
    actorId: "actor-1",
    organizationId: "organization-1",
  });

  assert.equal(profileLoads, 0);
  assert.equal(context.profile, undefined);
  assert.deepEqual(context.actor, {
    actorId: "actor-1",
    actorType: "end_user",
    tenantId: "organization-1",
  });
});

contractTest("services.hermetic", "profile-backed runner commands retain their resolved profile", async () => {
  let profileLoads = 0;
  const profile = {
    id: "profile-1",
    model: {
      provider: "openai" as const,
      model: "gpt-5",
    },
    tools: [],
  };
  const context = await createWorkspaceRunnerContext({
    actorId: "actor-1",
    organizationId: "organization-1",
    loadProfile: async () => {
      profileLoads += 1;
      return profile;
    },
  });

  assert.equal(profileLoads, 1);
  assert.equal(context.profile, profile);
});
