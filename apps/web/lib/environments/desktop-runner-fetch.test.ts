import assert from "node:assert/strict";
import test from "node:test";

import { parseRunnerCommandV2 } from "@kestrel-agents/protocol";
import {
  createDesktopEnvironmentRunnerFetch,
  materializeDesktopRunStartProfile,
} from "./desktop-runner-fetch";

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

test("Desktop environment resolves a server-owned workspace profile", async () => {
  const runnerFetch = createRunnerFetch();
  const response = await runnerFetch("http://runner.invalid/v1/commands", {
    method: "POST",
    body: JSON.stringify({
      id: "resolve-profile-codex",
      type: "execution-profile.resolve",
      payload: {
        environmentPresetId: "workspace_hosted",
        managedConfiguration: {
          runtimeId: "codex",
          label: "Kestrel One",
          modelProvider: "openai",
          model: "gpt-5",
          default: false,
        },
      },
      metadata: {
        tenantId: organizationId,
        actor: {
          actorId: actorUserId,
          actorType: "end_user",
          tenantId: organizationId,
        },
      },
    }),
  });
  const event = await response.json() as {
    type: string;
    payload: {
      profileId: string;
      fingerprint: string;
      resolvedProfile: { id: string; runtimeId?: string; model?: string };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(event.type, "execution-profile.resolved");
  assert.match(event.payload.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(event.payload.profileId, event.payload.resolvedProfile.id);
  assert.equal(event.payload.resolvedProfile.runtimeId, "codex");
  assert.equal(event.payload.resolvedProfile.model, "gpt-5");

  const loaded = await runnerFetch(
    "http://runner.invalid/v1/commands",
    profileGetCommand(event.payload.profileId),
  );
  const loadedEvent = await loaded.json() as {
    payload: { profile: { id: string; runtimeId?: string } };
  };
  assert.equal(loadedEvent.payload.profile.id, event.payload.profileId);
  assert.equal(loadedEvent.payload.profile.runtimeId, "codex");
});

test("Desktop run transport replaces a resolved profile ID with its exact inline profile", () => {
  const profile = {
    id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
    label: "Kestrel One",
    agent: "kestrel",
    sessionPrefix: "kestrel",
    runtimeId: "claude" as const,
    modelProvider: "anthropic" as const,
    model: "claude-sonnet",
    defaultInteractionMode: "build" as const,
  };
  const command = parseRunnerCommandV2({
    id: "run-command",
    type: "run.start",
    payload: {
      profileId: profile.id,
      turn: {
        sessionId: "thread-1",
        runtimeId: "claude",
        runtimeBindingId: "binding-1",
        runtimeBindingStatus: "ready",
        runtimeNativeSessionState: "uninitialized",
        participantId: "runtime:claude",
        message: "hello",
        eventType: "user.message",
      },
    },
    metadata: {
      tenantId: organizationId,
      actor: {
        actorId: actorUserId,
        actorType: "end_user",
        tenantId: organizationId,
      },
    },
  });
  assert.equal(command.type, "run.start");
  const materialized = materializeDesktopRunStartProfile(
    command,
    new Map([[profile.id, profile]]),
  );

  assert.equal(materialized.payload.profileId, undefined);
  assert.deepEqual(materialized.payload.profile, profile);
  assert.equal(materialized.payload.turn.runtimeId, "claude");
});
