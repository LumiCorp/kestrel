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


test("ProfileStore bootstraps default profile when file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const profileIds = profiles.map((profile) => profile.id);

  assert.equal(profiles.length >= 1, true);
  assert.deepEqual(profileIds, ["reference", "kestrel"]);
  assert.equal(profiles[0]?.agent, "reference-react");
  assert.equal(profiles[0]?.shellKind, "cli");
  assert.equal(profiles[0]?.presetId, "cli_safe_local");
  assert.deepEqual(profiles[0]?.capabilityPacks, ["balanced", "filesystem", "sandbox_code"]);
  assert.equal(profiles[0]?.guardrails?.maxStepVisits, 80);
  assert.equal(profiles[0]?.toolQueue?.perRunConcurrency, 8);
  assert.equal(profiles[0]?.toolQueue?.globalConcurrency, 24);
  assert.equal(profiles[0]?.codeMode?.enabled, true);
  assert.equal(profiles[0]?.devShell?.enabled, false);
  assert.equal(profiles[0]?.codeMode?.sandbox.executor, "docker");
  assert.equal(profiles[0]?.toolAllowlist?.includes("code.execute"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.write"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.start"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.input"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.status"), false);
  for (const toolName of FILESYSTEM_TOOL_NAMES.filter(
    (toolName) => toolName !== "fs.write_text" && toolName !== "fs.replace_text",
  )) {
    assert.equal(profiles[0]?.toolAllowlist?.includes(toolName), true);
  }
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.write_text"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.replace_text"), false);

  const persisted = parseProfilesFile(await readFile(path.join(tempDir, "profiles.json"), "utf8"));
  assert.equal(persisted.sourceVersion, 8);
  assert.equal(
    persisted.managedProfileOverlays?.["kestrel@cli_safe_local"] !== undefined,
    true,
  );
  assert.equal(persisted.profiles[0]?.modelProvider, undefined);
  assert.equal(persisted.profiles[0]?.model, undefined);
  assert.equal(persisted.profiles[0]?.environmentShellKind, undefined);
  assert.equal(persisted.profiles[0]?.environmentPresetId, undefined);
});

test("ProfileStore v8 migrates only generated local profiles and emits the isolation notice once", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-safe-migration-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
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
          approvalPolicyPackId: "production",
          theme: { brandAlt: "#123456" },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const store = new ProfileStore(tempDir);

  const first = await store.load();
  const reference = first.find((profile) => profile.id === "reference");
  const custom = first.find((profile) => profile.id === "custom-developer");
  const managed = first.find((profile) => profile.id === "kestrel");

  assert.equal(reference?.presetId, "cli_safe_local");
  assert.deepEqual(reference?.capabilityPacks, [
    "balanced",
    "filesystem",
    "sandbox_code",
  ]);
  assert.equal(reference?.devShell?.enabled, false);
  assert.equal(reference?.codeMode?.enabled, true);
  assert.equal(custom?.presetId, "cli_dev_local");
  assert.deepEqual(custom?.capabilityPacks, [
    "balanced",
    "filesystem",
    "dev_shell",
  ]);
  assert.equal(custom?.devShell?.enabled, true);
  assert.equal(managed?.presetId, "cli_safe_local");
  assert.equal(managed?.approvalPolicyPackId, "production");
  assert.equal(managed?.theme?.brandAlt, "#123456");
  assert.deepEqual(store.consumeLoadNotices(), [
    "Generated local profiles now use isolated execution. Select the cli_dev_local developer preset to restore host-shell access.",
  ]);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.version, 8);
  assert.equal(
    persisted.managedProfileOverlays["kestrel@cli_safe_local"].theme.brandAlt,
    "#123456",
  );
  assert.equal(persisted.managedProfileOverlays["kestrel@cli_dev_local"], undefined);
  assert.equal(
    (await readFile(`${filePath}.v6.bak`, "utf8")).includes('"version": 6'),
    true,
  );

  await store.load();
  assert.deepEqual(store.consumeLoadNotices(), []);
});

