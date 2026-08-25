import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import type { RunnerEventSink } from "../../cli/runner/EventWriter.js";
import { KESTREL_HARNESS_ECONOMICS } from "../../src/profile/kestrelOnePolicy.js";

const writer: RunnerEventSink = {
  emit() {},
};

test("registered-only RunnerHost rejects inline profiles", async () => {
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

test("RunnerHost emits execution profile resolution from provider", async () => {
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
          policy: { id: "kestrel", version: 3 },
          environmentPreset: { id: "workspace_hosted", version: 1 },
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react",
            sessionPrefix: "kestrel",
            agentProfileId: "kestrel",
            modelProvider: "openrouter",
            model: "openai/gpt-5.6-luna",
            agentStageConfig: {
              modelByStage: { "agent.loop": "openai/gpt-5.6-luna" },
            },
            harnessEconomics: structuredClone(KESTREL_HARNESS_ECONOMICS),
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

test("RunnerHost loads an exact persisted effect result without creating a runtime", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  let runtimeCreations = 0;
  const host = new RunnerHost(
    { emit(type, payload) { events.push({ type, payload }); } },
    () => { runtimeCreations += 1; throw new Error("runtime must not be created"); },
    { async listProfiles() { return []; }, async getProfile() { return undefined; } },
    {
      exactEffectResultStore: {
        async readExactEffectResult(input) {
          assert.deepEqual(input, { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1", tenantId: "tenant-1" });
          return { status: "found", result: { version: "v2", toolCallId: "call-1" } as never };
        },
        async claimExactEffectCancellation() { return { status: "not_found" }; },
      },
      exactEffectResultTenantId: "tenant-1",
    },
  );
  await host.effectResultGet("command-1", { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" }, { tenantId: "tenant-1", actor: { actorId: "operator-1", actorType: "operator", tenantId: "tenant-1" } });
  assert.equal(runtimeCreations, 0);
  assert.deepEqual(events, [{ type: "effect.result.loaded", payload: { version: 1, sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1", result: { version: "v2", toolCallId: "call-1" } } }]);
  await host.close();
});

test("RunnerHost rejects exact effect result lookup outside trusted tenant authority", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  let reads = 0;
  const host = new RunnerHost(
    { emit(type, payload) { events.push({ type, payload }); } },
    () => { throw new Error("runtime must not be created"); },
    { async listProfiles() { return []; }, async getProfile() { return undefined; } },
    {
      exactEffectResultStore: {
        async readExactEffectResult() { reads += 1; return { status: "not_found" }; },
        async claimExactEffectCancellation() { return { status: "not_found" }; },
      },
      exactEffectResultTenantId: "tenant-1",
    },
  );
  await host.effectResultGet("command-1", { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" }, { tenantId: "tenant-2", actor: { actorId: "operator-2", actorType: "operator", tenantId: "tenant-2" } });
  assert.equal(reads, 0);
  assert.deepEqual(events, [{ type: "runner.error", payload: { code: "RUNNER_FORBIDDEN", message: "Exact effect result lookup is not authorized for this tenant." } }]);
  await host.close();
});

test("RunnerHost rejects a hosted provider result without immutable economics", async () => {
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
      async resolveExecutionProfile() {
        return {
          version: 1 as const,
          profileId: `kestrel:workspace_hosted:${"f".repeat(64)}`,
          fingerprint: "f".repeat(64),
          policy: { id: "kestrel", version: 3 },
          environmentPreset: { id: "workspace_hosted" as const, version: 1 },
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"f".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react" as const,
            sessionPrefix: "kestrel",
            agentProfileId: "kestrel",
            modelProvider: "openrouter" as const,
            model: "openai/gpt-5.6-luna",
            agentStageConfig: {
              modelByStage: { "agent.loop": "openai/gpt-5.6-luna" },
            },
          },
        };
      },
    },
    { profileSourcePolicy: "registered-only" },
  );

  await assert.rejects(
    () =>
      host.executionProfileResolve("resolve-missing-economics", {
        environmentPresetId: "workspace_hosted",
      }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
  );
  await host.close();
});

test("default RunnerHost loads the immutable profile it resolves", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runner-profile-"));
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
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
  );

  try {
    await host.executionProfileResolve("resolve-default-profile", {
      environmentPresetId: "workspace_hosted",
      managedConfiguration: {
        modelProvider: "openrouter",
        model: "openai/gpt-5.6-luna",
      },
    });
    const resolved = events[0]?.payload as { profileId?: string } | undefined;
    assert.equal(events[0]?.type, "execution-profile.resolved");
    assert.match(resolved?.profileId ?? "", /^kestrel:workspace_hosted:[a-f0-9]{64}$/u);

    await host.profileGet("load-default-profile", {
      profileId: resolved!.profileId!,
    });
    assert.equal(events[1]?.type, "profile.loaded");
  } finally {
    await host.close();
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("default RunnerHost resolves arbitrary Desktop-local models without hosted economics admission", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-runner-local-profile-"),
  );
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
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
  );

  try {
    await host.executionProfileResolve("resolve-desktop-local-profile", {
      environmentPresetId: "desktop_safe_local",
      managedConfiguration: {
        modelProvider: "ollama",
        model: "private/local-model:latest",
        agentStageConfig: {
          modelByStage: { "agent.loop": "private/local-model:latest" },
        },
      },
    });
    const resolved = events[0]?.payload as
      | {
          environmentPreset?: { id?: string };
          resolvedProfile?: {
            modelProvider?: string;
            model?: string;
          };
        }
      | undefined;

    assert.equal(events[0]?.type, "execution-profile.resolved");
    assert.equal(resolved?.environmentPreset?.id, "desktop_safe_local");
    assert.equal(resolved?.resolvedProfile?.modelProvider, "ollama");
    assert.equal(
      resolved?.resolvedProfile?.model,
      "private/local-model:latest",
    );
  } finally {
    await host.close();
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("default RunnerHost rejects hosted stage and credential routes that bypass the admitted model", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-runner-hosted-route-preflight-"),
  );
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  const host = new RunnerHost(
    writer,
    () => {
      throw new Error("runtime must not be created");
    },
  );
  const baseManagedConfiguration = {
    modelProvider: "openrouter" as const,
    model: "openai/gpt-5.6-luna",
  };

  try {
    for (const input of [
      {
        managedConfiguration: {
          ...baseManagedConfiguration,
          agentStageConfig: {
            modelByStage: {
              "agent.loop": "openai/gpt-5.6-luna-unprofiled",
            },
          },
        },
        reason: "agent_loop_model_mismatch",
      },
      {
        managedConfiguration: {
          ...baseManagedConfiguration,
          agentStageConfig: {
            modelByStage: { "agent.loop": "openai/gpt-5.6-luna" },
          },
          modelCredential: {
            source: "kestrel-one" as const,
            runId: "run-1",
            gatewayId: "gateway-1",
            organizationId: "org-1",
            environmentId: "env-1",
            rawModelId: "openai/gpt-5.6-luna-unprofiled",
            provider: "openrouter" as const,
          },
        },
        reason: "model_credential_route_mismatch",
      },
    ]) {
      await assert.rejects(
        () =>
          host.executionProfileResolve(`resolve-${input.reason}`, {
            environmentPresetId: "workspace_hosted",
            managedConfiguration: input.managedConfiguration,
          }),
        (error: unknown) => {
          const failure = error as {
            code?: string;
            details?: Record<string, unknown>;
          };
          assert.equal(
            failure.code,
            "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
          );
          assert.equal(failure.details?.reason, input.reason);
          return true;
        },
      );
    }
  } finally {
    await host.close();
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("registered-only RunnerHost rejects mutable profile ids before lookup", async () => {
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
