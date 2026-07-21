import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyProfileDefaults, parseProfilesFile, ProfileStore } from "../../cli/config/ProfileStore.js";
import { MODEL_POLICY_FILE_NAME } from "../../src/profile/modelPolicy.js";
import { FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "ProfileStore bootstraps default profile when file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const profileIds = profiles.map((profile) => profile.id);

  assert.equal(profiles.length >= 1, true);
  assert.deepEqual(profileIds, ["reference", "kestrel-one"]);
  assert.equal(profiles[0]?.agent, "reference-react");
  assert.equal(profiles[0]?.shellKind, "cli");
  assert.equal(profiles[0]?.presetId, "cli_dev_local");
  assert.deepEqual(profiles[0]?.capabilityPacks, ["balanced", "filesystem", "dev_shell"]);
  assert.equal(profiles[0]?.guardrails?.maxStepVisits, 80);
  assert.equal(profiles[0]?.toolQueue?.perRunConcurrency, 8);
  assert.equal(profiles[0]?.toolQueue?.globalConcurrency, 24);
  assert.equal(profiles[0]?.codeMode?.enabled, false);
  assert.equal(profiles[0]?.devShell?.enabled, true);
  assert.equal(profiles[0]?.devShell?.envMode, "inherit");
  assert.equal(profiles[0]?.codeMode?.sandbox.executor, "docker");
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.write"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), true);
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
  assert.equal(persisted.profiles[0]?.modelProvider, undefined);
  assert.equal(persisted.profiles[0]?.model, undefined);
  assert.equal(persisted.profiles[0]?.environmentShellKind, undefined);
  assert.equal(persisted.profiles[0]?.environmentPresetId, undefined);
});

contractTest("runtime.hermetic", "ProfileStore applies shared model policy when profiles.json is missing", async () => {
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

contractTest("runtime.hermetic", "ProfileStore allowlists Kestrel-One knowledge only on the Kestrel-One profile", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();
  const reference = profiles.find((profile) => profile.id === "reference");
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel-one");

  assert.equal(reference?.toolAllowlist?.includes("kestrel_one.search_knowledge_documents"), false);
  assert.equal(kestrelOne?.toolAllowlist?.includes("kestrel_one.search_knowledge_documents"), true);
});

contractTest("runtime.hermetic", "ProfileStore resolves legacy provider-specific profile ids to the canonical reference profile", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-profile-store-legacy-alias-"));
  const store = new ProfileStore(tempDir);

  const profiles = await store.load();

  assert.equal(store.findById(profiles, "reference-openai")?.id, "reference");
  assert.equal(store.findById(profiles, "reference-anthropic")?.id, "reference");
});

contractTest("runtime.hermetic", "ProfileStore adds Kestrel-One profile to existing profile files", async () => {
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
  const kestrelOne = profiles.find((profile) => profile.id === "kestrel-one");

  assert.equal(reference?.default, true);
  assert.equal(kestrelOne?.default, false);
  assert.equal(kestrelOne?.toolAllowlist?.includes("kestrel_one.search_knowledge_documents"), true);

  const saved = parseProfilesFile(await readFile(filePath, "utf8"));
  assert.equal(saved.profiles.some((profile) => profile.id === "kestrel-one"), true);
});

contractTest("runtime.hermetic", "ProfileStore never persists transient gateway credential references", async () => {
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
          model: "openai/gpt-5.4",
          modelCredential: {
            source: "kestrel-one",
            organizationId: "org-acme",
            environmentId: "env-production",
            gatewayId: "gateway-openrouter",
            rawModelId: "openai/gpt-5.4",
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
      ?.gatewayId,
    "gateway-openrouter"
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

contractTest("runtime.hermetic", "parseProfilesFile validates profile shape", () => {
  assert.throws(() => {
    parseProfilesFile(JSON.stringify({ version: 2, profiles: [{ id: "x" }] }));
  }, /Profile field/);
});

contractTest("runtime.hermetic", "ProfileStore rejects unsupported agent", async () => {
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

contractTest("runtime.hermetic", "ProfileStore backfills guardrail defaults for existing profiles", async () => {
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
  assert.equal(profiles[0]?.presetId, "cli_dev_local");
  assert.equal(profiles[0]?.capabilityPacks?.includes("filesystem"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("free.weather.forecast"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("FinalizeAnswer"), true);
  assert.equal(profiles[0]?.toolQueue?.checkpointSize, 10);
  assert.equal(profiles[0]?.toolQueue?.retryCount, 1);
  assert.equal(profiles[0]?.codeMode?.enabled, false);
  assert.equal(profiles[0]?.devShell?.enabled, true);
  assert.equal(profiles[0]?.devShell?.envMode, "inherit");
  assert.equal(profiles[0]?.modeSystemV2Enabled, true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("code.execute"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.run"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.write"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.read"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.process.stop"), true);
  assert.equal(profiles[0]?.toolAllowlist?.includes("dev.shell.start"), false);
  for (const toolName of FILESYSTEM_TOOL_NAMES.filter(
    (toolName) => toolName !== "fs.write_text" && toolName !== "fs.replace_text",
  )) {
    assert.equal(profiles[0]?.toolAllowlist?.includes(toolName), true);
  }
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.write_text"), false);
  assert.equal(profiles[0]?.toolAllowlist?.includes("fs.replace_text"), false);
});

contractTest("runtime.hermetic", "ProfileStore restores balanced planning tools for stale canonical profiles", async () => {
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

contractTest("runtime.hermetic", "ProfileStore migrates reference profiles onto mode-system v2", async () => {
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
    "Migrated profile 'reference' to mode-system v2 for the reference harness.",
  ]);
});

contractTest("runtime.hermetic", "ProfileStore loads valid theme overrides", async () => {
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

contractTest("runtime.hermetic", "ProfileStore ignores invalid theme entries with load notices", async () => {
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

contractTest("runtime.hermetic", "ProfileStore resets to defaults when legacy version file is present", async () => {
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

contractTest("runtime.hermetic", "parseProfilesFile migrates version 2 payload to v3 profile shape", () => {
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

contractTest("runtime.hermetic", "parseProfilesFile validates mcpServers schema in version 3", () => {
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

contractTest("runtime.hermetic", "parseProfilesFile preserves MCP tool approval and interaction-mode metadata", () => {
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

contractTest("runtime.hermetic", "parseProfilesFile validates toolQueue schema in version 3", () => {
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

contractTest("runtime.hermetic", "parseProfilesFile validates codeMode schema in version 3", () => {
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

contractTest("runtime.hermetic", "version 3 profiles migrate to live-only provider reasoning defaults", () => {
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

contractTest("runtime.hermetic", "version 4 profiles accept explicit retention and enforce the 1 to 30 day range", () => {
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
