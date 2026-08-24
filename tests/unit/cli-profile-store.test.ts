import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyProfileDefaults,
  parseKestrelManagedConfiguration,
  parseProfilesFile,
  ProfileStore,
} from "../../cli/config/ProfileStore.js";
import { MODEL_POLICY_FILE_NAME } from "../../src/profile/modelPolicy.js";
import { FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";
import { fingerprintResolvedProfile } from "../../src/profile/kestrelOnePolicy.js";
import { reconstructLegacySandboxCapabilityTuiProfile, resolveSandboxCapabilityCompatibilityFingerprints } from "../../cli/runtime/KestrelChatRuntime.js";
import { fingerprintSandboxCapabilityCatalogV1, fingerprintSandboxCapabilityCatalogV2 } from "../../src/kestrel/contracts/sandbox-capability.js";

test("ProfileStore bootstraps default profile when file is missing", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-"),
  );
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const profileIds = profiles.map((profile) => profile.id);

  assert.deepEqual(profileIds, ["kestrel"]);
  assert.equal(profiles[0]?.agent, "kestrel");
  assert.equal(profiles[0]?.shellKind, "cli");
  assert.equal(profiles[0]?.presetId, "cli_safe_local");
  assert.deepEqual(profiles[0]?.capabilityPacks, [
    "balanced",
    "filesystem",
    "sandbox_code",
  ]);
  assert.equal(profiles[0]?.guardrails?.maxStepVisits, 80);
  assert.equal(profiles[0]?.toolQueue?.perRunConcurrency, 8);
  assert.equal(profiles[0]?.toolQueue?.globalConcurrency, 24);
  assert.equal(profiles[0]?.codeMode?.enabled, true);
  assert.equal(profiles[0]?.devShell?.enabled, false);
  assert.equal(profiles[0]?.codeMode?.sandbox.executor, "docker");
  assert.equal(profiles[0]?.toolAllowlist?.includes("code.execute"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), false);
  assert.equal(
    profiles[0]?.toolAllowlist?.includes("dev.process.write"),
    false,
  );
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.start"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.input"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.status"), false);
  for (const toolName of FILESYSTEM_TOOL_NAMES.filter(
    (toolName) =>
      toolName !== "fs.write_text" && toolName !== "fs.replace_text",
  )) {
    assert.equal(profiles[0]?.toolAllowlist?.includes(toolName), true);
  }
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.write_text"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.replace_text"), false);

  const persisted = JSON.parse(
    await readFile(path.join(tempDir, "profiles.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(persisted.version, 10);
  assert.equal("profiles" in persisted, false);
});

test("ordinary profile parsing canonicalizes legacy sandbox authoring to V2 before fingerprinting", () => {
  const capability = { version: 1, capabilityId: "tavily.search.read", operations: ["search"], resource: "https://api.tavily.com/search", audience: { tenantId: "tenant-a", environmentId: "env-a" }, maxRequests: 1, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "broker-a", revision: "r1" } };
  const raw = JSON.stringify({ version: 9, profiles: [{ id: "cap-profile", label: "Cap", sessionPrefix: "cap", agent: "kestrel", shellKind: "cli", codeMode: { enabled: true, capabilities: [capability] } }] });
  const parsed = parseProfilesFile(raw).profiles[0]!;
  const canonical = parsed.codeMode?.capabilities?.[0];
  assert.equal(canonical?.version, 2);
  assert.equal(canonical?.version === 2 ? canonical.effectClass : undefined, "read_only");
  assert.deepEqual(canonical?.version === 2 ? canonical.adapterConfig : undefined, { maxQueryChars: 100, maxResults: 3 });
  assert.ok(canonical?.version === 2);
  assert.notEqual(fingerprintResolvedProfile(parsed), fingerprintResolvedProfile({ ...parsed, codeMode: { ...parsed.codeMode!, capabilities: [{ ...canonical, adapterConfig: { maxQueryChars: 100, maxResults: 2 } }] } } as never));
  const legacy = reconstructLegacySandboxCapabilityTuiProfile(parsed);
  assert.ok(legacy);
  assert.equal(fingerprintResolvedProfile(legacy), "5e6cb22948471d8d9ea1163c5555edb1179d2e2a2427c2700fb69813901532f4");
  assert.equal(fingerprintSandboxCapabilityCatalogV1(legacy.codeMode?.capabilities ?? []), "c105064885a0b6bf870e00306bfd340601ab9a44772d9ee6d7b4ed2879a74325");
  assert.deepEqual(resolveSandboxCapabilityCompatibilityFingerprints(parsed), {
    profileFingerprint: fingerprintResolvedProfile(parsed),
    capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV2(parsed.codeMode?.capabilities ?? []),
    legacyProfileFingerprint: "5e6cb22948471d8d9ea1163c5555edb1179d2e2a2427c2700fb69813901532f4",
    legacyCapabilityCatalogFingerprint: "c105064885a0b6bf870e00306bfd340601ab9a44772d9ee6d7b4ed2879a74325",
  });
  const rawV1Profile = { ...parsed, codeMode: { ...parsed.codeMode!, capabilities: [capability] } } as never;
  assert.deepEqual(resolveSandboxCapabilityCompatibilityFingerprints(rawV1Profile), {
    profileFingerprint: fingerprintResolvedProfile(rawV1Profile),
    capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV2([capability]),
    legacyProfileFingerprint: "5e6cb22948471d8d9ea1163c5555edb1179d2e2a2427c2700fb69813901532f4",
    legacyCapabilityCatalogFingerprint: "c105064885a0b6bf870e00306bfd340601ab9a44772d9ee6d7b4ed2879a74325",
  });
  assert.equal(reconstructLegacySandboxCapabilityTuiProfile({ ...parsed, codeMode: { ...parsed.codeMode!, capabilities: [{ ...canonical, effectClass: "external_effect" }] } } as never), undefined);
});

