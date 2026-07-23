import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { composeKestrelOneProfile } from "../../src/profile/kestrelOnePolicy.js";
import { LocalCoreExecutionProfileRegistry } from "../../src/localCore/executionProfileRegistry.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "Local Core execution profile registry is deterministic and survives restart", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-execution-profile-registry-"),
  );
  const profile = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    overlay: { additionalToolNames: ["free.weather.current"] },
  }).profile;
  const firstRegistry = new LocalCoreExecutionProfileRegistry(home);
  const first = await firstRegistry.register(profile, "desktop_dev_local");
  const second = await firstRegistry.register(profile, "desktop_dev_local");
  const reloaded = await new LocalCoreExecutionProfileRegistry(home).get(
    first.profileId,
  );

  assert.equal(first.profileId, second.profileId);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(reloaded, first.profile);
  assert.match(
    first.profileId,
    /^kestrel-one:desktop_dev_local:[a-f0-9]{64}$/u,
  );
  assert.equal(
    (
      JSON.parse(
        await readFile(
          path.join(home, "runtime", "execution-profiles.json"),
          "utf8",
        ),
      ) as { profiles: unknown[] }
    ).profiles.length,
    1,
  );
});

contractTest("runtime.hermetic", "Local Core execution profile registry invalidates immutable selection revisions", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-execution-profile-revisions-"),
  );
  const profile = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
  }).profile;
  const registry = new LocalCoreExecutionProfileRegistry(home);
  const first = await registry.register(profile, "desktop_dev_local", {
    policy: { id: "kestrel-one", version: 1 },
    environmentPreset: { id: "desktop_dev_local", version: 1 },
    modelConfiguration: { id: "desktop-default", revision: 1 },
    integrationContracts: [{ id: "github", revision: 1 }],
  });
  const repeated = await registry.register(profile, "desktop_dev_local", {
    policy: { id: "kestrel-one", version: 1 },
    environmentPreset: { id: "desktop_dev_local", version: 1 },
    modelConfiguration: { id: "desktop-default", revision: 1 },
    integrationContracts: [{ id: "github", revision: 1 }],
  });
  const modelRevision = await registry.register(
    profile,
    "desktop_dev_local",
    {
      policy: { id: "kestrel-one", version: 1 },
      environmentPreset: { id: "desktop_dev_local", version: 1 },
      modelConfiguration: { id: "desktop-default", revision: 2 },
      integrationContracts: [{ id: "github", revision: 1 }],
    },
  );
  const integrationRevision = await registry.register(
    profile,
    "desktop_dev_local",
    {
      policy: { id: "kestrel-one", version: 1 },
      environmentPreset: { id: "desktop_dev_local", version: 1 },
      modelConfiguration: { id: "desktop-default", revision: 1 },
      integrationContracts: [{ id: "github", revision: 2 }],
    },
  );

  assert.equal(first.profileId, repeated.profileId);
  assert.notEqual(first.profileId, modelRevision.profileId);
  assert.notEqual(first.profileId, integrationRevision.profileId);
});

contractTest("runtime.hermetic", "Local Core execution profile registry rejects secret material", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-execution-profile-secret-"),
  );
  const profile = composeKestrelOneProfile({
    environmentPresetId: "cli_dev_local",
  }).profile;
  await assert.rejects(
    () =>
      new LocalCoreExecutionProfileRegistry(home).register(
        {
          ...profile,
          modelCapabilities: {
            ...profile.modelCapabilities,
            apiKey: "secret",
          } as never,
        },
        "cli_dev_local",
      ),
    /cannot contain secret material/u,
  );
});

contractTest("runtime.hermetic", "Local Core execution profile registry serializes concurrent registrations", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-execution-profile-concurrent-"),
  );
  const registry = new LocalCoreExecutionProfileRegistry(home);
  const firstProfile = composeKestrelOneProfile({
    environmentPresetId: "cli_dev_local",
    overlay: { model: "model-a" },
  }).profile;
  const secondProfile = composeKestrelOneProfile({
    environmentPresetId: "cli_dev_local",
    overlay: { model: "model-b" },
  }).profile;

  const [first, duplicate, second] = await Promise.all([
    registry.register(firstProfile, "cli_dev_local"),
    new LocalCoreExecutionProfileRegistry(home).register(
      firstProfile,
      "cli_dev_local",
    ),
    new LocalCoreExecutionProfileRegistry(home).register(
      secondProfile,
      "cli_dev_local",
    ),
  ]);

  assert.equal(first.profileId, duplicate.profileId);
  assert.notEqual(first.profileId, second.profileId);
  assert.deepEqual(
    (await registry.list()).map((profile) => profile.id).sort(),
    [first.profileId, second.profileId].sort(),
  );
});
