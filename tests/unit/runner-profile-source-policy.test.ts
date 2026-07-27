import assert from "node:assert/strict";

import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import type { RunnerEventSink } from "../../cli/runner/EventWriter.js";
import { contractTest } from "../helpers/contract-test.js";

const writer: RunnerEventSink = {
  emit() {},
};

contractTest("runtime.hermetic", "registered-only RunnerHost rejects inline profiles", async () => {
  const host = new RunnerHost(
    writer,
    () => {
      throw new Error("runtime must not be created");
    },
    {
      async listProfiles() {
        return [];
      },
      async getProfile() {
        return undefined;
      },
    },
    { profileSourcePolicy: "registered-only" },
  );
  await assert.rejects(
    () =>
      host.runStart("inline-profile-command", {
        profile: {
          id: "reference",
          label: "Reference",
          agent: "reference-react",
          sessionPrefix: "reference",
        },
        turn: {
          sessionId: "session-inline-profile",
          message: "must be rejected",
          eventType: "user.message",
        },
      }),
    /inline profiles are not accepted/u,
  );
  await host.close();
});

contractTest("runtime.hermetic", "RunnerHost emits execution profile resolution from provider", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const host = new RunnerHost(
    {
      emit(type, payload) {
        events.push({ type, payload });
      },
    },
    () => {
      throw new Error("runtime must not be created");
    },
    {
      async listProfiles() {
        return [];
      },
      async getProfile() {
        return undefined;
      },
      async resolveExecutionProfile(payload) {
        assert.equal(payload.environmentPresetId, "workspace_hosted");
        return {
          version: 1,
          profileId: `kestrel:workspace_hosted:${"a".repeat(64)}`,
          fingerprint: "a".repeat(64),
          policy: { id: "kestrel", version: 2 },
          environmentPreset: { id: "workspace_hosted", version: 1 },
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react",
            sessionPrefix: "kestrel",
            agentProfileId: "kestrel",
          },
        };
      },
    },
    { profileSourcePolicy: "registered-only" },
  );

  await host.executionProfileResolve("resolve-command", {
    environmentPresetId: "workspace_hosted",
  });

  assert.equal(events[0]?.type, "execution-profile.resolved");
  assert.equal(
    (events[0]?.payload as { profileId?: string } | undefined)?.profileId,
    `kestrel:workspace_hosted:${"a".repeat(64)}`,
  );
  await host.close();
});

contractTest("runtime.hermetic", "registered-only RunnerHost rejects mutable profile ids before lookup", async () => {
  let lookups = 0;
  const host = new RunnerHost(
    writer,
    () => {
      throw new Error("runtime must not be created");
    },
    {
      async listProfiles() {
        return [];
      },
      async getProfile() {
        lookups += 1;
        return undefined;
      },
    },
    { profileSourcePolicy: "registered-only" },
  );
  await assert.rejects(
    () =>
      host.runStart("mutable-profile-command", {
        profileId: "kestrel",
        turn: {
          sessionId: "session-mutable-profile",
          message: "must be rejected",
          eventType: "user.message",
        },
      }),
    /not an immutable Local Core execution profile reference/u,
  );
  assert.equal(lookups, 0);
  await host.close();
});
