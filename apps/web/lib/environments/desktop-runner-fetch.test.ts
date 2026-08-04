import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopEnvironmentRunnerFetch } from "./desktop-runner-fetch";

const organizationId = "organization-1";
const actorUserId = "user-1";

function profileGetCommand(profileId: string): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify({
      id: `profile-get-${profileId}`,
      type: "profile.get",
      payload: { profileId },
      metadata: {
        tenantId: organizationId,
        actor: {
          actorId: actorUserId,
          actorType: "end_user",
          tenantId: organizationId,
        },
      },
    }),
  };
}

function createRunnerFetch(): typeof fetch {
  return createDesktopEnvironmentRunnerFetch({
    organizationId,
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    executionId: "execution-1",
    actorUserId,
  });
}

test("Desktop environment profile.get returns only the canonical Kestrel profile", async () => {
  const response = await createRunnerFetch()(
    "http://runner.invalid/v1/commands",
    profileGetCommand("kestrel"),
  );
  const event = await response.json() as {
    type: string;
    payload: { profile?: { id?: string; sessionPrefix?: string } };
  };

  assert.equal(response.status, 200);
  assert.equal(event.type, "profile.loaded");
  assert.equal(event.payload.profile?.id, "kestrel");
  assert.equal(event.payload.profile?.sessionPrefix, "kestrel");
});

test("Desktop environment profile.get rejects legacy profile identities", async () => {
  const response = await createRunnerFetch()(
    "http://runner.invalid/v1/commands",
    profileGetCommand("reference"),
  );
  const event = await response.json() as {
    type: string;
    payload: { code?: string };
  };

  assert.equal(response.status, 404);
  assert.equal(event.type, "runner.error");
  assert.equal(event.payload.code, "PROFILE_NOT_FOUND");
});