test("ProfileStore migrates V7 custom recovery behavior to V8 without changing Docker quotas", async () => {
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
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    "utf8",
  );

  const profiles = await new ProfileStore(tempDir).load();
  const custom = profiles.find((profile) => profile.id === "custom-v7");
  assert.deepEqual(
    custom?.recoveryPolicy?.stages.map((stage) => stage.action),
    ["retry_same_route", "terminal_failure"],
  );
  assert.equal(custom?.recoveryPolicy?.stages[0]?.action, "retry_same_route");
  assert.equal(
    custom?.recoveryPolicy?.stages[0]?.action === "retry_same_route"
      ? custom.recoveryPolicy.stages[0].maxAttempts
      : undefined,
    3,
  );

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    profiles: Array<{ codeMode?: { sandbox?: Record<string, number> } }>;
  };
  assert.equal(persisted.version, 8);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(sandboxQuotas).map((key) => [
        key,
        persisted.profiles[0]?.codeMode?.sandbox?.[key],
      ]),
    ),
    sandboxQuotas,
  );
  assert.equal(
    (await readFile(`${filePath}.v7.bak`, "utf8")).includes('"version": 7'),
    true,
  );
});

test("ProfileStore applies shared model policy when profiles.json is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-policy-bootstrap-"));
  const policyPath = path.join(tempDir, MODEL_POLICY_FILE_NAME);
  await writeFile(
    policyPath,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const reference = profiles.find((profile) => profile.id === "reference");
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel");

  assert.equal(reference?.toolAllowlist?.includes("kestrel_one.search_knowledge_documents"), false);
  assert.equal(kestrelOne?.toolAllowlist?.includes("kestrel_one.search_knowledge_documents"), false);
  assert.equal(reference?.delegation?.allowAgentSpawn, false);
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-dialogs-"));
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    "utf8",
  );
  const store = new ProfileStore(tempDir);

  const firstLoad = await store.load();
  const firstPersisted = await readFile(filePath, "utf8");
  const secondLoad = await store.load();
  const secondPersisted = await readFile(filePath, "utf8");
  const reference = secondLoad.find((profile) => profile.id === "reference");
  const kestrelOne = secondLoad.find((profile) => profile.id === "kestrel");

  assert.equal(reference?.delegation?.allowAgentSpawn, false);
  assert.equal(reference?.delegation?.maxConcurrentChildSessions, 4);
  assert.equal(reference?.delegation?.maxDepth, 3);
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
  assert.equal(JSON.parse(firstPersisted).version, 8);
  assert.equal(
    JSON.parse(firstPersisted).profiles.some(
      (profile: { id?: string }) => profile.id === "kestrel-one",
    ),
    false,
  );
  assert.equal((await readFile(`${filePath}.v4.bak`, "utf8")).includes('"version": 4'), true);
});

test("ProfileStore resolves legacy provider-specific profile ids to the canonical reference profile", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-legacy-alias-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();

  assert.equal(store.findById(profiles, "reference-openai")?.id, "reference");
  assert.equal(store.findById(profiles, "reference-anthropic")?.id, "reference");
  assert.equal(store.findById(profiles, "kestrel-one")?.id, "kestrel");
});

test("ProfileStore adds Kestrel-One profile to existing profile files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-kestrel-one-"));
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
  const reference = profiles.find((profile) => profile.id === "reference");
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel");

  assert.equal(reference?.default, true);
  assert.equal(kestrelOne?.default, true);
  assert.deepEqual(
    kestrelOne?.toolAllowlist?.filter((name) => name.startsWith("dialog.")),
    ["dialog.open", "dialog.send", "dialog.close"],
  );

  const saved = parseProfilesFile(await readFile(filePath, "utf8"));
  assert.equal(saved.sourceVersion, 8);
  assert.equal(saved.profiles.some((profile) => profile.id === "kestrel"), false);
  assert.equal(
    saved.managedProfileOverlays?.["kestrel@cli_safe_local"]?.default,
    true,
  );
});