test("ProfileStore v9 migrates only generated local profiles and emits the isolation notice once", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-safe-migration-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 6,
        profiles: [
          {
            id: "reference",
            label: "Reference React",
            agent: "reference-react",
            sessionPrefix: "reference",
            shellKind: "cli",
            presetId: "cli_dev_local",
            capabilityPacks: ["balanced", "filesystem", "dev_shell"],
            modeSystemV2Enabled: true,
            default: true,
          },
          {
            id: "custom-developer",
            label: "Custom Developer",
            agent: "reference-react",
            sessionPrefix: "custom-developer",
            shellKind: "cli",
            presetId: "cli_dev_local",
            capabilityPacks: ["balanced", "filesystem", "dev_shell"],
            modeSystemV2Enabled: true,
            default: false,
          },
        ],
        managedProfileOverlays: {
          "kestrel@cli_dev_local": {
            approvalPolicyPackId: "isolated_code",
            theme: { brandAlt: "#123456" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new ProfileStore(tempDir);

  const first = await store.load();
  const reference = first.find((profile) => profile.id === "reference");
  const custom = first.find((profile) => profile.id === "custom-developer");
  const managed = first.find((profile) => profile.id === "kestrel");

  assert.equal(reference, undefined);
  assert.equal(custom, undefined);
  assert.equal(managed?.presetId, "cli_safe_local");
  assert.equal(managed?.approvalPolicyPackId, "isolated_code");
  assert.equal(managed?.theme, undefined);
  assert.deepEqual(store.consumeLoadNotices(), [
    "Migrated profiles.json V6 to the canonical Kestrel profile.",
  ]);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.version, 10);
  assert.equal(
    persisted.environmentBindings.cli_safe_local.approvals.policyPackId,
    "isolated_code",
  );
  assert.equal(
    (await readFile(`${filePath}.v6.pre-v10.bak`, "utf8")).includes(
      '"version": 6',
    ),
    true,
  );
  const report = JSON.parse(
    await readFile(
      path.join(tempDir, "profiles.json.v10-migration-report.json"),
      "utf8",
    ),
  );
  assert.deepEqual(report.omittedProfileIds, ["custom-developer", "reference"]);

  await store.load();
  assert.deepEqual(store.consumeLoadNotices(), []);
});

test("ProfileStore omits V7 custom profile authority during the V10 cutover", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-v8-recovery-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  const sandboxQuotas = {
    workspaceSizeMb: 96,
    workspaceInodes: 12_000,
    tmpSizeMb: 48,
    tmpInodes: 4_000,
  };
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 7,
        profiles: [
          {
            id: "custom-v7",
            label: "Custom V7",
            agent: "reference-react",
            sessionPrefix: "custom-v7",
            codeMode: {
              enabled: true,
              sandbox: sandboxQuotas,
            },
          },
        ],
        managedProfileOverlays: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const profiles = await new ProfileStore(tempDir).load();
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["kestrel"],
  );

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    profile: { id: string };
  };
  assert.equal(persisted.version, 10);
  assert.equal(persisted.profile.id, "kestrel");
  assert.equal(
    (await readFile(`${filePath}.v7.pre-v10.bak`, "utf8")).includes(
      '"version": 7',
    ),
    true,
  );
  const report = JSON.parse(
    await readFile(
      path.join(tempDir, "profiles.json.v10-migration-report.json"),
      "utf8",
    ),
  );
  assert.deepEqual(report.omittedProfileIds, ["custom-v7"]);
});

