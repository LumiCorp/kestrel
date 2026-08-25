import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseRunnerCommandV2 } from "@kestrel-agents/protocol";

import {
  buildResolvedJobRunCommandPayload,
  compareJobBinding,
  runCliCommand,
  shouldRunCommandMode,
} from "../../cli/commandMode.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import {
  formatCliLocalCoreDaemonInspection,
  type CliLocalCoreStatus,
} from "../../cli/localCoreShell.js";
import { resolveDefaultDevShellBaseDir } from "../../src/devshell/paths.js";

const SKIP_LOCAL_CORE_PREPARATION = {
  prepareLocalCore: () => Promise.resolve(),
};

test("shouldRunCommandMode recognizes command-mode entry commands", () => {
  assert.equal(shouldRunCommandMode(["model", "show"]), true);
  assert.equal(shouldRunCommandMode(["workspace", "status"]), true);
  assert.equal(shouldRunCommandMode(["status"]), true);
  assert.equal(shouldRunCommandMode(["core", "status"]), true);
  assert.equal(shouldRunCommandMode(["run", "workspace"]), false);
  assert.equal(shouldRunCommandMode(["web", "--port", "43102"]), true);
  assert.equal(shouldRunCommandMode(["job", "run"]), true);
  assert.equal(shouldRunCommandMode(["operator", "resume-wait"]), true);
  assert.equal(shouldRunCommandMode(["runtime", "bundle"]), true);
  assert.equal(shouldRunCommandMode(["setup"]), true);
  assert.equal(shouldRunCommandMode(["uninstall", "plan"]), true);
  assert.equal(shouldRunCommandMode(["--session", "default"]), false);
});