test("ProfileStore preserves a version-5 managed overlay without authoring profiles", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-profile-store-managed-only-"),
  );
  const filePath = path.join(tempDir, "profiles.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    "utf8",
  );

  const profiles = await new ProfileStore(tempDir).load();
  const managed = profiles.find((profile) => profile.id === "kestrel");

  assert.equal(profiles.length, 1);
  assert.equal(managed?.approvalPolicyPackId, "production");
  assert.equal(managed?.delegation?.maxConcurrentChildSessions, 6);
  assert.equal(managed?.delegation?.maxDepth, 1);
  assert.equal(managed?.theme?.brandAlt, "#123456");
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(
    saved.managedProfileOverlays["kestrel@cli_safe_local"].approvalPolicyPackId,
    "production",
  );
  assert.equal(
    saved.managedProfileOverlays["kestrel@cli_safe_local"].theme.brandAlt,
    "#123456",
  );
  assert.equal(
    saved.managedProfileOverlays["kestrel@workspace_hosted"]
      .approvalPolicyPackId,
    "ci_bot",
  );
  assert.equal(
    saved.managedProfileOverlays["kestrel@workspace_hosted"].reasoning
      .retention.days,
    5,
  );
  assert.equal(
    (await readFile(`${filePath}.v5.bak`, "utf8")).includes('"version": 5'),
    true,
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
    agentStageConfig: { modelByStage: { "agent.loop": "gpt-5.1" } },
    modelTimeoutMs: 120_000,
    storeDriver: "postgres",
    kestrelOneAppApprovalModes: {
      "kestrel_one.search_knowledge_documents": "auto",
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
  assert.equal(
    parsed.kestrelOneAppApprovalModes?.[
      "kestrel_one.search_knowledge_documents"
    ],
    "auto",
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
    path.join(os.tmpdir(), "kestrel-profile-store-managed-credential-")
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
    "utf8"
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  assert.equal(
    profiles.find((profile) => profile.id === "reference")?.modelCredential
      ?.runId,
    "run-active"
  );

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    profiles: Array<Record<string, unknown>>;
  };
  const reference = persisted.profiles.find(
    (profile) => profile.id === "reference"
  );
  assert.equal(reference?.modelCredential, undefined);
  assert.equal(reference?.model, undefined);
  assert.equal(reference?.modelProvider, undefined);
});

test("parseProfilesFile validates profile shape", () => {
  assert.throws(() => {
    parseProfilesFile(JSON.stringify({ version: 2, profiles: [{ id: "x" }] }));
  }, /Profile field/);
});

test("ProfileStore rejects unsupported agent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-invalid-"));
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-backfill-"));
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
  assert.equal(profiles[0]?.toolAllowlist?.includes("free.weather.forecast"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("FinalizeAnswer"), true);
  assert.equal(profiles[0]?.toolQueue?.checkpointSize, 10);
  assert.equal(profiles[0]?.toolQueue?.retryCount, 1);
  assert.equal(profiles[0]?.codeMode?.enabled, true);
  assert.equal(profiles[0]?.devShell?.enabled, false);
  assert.equal(profiles[0]?.modeSystemV2Enabled, true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("code.execute"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.write"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.start"), false);
  for (const toolName of FILESYSTEM_TOOL_NAMES.filter(
    (toolName) => toolName !== "fs.write_text" && toolName !== "fs.replace_text",
  )) {
    assert.equal(profiles[0]?.toolAllowlist?.includes(toolName), true);
  }
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.write_text"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.replace_text"), false);
});

test("ProfileStore restores balanced planning tools for stale canonical profiles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-canonical-backfill-"));
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
          capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
          toolAllowlist: ["FinalizeAnswer", "fs.read_text", "dev.shell.run", "code.execute"],
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
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.write"), true);
});

test("ProfileStore migrates reference profiles onto mode-system v2", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-mode-v2-"));
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
    "Generated local profiles now use isolated execution. Select the cli_dev_local developer preset to restore host-shell access.",
    "Migrated profile 'reference' to mode-system v2 for the reference harness.",
  ]);
});

test("ProfileStore loads valid theme overrides", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-theme-"));
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

  assert.equal(profiles[0]?.theme?.brandAlt, "#00FF00");
  assert.equal(profiles[0]?.theme?.warn, "#ABCDEF");
});