test("ProfileStore omits V8 custom sandbox authority during the V10 cutover", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-v9-evaluation-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  const sandboxQuotas = {
    workspaceSizeMb: 128,
    workspaceInodes: 16_000,
    tmpSizeMb: 64,
    tmpInodes: 8_000,
  };
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 8,
        profiles: [
          {
            id: "custom-v8",
            label: "Custom V8",
            agent: "reference-react",
            sessionPrefix: "custom-v8",
            modelProvider: "openrouter",
            model: "z-ai/glm-5.2",
            codeMode: { enabled: true, sandbox: sandboxQuotas },
          },
        ],
        managedProfileOverlays: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const profiles = await new ProfileStore(tempDir).load();
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["kestrel"],
  );

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    profile: { id: string };
  };
  assert.equal(persisted.version, 10);
  assert.equal(persisted.profile.id, "kestrel");
  assert.equal(
    (await readFile(`${filePath}.v8.pre-v10.bak`, "utf8")).includes(
      '"version": 8',
    ),
    true,
  );
});

test("ProfileStore applies shared model policy when profiles.json is missing", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-policy-bootstrap-"),
  );
  const policyPath = path.join(tempDir, MODEL_POLICY_FILE_NAME);
  await writeFile(
    policyPath,
    `${JSON.stringify(
      {
        version: 1,
        provider: "openai",
        model: "gpt-5.4-2026-03-05",
        modelByStage: {
          "agent.loop": "gpt-5.4-mini",
        },
        modelTimeoutMs: 45_000,
        modelCapabilities: {
          visionInputEnabled: true,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();

  assert.equal(profiles[0]?.modelProvider, "openai");
  assert.equal(profiles[0]?.model, "gpt-5.4-2026-03-05");
  assert.deepEqual(profiles[0]?.agentStageConfig?.modelByStage, {
    "agent.loop": "gpt-5.4-mini",
  });
  assert.equal(profiles[0]?.modelTimeoutMs, 45_000);
  assert.equal(profiles[0]?.modelCapabilities?.visionInputEnabled, true);
});

test("ProfileStore keeps hosted tools out of the local Kestrel One policy", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-"),
  );
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel");

  assert.equal(
    kestrelOne?.toolAllowlist?.includes(
      "kestrel_one.search_knowledge_documents",
    ),
    false,
  );
  assert.equal(kestrelOne?.delegation?.allowAgentSpawn, true);
  assert.deepEqual(
    kestrelOne?.toolAllowlist?.filter(
      (toolName) =>
        toolName.startsWith("dialog.") ||
        toolName.startsWith("delegate.") ||
        toolName === "agent.spawn",
    ),
    ["dialog.open", "dialog.send", "dialog.close"],
  );
});

test("ProfileStore reconciles persisted Kestrel-One collaborator dialogs idempotently", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-dialogs-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 4,
        profiles: [
          {
            id: "reference",
            label: "Reference React",
            agent: "reference-react",
            sessionPrefix: "reference",
            delegation: {
              allowAgentSpawn: false,
              maxConcurrentChildSessions: 4,
              maxDepth: 3,
            },
          },
          {
            id: "kestrel-one",
            label: "Kestrel-One",
            agent: "reference-react",
            sessionPrefix: "kestrel-one",
            toolAllowlist: [
              "FinalizeAnswer",
              "agent.spawn",
              "delegate.spawn_child",
              "delegate.list_children",
              "delegate.get_child_result",
            ],
            delegation: {
              allowAgentSpawn: false,
              maxConcurrentChildSessions: 7,
              maxDepth: 1,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new ProfileStore(tempDir);

  const firstLoad = await store.load();
  const firstPersisted = await readFile(filePath, "utf8");
  const secondLoad = await store.load();
  const secondPersisted = await readFile(filePath, "utf8");
  const kestrelOne = secondLoad.find((profile) => profile.id === "kestrel");

  assert.equal(kestrelOne?.delegation?.allowAgentSpawn, true);
  assert.equal(kestrelOne?.delegation?.maxConcurrentChildSessions, 7);
  assert.equal(kestrelOne?.delegation?.maxDepth, 1);
  assert.deepEqual(
    kestrelOne?.toolAllowlist?.filter(
      (toolName) =>
        toolName.startsWith("dialog.") ||
        toolName.startsWith("delegate.") ||
        toolName === "agent.spawn",
    ),
    ["dialog.open", "dialog.send", "dialog.close"],
  );
  assert.deepEqual(firstLoad, secondLoad);
  assert.equal(firstPersisted, secondPersisted);
  assert.equal(JSON.parse(firstPersisted).version, 10);
  assert.equal("profiles" in JSON.parse(firstPersisted), false);
  assert.equal(
    (await readFile(`${filePath}.v4.pre-v10.bak`, "utf8")).includes(
      '"version": 4',
    ),
    true,
  );
});

test("ProfileStore does not keep legacy profile aliases selectable", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-legacy-alias-"),
  );
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();

  assert.equal(store.findById(profiles, "reference-openai"), undefined);
  assert.equal(store.findById(profiles, "reference-anthropic"), undefined);
  assert.equal(store.findById(profiles, "kestrel-one"), undefined);
  assert.equal(store.findById(profiles, "kestrel")?.id, "kestrel");
});

test("ProfileStore replaces legacy authored profiles with canonical Kestrel", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-kestrel-one-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          default: true,
          modeSystemV2Enabled: true,
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel");

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["kestrel"],
  );
  assert.equal(kestrelOne?.default, true);
  assert.deepEqual(
    kestrelOne?.toolAllowlist?.filter((name) => name.startsWith("dialog.")),
    ["dialog.open", "dialog.send", "dialog.close"],
  );

  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(saved.version, 10);
  assert.equal(saved.profile.id, "kestrel");
  assert.equal("profiles" in saved, false);
});

test("ProfileStore rejects conflicting behavior across legacy environment overlays", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-managed-only-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        version: 5,
        profiles: [],
        managedProfileOverlays: {
          "kestrel-one@cli_dev_local": {
            approvalPolicyPackId: "production",
            delegationLimits: {
              maxConcurrentChildSessions: 6,
              maxDepth: 1,
            },
            theme: {
              brandAlt: "#123456",
            },
          },
          "kestrel-one@workspace_hosted": {
            approvalPolicyPackId: "ci_bot",
            reasoning: {
              request: { mode: "summary", effort: "medium" },
              retention: { mode: "provider_visible", days: 5 },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    new ProfileStore(tempDir).load(),
    /managed Kestrel behavior differs across environment overlays/u,
  );
});

test("Kestrel managed configuration parser validates SDK supplied overlays", () => {
  const parsed = parseKestrelManagedConfiguration({
    label: "Kestrel One",
    modelProvider: "openai",
    model: "gpt-5.1",
    modelCredential: {
      source: "kestrel-one",
      runId: "run_123",
      gatewayId: "gateway_123",
      organizationId: "org_123",
      environmentId: "env_123",
      rawModelId: "gpt-5.1",
      provider: "openai",
    },
    modelCapabilities: { visionInputEnabled: true },
    modelEconomicsProfile: {
      version: 1,
      profileId: "openrouter:z-ai/glm-5.2:free:v1",
      provider: "openrouter",
      model: "z-ai/glm-5.2:free",
      contextWindowTokens: 202_752,
      maxOutputTokens: 65_536,
      counting: {
        counter: "utf8-byte-upper-bound",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
      cache: { behavior: "none" },
    },
    agentStageConfig: { modelByStage: { "agent.loop": "gpt-5.1" } },
    modelTimeoutMs: 120_000,
    storeDriver: "postgres",
    kestrelOneAppApprovalModes: {
      "kestrel_one.search_knowledge_documents": "auto",
    },
    kestrelOneAppApprovalPolicies: {
      "kestrel_one.search_knowledge_documents": {
        environment: "auto",
        project: "ask",
        minimum: "auto",
      },
    },
    additionalToolNames: ["kestrel_one.search_knowledge_documents"],
    reasoning: {
      request: { mode: "summary", effort: "high" },
      retention: { mode: "provider_visible", days: 7 },
    },
    default: false,
  });

  assert.equal(parsed.modelProvider, "openai");
  assert.equal(parsed.modelCredential?.gatewayId, "gateway_123");
  assert.equal(parsed.modelCapabilities?.visionInputEnabled, true);
  assert.equal(parsed.modelEconomicsProfile?.model, "z-ai/glm-5.2:free");
  assert.equal(
    parsed.kestrelOneAppApprovalModes?.[
      "kestrel_one.search_knowledge_documents"
    ],
    "auto",
  );
  assert.deepEqual(
    parsed.kestrelOneAppApprovalPolicies?.[
      "kestrel_one.search_knowledge_documents"
    ],
    { environment: "auto", project: "ask", minimum: "auto" },
  );
  assert.throws(
    () =>
      parseKestrelManagedConfiguration({
        additionalToolNames: "kestrel_one.search_knowledge_documents",
      }),
    /additionalToolNames must be an array of strings/u,
  );
  assert.throws(
    () =>
      parseKestrelManagedConfiguration({
        harnessEconomics: { policy: {} },
      }),
    /unsupported field 'harnessEconomics'/u,
  );
});

test("ProfileStore never persists transient gateway credential references", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-managed-credential-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          modelProvider: "openrouter",
          model: "z-ai/glm-5.2",
          modelCredential: {
            source: "kestrel-one",
            runId: "run-active",
            organizationId: "org-acme",
            environmentId: "env-production",
            gatewayId: "gateway-openrouter",
            rawModelId: "z-ai/glm-5.2",
            provider: "openrouter",
          },
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["kestrel"],
  );
  assert.equal(profiles[0]?.modelCredential, undefined);

  const persisted = await readFile(filePath, "utf8");
  assert.equal(persisted.includes("modelCredential"), false);
  assert.equal(JSON.parse(persisted).version, 10);
});

test("parseProfilesFile validates profile shape", () => {
  assert.throws(() => {
    parseProfilesFile(JSON.stringify({ version: 2, profiles: [{ id: "x" }] }));
  }, /Profile field/);
});

test("ProfileStore rejects unsupported agent", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-invalid-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      profiles: [
        {
          id: "bad",
          label: "Bad",
          agent: "not-real",
          sessionPrefix: "bad",
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  await assert.rejects(() => store.load(), /Unsupported profile agent/);
});

test("ProfileStore backfills guardrail defaults for existing profiles", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-backfill-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          toolAllowlist: ["FinalizeAnswer"],
          default: true,
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();

  assert.equal(profiles[0]?.guardrails?.maxStepVisits, 80);
  assert.equal(profiles[0]?.shellKind, "cli");
  assert.equal(profiles[0]?.presetId, "cli_safe_local");
  assert.equal(profiles[0]?.capabilityPacks?.includes("filesystem"), true);
  assert.equal(
    profiles[0]?.toolAllowlist?.includes("free.weather.forecast"),
    true,
  );
  assert.equal(profiles[0]?.toolAllowlist?.includes("FinalizeAnswer"), true);
  assert.equal(profiles[0]?.toolQueue?.checkpointSize, 10);
  assert.equal(profiles[0]?.toolQueue?.retryCount, 1);
  assert.equal(profiles[0]?.codeMode?.enabled, true);
  assert.equal(profiles[0]?.devShell?.enabled, false);
  assert.equal(profiles[0]?.modeSystemV2Enabled, true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("code.execute"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), false);
  assert.equal(
    profiles[0]?.toolAllowlist?.includes("dev.process.write"),
    false,
  );
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.start"), false);
  for (const toolName of FILESYSTEM_TOOL_NAMES.filter(
    (toolName) =>
      toolName !== "fs.write_text" && toolName !== "fs.replace_text",
  )) {
    assert.equal(profiles[0]?.toolAllowlist?.includes(toolName), true);
  }
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.write_text"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.replace_text"), false);
});

test("ProfileStore restores balanced planning tools for stale canonical profiles", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-canonical-backfill-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          shellKind: "cli",
          presetId: "cli_dev_local",
          capabilityPacks: [
            "balanced",
            "filesystem",
            "dev_shell",
            "sandbox_code",
          ],
          toolAllowlist: [
            "FinalizeAnswer",
            "fs.read_text",
            "dev.shell.run",
            "code.execute",
          ],
          default: true,
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();

  assert.equal(profiles[0]?.toolAllowlist?.includes("FinalizeAnswer"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("task.propose"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.verify_json"), true);
  assert.equal(
    profiles[0]?.toolAllowlist?.includes("dev.process.write"),
    false,
  );
});

test("ProfileStore removes reference profiles and enables Kestrel mode-system v2", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-mode-v2-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          modeSystemV2Enabled: false,
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();

  assert.equal(profiles[0]?.modeSystemV2Enabled, true);
  assert.deepEqual(store.consumeLoadNotices(), [
    "Migrated profiles.json V3 to the canonical Kestrel profile.",
  ]);
});

test("ProfileStore omits theme authority from removed reference profiles", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-theme-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          theme: {
            brandAlt: "#00ff00",
            warn: "#abcdef",
          },
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();

  assert.equal(profiles[0]?.theme, undefined);
});

test("ProfileStore does not surface removed reference theme entries", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-theme-notices-"),
  );
  const filePath = path.join(tempDir, "profiles.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          theme: {
            brandAlt: "#00ff00",
            invalidToken: "#ffffff",
            warn: "orange",
          },
        },
      ],
    }),
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  const notices = store.consumeLoadNotices();

  assert.equal(profiles[0]?.theme, undefined);
  assert.deepEqual(notices, [
    "Migrated profiles.json V3 to the canonical Kestrel profile.",
  ]);
});

test("ProfileStore resets to defaults when legacy version file is present", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-legacy-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  const policyPath = path.join(tempDir, MODEL_POLICY_FILE_NAME);

  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      profiles: [],
    }),
    "utf8",
  );
  await writeFile(
    policyPath,
    `${JSON.stringify(
      {
        version: 1,
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        modelByStage: {},
        modelCapabilities: {
          visionInputEnabled: false,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["kestrel"],
  );
  assert.equal(profiles[0]?.modelProvider, "anthropic");
  assert.equal(profiles[0]?.model, "claude-3-5-haiku-latest");
});

test("parseProfilesFile migrates version 2 payload to v3 profile shape", () => {
  const parsed = parseProfilesFile(
    JSON.stringify({
      version: 2,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
        },
      ],
    }),
  );

  assert.equal(parsed.migrated, true);
  assert.equal(Array.isArray(parsed.profiles[0]?.mcpServers), true);
});