test("command mode routes readiness through explicit services", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-services-"),
  );
  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = root;
  let prepareCalls = 0;
  let requireCalls = 0;
  try {
    await captureStdout(async () => {
      await runCliCommand(["model", "show"], root, {
        prepareLocalCore: () => {
          prepareCalls += 1;
          return Promise.resolve();
        },
      });
    });
    const status = await captureStdout(async () => {
      await runCliCommand(["status"], root, {
        requireLocalCore: () => {
          requireCalls += 1;
          return Promise.resolve({
            state: "healthy",
            summary: "ready",
            home: {
              productRootPath: root,
              homePath: root,
              stateEpoch: "0.6",
              source: "explicit_core_home",
              isolated: false,
              platform: process.platform,
            },
            lock: {
              state: "missing",
              lockPath: path.join(root, "lock.json"),
            },
            dbMode: "pglite",
            database: {
              mode: "pglite",
              state: "healthy",
              summary: "ready",
              managed: true,
              initialized: true,
              running: true,
              identityVerified: true,
            },
            settingsReady: true,
            workspaceRegistryReady: true,
            diagnosticsPath: path.join(root, "diagnostics.json"),
            logsPath: path.join(root, "logs"),
          } satisfies CliLocalCoreStatus);
        },
      });
    });

    assert.equal(prepareCalls, 1);
    assert.equal(requireCalls, 1);
    assert.match(status, /Kestrel Local Core: healthy/u);
  } finally {
    if (originalHome === undefined) delete process.env.KESTREL_HOME;
    else process.env.KESTREL_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("command mode core status inspects without starting Local Core", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-core-status-"),
  );
  const originalCoreHome = process.env.KESTREL_CORE_HOME;
  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_CORE_HOME = root;
  delete process.env.KESTREL_HOME;
  try {
    const output = await captureStdout(async () => {
      await runCliCommand(["core", "status"], root);
    });
    assert.match(output, /Kestrel Local Core: stopped/u);
    assert.match(output, /Build state: unknown/u);
    assert.match(output, /Expected build: sha256:[a-f0-9]{64}/u);
    assert.match(output, /run 'kestrel core restart' to start/u);
    await assert.rejects(
      readFile(path.join(root, "state", "0.6", "core", "lock.json")),
      /ENOENT/u,
    );
  } finally {
    if (originalCoreHome === undefined) delete process.env.KESTREL_CORE_HOME;
    else process.env.KESTREL_CORE_HOME = originalCoreHome;
    if (originalHome === undefined) delete process.env.KESTREL_HOME;
    else process.env.KESTREL_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("core status renders actionable busy and legacy guidance", () => {
  const expectedBuildIdentity = {
    version: "local_core_build_identity_v1" as const,
    buildId: `sha256:${"a".repeat(64)}` as const,
    suiteVersion: "0.7.0",
    source: "source_tree" as const,
  };
  const busy = formatCliLocalCoreDaemonInspection({
    state: "running",
    compatibility: "outdated",
    expectedBuildIdentity,
    lifecycle: {
      state: "busy",
      owner: { pid: 42, executable: "/fake/core" },
      blockers: [{ code: "ACTIVE", message: "Work is active.", count: 1 }],
    },
  });
  assert.match(busy, /kestrel core restart --wait/u);
  const legacy = formatCliLocalCoreDaemonInspection({
    state: "running",
    compatibility: "legacy",
    expectedBuildIdentity,
  });
  assert.match(legacy, /stop Core manually/u);
});

test("command mode status reports Local Core home and lock state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-status-"));
  const cwd = path.join(root, "workspace");
  const coreHome = path.join(root, "Kestrel");
  await mkdir(cwd, { recursive: true });

  const originalCoreHome = process.env.KESTREL_CORE_HOME;
  const originalHome = process.env.KESTREL_HOME;
  const originalDatabaseUrlSource = process.env.KESTREL_DATABASE_URL_SOURCE;
  process.env.KESTREL_CORE_HOME = coreHome;
  delete process.env.KESTREL_HOME;
  try {
    const output = await captureStdout(async () => {
      await runCliCommand(["status"], cwd);
    });
    assert.match(output, /Kestrel Local Core:/u);
    assert.match(output, new RegExp(`Home: ${escapeRegExp(coreHome)}`, "u"));
    assert.match(output, /Home source: explicit_core_home/u);
    assert.match(output, /Lock: live/u);
  } finally {
    if (originalCoreHome === undefined) {
      delete process.env.KESTREL_CORE_HOME;
    } else {
      process.env.KESTREL_CORE_HOME = originalCoreHome;
    }
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
    if (originalDatabaseUrlSource === undefined) {
      delete process.env.KESTREL_DATABASE_URL_SOURCE;
    } else {
      process.env.KESTREL_DATABASE_URL_SOURCE = originalDatabaseUrlSource;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("command mode emits one resolved profile for profile-bearing jobs", () => {
  const profile = {
    id: "kestrel",
    label: "Reference",
    agent: "kestrel" as const,
    sessionPrefix: "kestrel",
    storeDriver: "sqlite" as const,
  };
  const turn = {
    sessionId: "session-job-profile",
    message: "Run the job",
    eventType: "job.run",
  };

  for (const input of [
    { version: "job_input_v1" as const, profileId: profile.id, turn },
    { version: "job_input_v1" as const, profile, turn },
  ]) {
    const registeredProfileId = `reference:cli_dev_local:${"a".repeat(64)}`;
    const payload = buildResolvedJobRunCommandPayload(
      input,
      profile,
      registeredProfileId,
    );
    assert.equal(payload.input.profile, undefined);
    assert.equal(payload.input.profileId, undefined);
    assert.equal(payload.profile, undefined);
    assert.equal(payload.profileId, registeredProfileId);
    assert.equal(payload.input.turn.eventType, "job.run");
    assert.equal(payload.input.turn.stepAgent, "agent.loop");
    assert.doesNotThrow(() =>
      parseRunnerCommandV2({
        id: "command-job-profile",
        type: "job.run",
        payload,
      }),
    );
  }
});

test("command mode rejects job-owned persistence selection", () => {
  assert.throws(
    () =>
      buildResolvedJobRunCommandPayload(
        {
          version: "job_input_v1",
          storeDriver: "sqlite",
          turn: {
            sessionId: "session-job-store",
            message: "Run against a client-selected store",
            eventType: "job.run",
          },
        },
        {
          id: "kestrel",
          label: "Reference",
          agent: "kestrel",
          sessionPrefix: "kestrel",
        },
        `reference:cli_dev_local:${"a".repeat(64)}`,
      ),
    /Local Core owns persistence/u,
  );
});

test("job preflight reports ready without creating job, thread, run, or worktree state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-preflight-ready-"));
  const inputPath = path.join(root, "input.json");
  const outputPath = path.join(root, "output.json");
  let resolutionCalls = 0;
  const client = {
    resolveExecutionProfile: async () => {
      resolutionCalls += 1;
      return executionProfileResolution(["exec_command", "fs.read_text"]);
    },
  };
  await writeFile(inputPath, JSON.stringify(jobPreflightInput()), "utf8");
  try {
    await captureStdout(async () => {
      await runCliCommand(
        ["job", "preflight", "--json-in", inputPath, "--json-out", outputPath],
        root,
        {
          prepareLocalCore: () => Promise.resolve({ client } as unknown as CliLocalCoreStatus),
        },
      );
    });
    const output = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(output.status, "ready");
    assert.deepEqual(output.effectiveTools, ["exec_command", "fs.read_text"]);
    assert.deepEqual(output.missingTools, []);
    assert.equal(resolutionCalls, 1);
    assert.deepEqual((await readdir(root)).sort(), ["input.json", "output.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job preflight reports missing tools without dispatching work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-preflight-missing-"));
  const inputPath = path.join(root, "input.json");
  const outputPath = path.join(root, "output.json");
  let resolutionCalls = 0;
  const client = {
    resolveExecutionProfile: async () => {
      resolutionCalls += 1;
      return executionProfileResolution(["fs.read_text"]);
    },
  };
  await writeFile(inputPath, JSON.stringify(jobPreflightInput()), "utf8");
  try {
    await assert.rejects(
      runCliCommand(
        ["job", "preflight", "--json-in", inputPath, "--json-out", outputPath],
        root,
        {
          prepareLocalCore: () => Promise.resolve({ client } as unknown as CliLocalCoreStatus),
        },
      ),
      /SETUP_REQUIRED/u,
    );
    const output = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(output.status, "setup_required");
    assert.deepEqual(output.requiredTools, ["exec_command"]);
    assert.deepEqual(output.missingTools, ["exec_command"]);
    assert.equal(resolutionCalls, 1);
    assert.deepEqual((await readdir(root)).sort(), ["input.json", "output.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job binding comparison rejects every mutable execution authority", () => {
  const binding = {
    version: "job_execution_profile_binding_v1" as const,
    authoringProfileId: "kestrel",
    environmentPresetId: "cli_dev_local" as const,
    resolvedProfileId: `kestrel:cli_dev_local:${"a".repeat(64)}`,
    profileFingerprint: "a".repeat(64),
    policy: { id: "kestrel", version: 3 },
    approvalPolicyPack: { id: "dev" as const, version: 1 as const, digest: "b".repeat(64) },
  };
  const preflight = {
    version: "job_preflight_v1" as const,
    capability: "local-core.execution-profile-resolution.v2" as const,
    status: "ready" as const,
    requestedPresetId: "cli_dev_local" as const,
    resolvedPresetId: "cli_dev_local" as const,
    profileId: binding.resolvedProfileId,
    profileFingerprint: binding.profileFingerprint,
    policyRevision: "kestrel:v3/cli_dev_local:v1",
    approvalPolicyPackId: "dev" as const,
    effectiveTools: ["exec_command"],
    requiredTools: ["exec_command"],
    missingTools: [],
    executionProfileBinding: binding,
  };
  assert.deepEqual(compareJobBinding(binding, preflight), []);
  for (const altered of [
    { ...binding, authoringProfileId: "other" },
    { ...binding, environmentPresetId: "cli_safe_local" as const },
    { ...binding, resolvedProfileId: `kestrel:cli_dev_local:${"c".repeat(64)}` },
    { ...binding, profileFingerprint: "c".repeat(64) },
    { ...binding, policy: { id: "kestrel", version: 2 } },
    { ...binding, approvalPolicyPack: { ...binding.approvalPolicyPack, id: "ci_bot" as const } },
    { ...binding, approvalPolicyPack: { ...binding.approvalPolicyPack, digest: "c".repeat(64) } },
  ]) {
    assert.equal(compareJobBinding(altered, preflight).length, 1);
  }
});

function jobPreflightInput() {
  return {
    version: "job_input_v2",
    profileId: "kestrel",
    environmentPresetId: "cli_dev_local",
    approvalPolicyPackId: "dev",
    requiredTools: ["exec_command"],
    turn: { sessionId: "preflight-test", message: "Verify compatibility" },
  };
}

function executionProfileResolution(toolAllowlist: string[]) {
  return {
    version: 1 as const,
    profileId: `kestrel:cli_dev_local:${"a".repeat(64)}`,
    fingerprint: "a".repeat(64),
    policy: { id: "kestrel", version: 3 },
    environmentPreset: { id: "cli_dev_local" as const, version: 1 },
    resolvedProfile: {
      id: "kestrel",
      label: "Kestrel",
      agent: "kestrel" as const,
      sessionPrefix: "kestrel",
      toolAllowlist,
    },
  };
}

test("command mode model show and set operate on shared model policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-"));
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    const initial = await captureStdout(async () => {
      await runCliCommand(["model", "show"], cwd);
    });
    assert.match(initial, /provider: openrouter/u);
    assert.match(initial, /model: openai\/gpt-5\.6-luna/u);
    assert.match(initial, /Recommended models for 'openrouter':/u);
    assert.match(initial, /\* openai\/gpt-5\.6-luna/u);
    assert.match(initial, /Use kestrel model search <query> to browse/u);

    await captureStdout(async () => {
      await runCliCommand(
        ["model", "set-provider", "openai", "gpt-5.4-2026-03-05"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    const updated = await captureStdout(async () => {
      await runCliCommand(
        ["model", "set", "gpt-5.4-2026-03-05"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    assert.match(updated, /provider=openai model=gpt-5\.4-2026-03-05/u);

    const policy = JSON.parse(
      await readFile(path.join(home, "model-policy.json"), "utf8"),
    ) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "openai");
    assert.equal(policy.model, "gpt-5.4-2026-03-05");
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

test("command mode model show prefers the live OpenRouter catalog when available", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-model-live-openrouter-"),
  );
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.KESTREL_HOME = home;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/models");
    return new Response(
      JSON.stringify({
        data: [
          { id: "openai/gpt-5.4-mini" },
          { id: "openai/gpt-5.2-chat" },
          { id: "google/gemini-2.5-flash" },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const output = await captureStdout(async () => {
      await runCliCommand(["model", "show"], cwd, SKIP_LOCAL_CORE_PREPARATION);
    });
    assert.match(output, /modelCatalog=live/u);
    assert.match(output, /Recommended models for 'openrouter':/u);
    assert.match(output, /additionalAvailableModels=1/u);
    assert.doesNotMatch(output, /- google\/gemini-2\.5-flash/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});

test("command mode model search shows bounded matches for the current provider", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-model-search-"),
  );
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.KESTREL_HOME = home;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "openai/gpt-5.4-mini" },
          { id: "openai/gpt-5.2-chat" },
          { id: "google/gemini-2.5-flash" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const output = await captureStdout(async () => {
      await runCliCommand(
        ["model", "search", "gpt-5"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    assert.match(output, /Model search results for 'gpt-5' \(openrouter\):/u);
    assert.match(output, /- openai\/gpt-5\.4-mini/u);
    assert.match(output, /- openai\/gpt-5\.2-chat/u);
    assert.match(
      output,
      /Use kestrel model set <exact-model-id> to pick one of these models\./u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});

test("command mode model set-provider accepts ollama", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-model-ollama-"),
  );
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  const originalFetch = globalThis.fetch;
  process.env.KESTREL_HOME = home;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
    return new Response(
      JSON.stringify({
        models: [{ model: "llama3.2:3b" }, { model: "qwen2.5-coder" }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        captureStdout(async () => {
          await runCliCommand(
            ["model", "set-provider", "ollama"],
            cwd,
            SKIP_LOCAL_CORE_PREPARATION,
          );
        }),
      /Selecting provider 'ollama' requires an explicit model\./u,
    );

    const updated = await captureStdout(async () => {
      await runCliCommand(
        ["model", "set-provider", "ollama", "llama3.2:3b"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    assert.match(updated, /provider=ollama model=llama3\.2:3b/u);

    const policy = JSON.parse(
      await readFile(path.join(home, "model-policy.json"), "utf8"),
    ) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "ollama");
    assert.equal(policy.model, "llama3.2:3b");

    await assert.rejects(
      () =>
        captureStdout(async () => {
          await runCliCommand(
            ["model", "set", "gpt-5.2"],
            cwd,
            SKIP_LOCAL_CORE_PREPARATION,
          );
        }),
      /Model 'gpt-5\.2' is not allowed for provider 'ollama'\./u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

test("command mode model set-provider uses the live Ollama catalog when available", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-model-live-ollama-"),
  );
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  const originalFetch = globalThis.fetch;
  process.env.KESTREL_HOME = home;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
    return new Response(
      JSON.stringify({
        models: [{ model: "qwen2.5-coder" }, { model: "llama3.2:3b" }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const updated = await captureStdout(async () => {
      await runCliCommand(
        ["model", "set-provider", "ollama", "qwen2.5-coder"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    assert.match(updated, /provider=ollama model=qwen2\.5-coder/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

test("command mode model set-provider accepts lmstudio", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-command-model-lmstudio-"),
  );
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    const updated = await captureStdout(async () => {
      await runCliCommand(
        ["model", "set-provider", "lmstudio", "local-model"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });
    assert.match(updated, /provider=lmstudio model=local-model/u);

    const policy = JSON.parse(
      await readFile(path.join(home, "model-policy.json"), "utf8"),
    ) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "lmstudio");
    assert.equal(policy.model, "local-model");
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

test("command mode workspace status registers cwd in the central catalog without scaffold files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-mode-"));
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const expectedCwd = await realpath(cwd);

  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    await silenceStdout(async () => {
      await runCliCommand(
        ["workspace", "status"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });

    const workspaces = await new WorkspaceStore(home).load();
    const entry = workspaces.workspaces[0];
    assert.equal(entry?.automationEnabled, false);
    assert.equal(entry?.rootPath, expectedCwd);
    await assert.rejects(
      () => readFile(path.join(cwd, ".kestrel"), "utf8"),
      /ENOENT/u,
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

test("command mode expands ~/ KESTREL_HOME consistently with dev-shell defaults", async () => {
  const root = await mkdtemp(path.join("/tmp", "kcth-"));
  const cwd = path.join(root, "workspace");
  const fakeHome = path.join(root, "home");
  const relativeHome = `~/kestrel-command-home-${Date.now()}`;
  const expandedHome = path.join(fakeHome, relativeHome.slice(2));
  const expectedCwd = await (async () => {
    await mkdir(cwd, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    return realpath(cwd);
  })();

  const originalHome = process.env.KESTREL_HOME;
  const originalUserHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.KESTREL_HOME = relativeHome;
  try {
    await captureStdout(async () => {
      await runCliCommand(["model", "show"], cwd, SKIP_LOCAL_CORE_PREPARATION);
    });
    await silenceStdout(async () => {
      await runCliCommand(
        ["workspace", "status"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });

    const policy = JSON.parse(
      await readFile(path.join(expandedHome, "model-policy.json"), "utf8"),
    ) as {
      provider: string;
    };
    assert.equal(policy.provider, "openrouter");

    const workspaces = await new WorkspaceStore(expandedHome).load();
    assert.equal(workspaces.workspaces[0]?.rootPath, expectedCwd);
    assert.equal(
      resolveDefaultDevShellBaseDir({
        KESTREL_HOME: relativeHome,
      } as NodeJS.ProcessEnv),
      path.join(expandedHome, "dev-shell"),
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
    if (originalUserHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalUserHome;
    }
    await rm(expandedHome, { recursive: true, force: true });
  }
});

test("command mode setup writes stable runtime defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-setup-"));
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    await assert.rejects(
      () =>
        silenceStdout(async () => {
          await runCliCommand(
            ["setup", "--store", "sqlite"],
            cwd,
            SKIP_LOCAL_CORE_PREPARATION,
          );
        }),
      /Local Core owns database configuration/u,
    );
    await assert.rejects(
      () =>
        silenceStdout(async () => {
          await runCliCommand(
            ["setup", "--store=sqlite"],
            cwd,
            SKIP_LOCAL_CORE_PREPARATION,
          );
        }),
      /Local Core owns database configuration/u,
    );
    await assert.rejects(
      () =>
        silenceStdout(async () => {
          await runCliCommand(
            ["setup", "--sqlite-path=runtime.db"],
            cwd,
            SKIP_LOCAL_CORE_PREPARATION,
          );
        }),
      /Local Core owns database configuration/u,
    );
    await silenceStdout(async () => {
      await runCliCommand(
        ["setup", "--approval-pack", "production", "--full"],
        cwd,
        SKIP_LOCAL_CORE_PREPARATION,
      );
    });

    const settingsRaw = await readFile(
      path.join(home, "settings.json"),
      "utf8",
    );
    const settings = JSON.parse(settingsRaw) as {
      version: number;
      defaults: {
        storeDriver?: string | undefined;
        sqlitePath?: string | undefined;
        approvalPolicyPackId: string;
        minimalMode: boolean;
      };
    };
    assert.equal(settings.version, 1);
    assert.equal(settings.defaults.storeDriver, undefined);
    assert.equal(settings.defaults.sqlitePath, undefined);
    assert.equal(settings.defaults.approvalPolicyPackId, "production");
    assert.equal(settings.defaults.minimalMode, false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
  }
});

async function silenceStdout(operation: () => Promise<void>): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  const originalLocalCoreDirect = process.env.KESTREL_LOCAL_CORE_DIRECT;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.env.KESTREL_LOCAL_CORE_DIRECT = "1";
  try {
    await operation();
  } finally {
    process.stdout.write = original;
    if (originalLocalCoreDirect === undefined) {
      delete process.env.KESTREL_LOCAL_CORE_DIRECT;
    } else {
      process.env.KESTREL_LOCAL_CORE_DIRECT = originalLocalCoreDirect;
    }
  }
}

async function captureStdout(operation: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const originalLocalCoreDirect = process.env.KESTREL_LOCAL_CORE_DIRECT;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.env.KESTREL_LOCAL_CORE_DIRECT = "1";
  try {
    await operation();
    return output;
  } finally {
    process.stdout.write = original;
    if (originalLocalCoreDirect === undefined) {
      delete process.env.KESTREL_LOCAL_CORE_DIRECT;
    } else {
      process.env.KESTREL_LOCAL_CORE_DIRECT = originalLocalCoreDirect;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