test("ProfileStore ignores invalid theme entries with load notices", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-theme-notices-"));
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

  assert.equal(profiles[0]?.theme?.brandAlt, "#00FF00");
  assert.equal(profiles[0]?.theme?.warn, undefined);
  assert.equal(notices.some((notice) => notice.includes("invalidToken")), true);
  assert.equal(notices.some((notice) => notice.includes("orange")), true);
});

test("ProfileStore resets to defaults when legacy version file is present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-legacy-"));
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
    `${JSON.stringify({
      version: 1,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const store = new ProfileStore(tempDir);
  const profiles = await store.load();
  assert.equal(profiles.length >= 1, true);
  assert.equal(profiles[0]?.id, "reference");
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
        counting: { estimatorVersion: "utf8-byte-upper-bound:v1", allowEstimatedEnforcement: false },
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
      modelProfiles: [{
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
      }],
    },
  };
  const parsed = parseProfilesFile(JSON.stringify({ version: 4, profiles: [baseProfile] }));

  assert.equal(parsed.profiles[0]?.harnessEconomics?.policy.policyId, "economics:reference:observe:v1");
  assert.equal(parsed.profiles[0]?.harnessEconomics?.modelProfiles[0]?.profileId, "openrouter:model-a:v1");
  assert.throws(
    () => parseProfilesFile(JSON.stringify({
      version: 4,
      profiles: [{
        ...baseProfile,
        harnessEconomics: { ...baseProfile.harnessEconomics, threshold: 0.8 },
      }],
    })),
    /unknown field 'threshold'/u,
  );
});

test("parseProfilesFile preserves MCP tool approval and interaction-mode metadata", () => {
  const parsed = parseProfilesFile(JSON.stringify({
    version: 3,
    profiles: [{
      id: "reference",
      label: "Reference React",
      agent: "reference-react",
      sessionPrefix: "reference",
      mcpServers: [{
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
      }],
    }],
  }));

  const metadata = parsed.profiles[0]?.mcpServers?.[0]?.toolMetadata?.create_event;
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
      () => parseProfilesFile(JSON.stringify({
        version: 3,
        profiles: [{
          id: "reference",
          label: "Reference React",
          agent: "reference-react",
          sessionPrefix: "reference",
          codeMode: {
            enabled: true,
            sandbox: { [field]: value },
          },
        }],
      })),
      new RegExp(`${field}.*positive integer`, "u"),
    );
  }
});

test("version 3 profiles migrate to live-only provider reasoning defaults", () => {
  const parsed = parseProfilesFile(JSON.stringify({
    version: 3,
    profiles: [{
      id: "reference",
      label: "Reference React",
      agent: "reference-react",
      sessionPrefix: "reference",
    }],
  }));
  assert.equal(parsed.migrated, true);
  assert.deepEqual(applyProfileDefaults(parsed.profiles[0]!).reasoning, {
    request: { mode: "provider_visible" },
    retention: { mode: "live_only", days: 7 },
  });
});

test("version 4 profiles accept explicit retention and enforce the 1 to 30 day range", () => {
  const valid = parseProfilesFile(JSON.stringify({
    version: 4,
    profiles: [{
      id: "reference",
      label: "Reference React",
      agent: "reference-react",
      sessionPrefix: "reference",
      reasoning: {
        request: { mode: "summary", effort: "high" },
        retention: { mode: "provider_visible", days: 30 },
      },
    }],
  }));
  assert.deepEqual(valid.profiles[0]?.reasoning, {
    request: { mode: "summary", effort: "high" },
    retention: { mode: "provider_visible", days: 30 },
  });
  for (const days of [0, 31]) {
    assert.throws(() => parseProfilesFile(JSON.stringify({
      version: 4,
      profiles: [{
        id: "reference",
        label: "Reference React",
        agent: "reference-react",
        sessionPrefix: "reference",
        reasoning: {
          request: { mode: "summary" },
          retention: { mode: "provider_visible", days },
        },
      }],
    })), /integer from 1 to 30/u);
  }
});