test("parseProfilesFile validates mcpServers schema in version 3", () => {
  assert.throws(() => {
    parseProfilesFile(
      JSON.stringify({
        version: 3,
        profiles: [
          {
            id: "reference",
            label: "Reference React",
            agent: "reference-react",
            sessionPrefix: "reference",
            mcpServers: [
              {
                id: "remote",
                transport: "http",
                url: "https://mcp.example.test",
                headerEnvs: {
                  Authorization: "",
                },
              },
            ],
          },
        ],
      }),
    );
  }, /header 'Authorization'/);
});

test("parseProfilesFile strictly validates harness economics configuration", () => {
  const baseProfile = {
    id: "reference",
    label: "Reference React",
    agent: "reference-react",
    sessionPrefix: "reference",
    harnessEconomics: {
      version: 1,
      policy: {
        version: 1,
        policyId: "economics:reference:observe:v1",
        mode: "observe",
        counting: {
          estimatorVersion: "utf8-byte-upper-bound:v1",
          allowEstimatedEnforcement: false,
        },
        context: {
          outputReserveTokens: 8_000,
          safetyReserveTokens: 2_000,
          sections: [{ id: "active-task", priority: "required" }],
        },
        compaction: { requireStructuredAnchors: true, maxSummaryAttempts: 1 },
        tools: {
          exposure: "assembly_allowlist",
          modelContextMaxTokens: 4_000,
          allowedFamiliesByPhase: { agent: ["filesystem"] },
        },
        cache: { mode: "provider_default" },
      },
      modelProfiles: [
        {
          version: 1,
          profileId: "openrouter:model-a:v1",
          provider: "openrouter",
          model: "model-a",
          contextWindowTokens: 100_000,
          maxOutputTokens: 8_000,
          counting: {
            counter: "tiktoken:o200k_base",
            counterVersion: "1.0.21",
            method: "model_tokenizer",
            confidence: "model_compatible",
          },
          cache: { behavior: "provider_automatic" },
        },
      ],
    },
  };
  const parsed = parseProfilesFile(
    JSON.stringify({ version: 4, profiles: [baseProfile] }),
  );

  assert.equal(
    parsed.profiles[0]?.harnessEconomics?.policy.policyId,
    "economics:reference:observe:v1",
  );
  assert.equal(
    parsed.profiles[0]?.harnessEconomics?.modelProfiles[0]?.profileId,
    "openrouter:model-a:v1",
  );
  assert.throws(
    () =>
      parseProfilesFile(
        JSON.stringify({
          version: 4,
          profiles: [
            {
              ...baseProfile,
              harnessEconomics: {
                ...baseProfile.harnessEconomics,
                threshold: 0.8,
              },
            },
          ],
        }),
      ),
    /unknown field 'threshold'/u,
  );
});

