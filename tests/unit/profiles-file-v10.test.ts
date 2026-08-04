import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fingerprintProfilesFileV10,
  parseProfilesFileV10,
  prepareProfilesFileV10Migration,
  serializeProfilesFileV10,
  writeProfilesFileV10MigrationArtifacts,
} from "../../cli/config/ProfilesFileV10.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG } from "../../src/code/contracts.js";

function v9Source(): string {
  return `${JSON.stringify(
    {
      version: 9,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          shellKind: "cli",
          presetId: "cli_dev_local",
          capabilityPacks: ["balanced", "filesystem", "dev_shell"],
          approvalPolicyPackId: "dev",
          toolAllowlist: ["dev.shell.run", "fs.read_text"],
          mcpServers: [
            {
              id: "reference-docker",
              transport: "stdio",
              command: "docker",
              args: ["run", "reference-only"],
            },
          ],
          devShell: { enabled: true },
          default: true,
        },
        {
          id: "custom-embedder",
          label: "Custom Embedder",
          agent: "reference-react",
          sessionPrefix: "custom-embedder",
          shellKind: "cli",
          presetId: "cli_safe_local",
          capabilityPacks: ["balanced"],
          toolAllowlist: ["custom.tool"],
          default: false,
        },
      ],
      managedProfileOverlays: {
        "kestrel@cli_safe_local": {
          approvalPolicyPackId: "production",
          additionalToolNames: ["free.time.current"],
          toolQueue: { perRunConcurrency: 6, retryCount: 1 },
          codeMode: {
            ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG),
            sandbox: {
              ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox),
              workspaceSizeMb: 71,
              workspaceInodes: 9_001,
              tmpSizeMb: 37,
              tmpInodes: 2_501,
            },
          },
          reasoning: {
            request: { mode: "summary", effort: "high" },
            retention: { mode: "live_only", days: 7 },
          },
          delegationLimits: {
            maxConcurrentChildSessions: 3,
            maxDepth: 2,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

test("ProfilesFileV10 strictly contains one canonical profile and environment bindings", () => {
  const prepared = prepareProfilesFileV10Migration({ raw: v9Source() });
  const parsed = parseProfilesFileV10(
    serializeProfilesFileV10(prepared.profilesFile),
  );

  assert.equal(parsed.version, 10);
  assert.equal(parsed.profile.id, "kestrel");
  assert.equal(parsed.profile.reasoning.request.mode, "summary");
  assert.equal(
    parsed.profile.delegation.maxConcurrentChildSessions,
    3,
  );
  assert.deepEqual(Object.keys(parsed.environmentBindings), [
    "cli_safe_local",
  ]);
  assert.equal(
    parsed.environmentBindings.cli_safe_local?.approvals.policyPackId,
    "production",
  );
  assert.deepEqual(
    parsed.environmentBindings.cli_safe_local?.tools.additionalToolNames,
    ["free.time.current"],
  );
  assert.match(fingerprintProfilesFileV10(parsed), /^sha256:[0-9a-f]{64}$/u);
  assert.equal("profiles" in parsed, false);
  assert.throws(
    () =>
      parseProfilesFileV10(
        JSON.stringify({ ...parsed, profiles: [] }),
      ),
    /unsupported field 'profiles'/u,
  );
  assert.throws(
    () =>
      parseProfilesFileV10(
        JSON.stringify({
          ...parsed,
          environmentBindings: {
            ...parsed.environmentBindings,
            unknown: parsed.environmentBindings.cli_safe_local,
          },
        }),
      ),
    /unsupported key 'unknown'/u,
  );
});

test("V9 migration excludes reference and custom authority instead of merging it", () => {
  const prepared = prepareProfilesFileV10Migration({ raw: v9Source() });
  const safe = prepared.profilesFile.environmentBindings.cli_safe_local;

  assert.deepEqual(prepared.report.omittedProfileIds, [
    "custom-embedder",
    "reference",
  ]);
  assert.deepEqual(
    prepared.report.omittedAuthorityFields.find(
      (entry) => entry.profileId === "reference",
    )?.fields,
    [
      "approvalPolicyPackId",
      "devShell",
      "mcpServers",
      "toolAllowlist",
    ],
  );
  assert.equal(
    safe?.tools.additionalToolNames.includes("dev.shell.run"),
    false,
  );
  assert.equal(
    safe?.tools.mcpServers.some((server) => server.id === "reference-docker"),
    false,
  );
  assert.equal(safe?.sandbox.devShell, undefined);
  assert.equal(safe?.sandbox.codeMode?.sandbox.workspaceSizeMb, 71);
  assert.equal(safe?.sandbox.codeMode?.sandbox.workspaceInodes, 9_001);
  assert.equal(safe?.sandbox.codeMode?.sandbox.tmpSizeMb, 37);
  assert.equal(safe?.sandbox.codeMode?.sandbox.tmpInodes, 2_501);
  assert.equal(
    prepared.report.retainedManagedFields.includes(
      "cli_safe_local.additionalToolNames",
    ),
    true,
  );
});

test("inactive migration preserves exact source bytes and fails on backup collision", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profiles-v10-"),
  );
  const profilePath = path.join(tempDir, "profiles.json");
  const source = v9Source();
  const prepared = prepareProfilesFileV10Migration({
    raw: source,
    profilePath,
  });

  await writeProfilesFileV10MigrationArtifacts(prepared);
  assert.equal(await readFile(prepared.backupPath, "utf8"), source);
  const report = JSON.parse(await readFile(prepared.reportPath, "utf8")) as {
    sourceDigest: string;
    backupPath: string;
  };
  assert.equal(report.sourceDigest, prepared.report.sourceDigest);
  assert.equal(report.backupPath, prepared.backupPath);
  await writeProfilesFileV10MigrationArtifacts(prepared);

  await writeFile(prepared.backupPath, "different bytes", "utf8");
  await assert.rejects(
    writeProfilesFileV10MigrationArtifacts(prepared),
    /Refusing to overwrite profiles migration backup/u,
  );
});

test("PR1 leaves ProfileStore runtime persistence on V9", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profiles-v10-inactive-"),
  );
  const store = new ProfileStore(tempDir);
  await store.load();
  const persisted = JSON.parse(
    await readFile(path.join(tempDir, "profiles.json"), "utf8"),
  ) as { version: number; profiles: unknown[] };

  assert.equal(persisted.version, 9);
  assert.equal(Array.isArray(persisted.profiles), true);
});

test("legacy managed kestrel-one IDs migrate to the canonical definition", () => {
  const raw = JSON.stringify({
    version: 4,
    profiles: [
      {
        id: "kestrel-one",
        label: "Kestrel One",
        agent: "reference-react",
        sessionPrefix: "kestrel-one",
        shellKind: "cli",
        presetId: "cli_safe_local",
        capabilityPacks: ["balanced", "filesystem", "sandbox_code"],
        modelProvider: "openai",
        model: "gpt-5.1",
        modelCapabilities: { visionInputEnabled: false },
        default: false,
      },
    ],
  });

  const prepared = prepareProfilesFileV10Migration({ raw });
  assert.equal(prepared.profilesFile.profile.id, "kestrel");
  assert.equal(
    prepared.profilesFile.environmentBindings.cli_safe_local?.modelRoute.kind,
    "pinned",
  );
  assert.deepEqual(prepared.report.omittedProfileIds, []);
});

test("inactive migration accepts every supported V2 through V9 source", () => {
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9] as const) {
    const raw = JSON.stringify({
      version,
      profiles: [
        {
          id: `custom-${version}`,
          label: "Custom",
          agent: "reference-react",
          sessionPrefix: "custom",
          default: true,
        },
      ],
      ...(version >= 5 ? { managedProfileOverlays: {} } : {}),
    });
    const prepared = prepareProfilesFileV10Migration({ raw });
    assert.equal(prepared.report.sourceVersion, version);
    assert.equal(prepared.profilesFile.profile.id, "kestrel");
    assert.equal(
      prepared.profilesFile.environmentBindings.cli_safe_local?.presetId,
      "cli_safe_local",
    );
  }
});
