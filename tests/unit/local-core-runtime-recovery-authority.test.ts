import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseLocalCoreRuntimeRecoveryForkRequest } from "../../src/localCore/contracts.js";
import { writeLocalCoreLocalSettings } from "../../src/localCore/localSettings.js";
import { resolveLocalCoreRecoveryExecutionSelection } from "../../src/localCore/profileProvider.js";
import { createDefaultLocalCoreRuntimeConfiguration } from "../../src/localCore/runtimeConfiguration.js";

test("Local Core recovery accepts renderer intent only and rejects forged readiness proof", () => {
  const intent = {
    sourceCanonicalThreadId: "thread-main:source",
    targetCanonicalThreadId: "thread-main:fork",
    targetRunnerSessionId: "fork-session",
    targetRuntimeId: "claude",
    lossCode: "RUNTIME_LIVE_WAIT_LOST",
  } as const;
  assert.deepEqual(parseLocalCoreRuntimeRecoveryForkRequest(intent), intent);
  assert.throws(
    () => parseLocalCoreRuntimeRecoveryForkRequest({
      ...intent,
      targetCapabilityDigest: "renderer-forged-digest",
      targetModelProvider: "untrusted-provider",
      targetModelId: "untrusted-model",
    }),
    /unsupported field/u,
  );
});

test("Local Core derives recovery model selection from current server configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-recovery-authority-"));
  const runtimeConfiguration = createDefaultLocalCoreRuntimeConfiguration();
  const route = {
    version: 1 as const,
    provider: "anthropic" as const,
    model: "claude-test-model",
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: true },
  };
  try {
    await writeLocalCoreLocalSettings(home, {
      modelConfigurations: [{
        id: "server-owned-model",
        name: "Server owned model",
        currentRevision: 2,
        revisions: [
          { revision: 1, createdAt: "2026-01-01T00:00:00.000Z", policy: route },
          {
            revision: 2,
            createdAt: "2026-01-02T00:00:00.000Z",
            policy: { ...route, model: "new-model" },
          },
        ],
      }],
    });
    assert.deepEqual(
      await resolveLocalCoreRecoveryExecutionSelection(
        home,
        {
          runtimeId: "claude",
          modelProvider: route.provider,
          model: route.model,
        },
        { runtimeConfiguration },
      ),
      {
        runtimeId: "claude",
        modelConfiguration: { id: "server-owned-model", revision: 1 },
        apps: [],
      },
    );

    await writeLocalCoreLocalSettings(home, {
      modelConfigurations: [{
        id: "server-owned-model",
        name: "Server owned model",
        currentRevision: 2,
        archivedAt: "2026-01-03T00:00:00.000Z",
        revisions: [
          { revision: 1, createdAt: "2026-01-01T00:00:00.000Z", policy: route },
          {
            revision: 2,
            createdAt: "2026-01-02T00:00:00.000Z",
            policy: { ...route, model: "new-model" },
          },
        ],
      }],
    });
    await assert.rejects(
      resolveLocalCoreRecoveryExecutionSelection(
        home,
        {
          runtimeId: "claude",
          modelProvider: route.provider,
          model: route.model,
        },
        { runtimeConfiguration },
      ),
      /no longer configured/u,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