test("parseProfilesFile preserves MCP tool approval and interaction-mode metadata", () => {
  const parsed = parseProfilesFile(
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          mcpServers: [
            {
              id: "calendar",
              transport: "http",
              url: "https://mcp.example.test",
              toolMetadata: {
                create_event: {
                  displayName: "Create event",
                  aliases: ["calendar create"],
                  keywords: ["calendar", "event"],
                  provider: "calendar",
                  toolFamily: "calendar.write",
                  capabilityClasses: ["calendar.write"],
                  approvalMode: "ask",
                  allowedInteractionModes: ["chat", "build", "chat"],
                },
              },
            },
          ],
        },
      ],
    }),
  );

  const metadata =
    parsed.profiles[0]?.mcpServers?.[0]?.toolMetadata?.create_event;
  assert.equal(metadata?.approvalMode, "ask");
  assert.deepEqual(metadata?.allowedInteractionModes, ["chat", "build"]);
});

test("parseProfilesFile validates toolQueue schema in version 3", () => {
  assert.throws(() => {
    parseProfilesFile(
      JSON.stringify({
        version: 3,
        profiles: [
          {
            id: "reference",
            label: "Reference React",
            agent: "reference-react",
            sessionPrefix: "reference",
            toolQueue: "bad",
          },
        ],
      }),
    );
  }, /field 'toolQueue' must be an object/);
});

test("parseProfilesFile validates codeMode schema in version 3", () => {
  assert.throws(() => {
    parseProfilesFile(
      JSON.stringify({
        version: 3,
        profiles: [
          {
            id: "reference",
            label: "Reference React",
            agent: "reference-react",
            sessionPrefix: "reference",
            codeMode: {
              enabled: true,
              approvalMode: "manual",
            },
          },
        ],
      }),
    );
  }, /approvalMode/);
});

test("parseProfilesFile requires positive integer code-mode storage quotas", () => {
  for (const [field, value] of [
    ["workspaceSizeMb", 0],
    ["workspaceInodes", 1.5],
    ["tmpSizeMb", -1],
    ["tmpInodes", "2048"],
  ] as const) {
    assert.throws(
      () =>
        parseProfilesFile(
          JSON.stringify({
            version: 3,
            profiles: [
              {
                id: "reference",
                label: "Reference React",
                agent: "reference-react",
                sessionPrefix: "reference",
                codeMode: {
                  enabled: true,
                  sandbox: { [field]: value },
                },
              },
            ],
          }),
        ),
      new RegExp(`${field}.*positive integer`, "u"),
    );
  }
});

test("version 3 profiles migrate to live-only provider reasoning defaults", () => {
  const parsed = parseProfilesFile(
    JSON.stringify({
      version: 3,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
        },
      ],
    }),
  );
  assert.equal(parsed.migrated, true);
  assert.deepEqual(applyProfileDefaults(parsed.profiles[0]!).reasoning, {
    request: { mode: "provider_visible" },
    retention: { mode: "live_only", days: 7 },
  });
});

test("version 4 profiles accept explicit retention and enforce the 1 to 30 day range", () => {
  const valid = parseProfilesFile(
    JSON.stringify({
      version: 4,
      profiles: [
        {
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          reasoning: {
            request: { mode: "summary", effort: "high" },
            retention: { mode: "provider_visible", days: 30 },
          },
        },
      ],
    }),
  );
  assert.deepEqual(valid.profiles[0]?.reasoning, {
    request: { mode: "summary", effort: "high" },
    retention: { mode: "provider_visible", days: 30 },
  });
  for (const days of [0, 31]) {
    assert.throws(
      () =>
        parseProfilesFile(
          JSON.stringify({
            version: 4,
            profiles: [
              {
                id: "reference",
                label: "Reference React",
                agent: "reference-react",
                sessionPrefix: "reference",
                reasoning: {
                  request: { mode: "summary" },
                  retention: { mode: "provider_visible", days },
                },
              },
            ],
          }),
        ),
      /integer from 1 to 30/u,
    );
  }
});
