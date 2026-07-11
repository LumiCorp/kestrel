import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCliCommand, resolveCommandModeRunnerModeForTests, shouldRunCommandMode } from "../../cli/commandMode.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { resolveDefaultDevShellBaseDir } from "../../src/devshell/paths.js";

test("shouldRunCommandMode recognizes command-mode entry commands", () => {
  assert.equal(shouldRunCommandMode(["model", "show"]), true);
  assert.equal(shouldRunCommandMode(["workspace", "status"]), true);
  assert.equal(shouldRunCommandMode(["status"]), true);
  assert.equal(shouldRunCommandMode(["run", "workspace"]), false);
  assert.equal(shouldRunCommandMode(["web", "--port", "43102"]), true);
  assert.equal(shouldRunCommandMode(["job", "run"]), true);
  assert.equal(shouldRunCommandMode(["operator", "resume-wait"]), true);
  assert.equal(shouldRunCommandMode(["runtime", "bundle"]), true);
  assert.equal(shouldRunCommandMode(["setup"]), true);
  assert.equal(shouldRunCommandMode(["--session", "default"]), false);
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

test("command mode honors the in-process runner environment switch", () => {
  assert.equal(resolveCommandModeRunnerModeForTests({}), "child");
  assert.equal(resolveCommandModeRunnerModeForTests({ KESTREL_RUNNER_PROCESS_MODE: "inprocess" }), "inprocess");
  assert.equal(resolveCommandModeRunnerModeForTests({ KCHAT_RUNNER_MODE: "in_process" }), "inprocess");
});

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
    assert.match(initial, /model: z-ai\/glm-5\.2/u);
    assert.match(initial, /Recommended models for 'openrouter':/u);
    assert.match(initial, /\* z-ai\/glm-5\.2/u);
    assert.match(initial, /Use kestrel model search <query> to browse/u);

    await captureStdout(async () => {
      await runCliCommand(["model", "set-provider", "openai", "gpt-5.4-2026-03-05"], cwd);
    });
    const updated = await captureStdout(async () => {
      await runCliCommand(["model", "set", "gpt-5.4-2026-03-05"], cwd);
    });
    assert.match(updated, /provider=openai model=gpt-5\.4-2026-03-05/u);

    const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-live-openrouter-"));
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
      await runCliCommand(["model", "show"], cwd);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-search-"));
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
      await runCliCommand(["model", "search", "gpt-5"], cwd);
    });
    assert.match(output, /Model search results for 'gpt-5' \(openrouter\):/u);
    assert.match(output, /- openai\/gpt-5\.4-mini/u);
    assert.match(output, /- openai\/gpt-5\.2-chat/u);
    assert.match(output, /Use kestrel model set <exact-model-id> to pick one of these models\./u);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-ollama-"));
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
        models: [
          { model: "llama3.2:3b" },
          { model: "qwen2.5-coder" },
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
    await assert.rejects(
      () => runCliCommand(["model", "set-provider", "ollama"], cwd),
      /Selecting provider 'ollama' requires an explicit model\./u,
    );

    const updated = await captureStdout(async () => {
      await runCliCommand(["model", "set-provider", "ollama", "llama3.2:3b"], cwd);
    });
    assert.match(updated, /provider=ollama model=llama3\.2:3b/u);

    const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
      provider: string;
      model: string;
    };
    assert.equal(policy.provider, "ollama");
    assert.equal(policy.model, "llama3.2:3b");

    await assert.rejects(
      () => runCliCommand(["model", "set", "gpt-5.2"], cwd),
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
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-live-ollama-"));
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
        models: [
          { model: "qwen2.5-coder" },
          { model: "llama3.2:3b" },
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
    const updated = await captureStdout(async () => {
      await runCliCommand(["model", "set-provider", "ollama", "qwen2.5-coder"], cwd);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-command-model-lmstudio-"));
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    const updated = await captureStdout(async () => {
      await runCliCommand(["model", "set-provider", "lmstudio", "local-model"], cwd);
    });
    assert.match(updated, /provider=lmstudio model=local-model/u);

    const policy = JSON.parse(await readFile(path.join(home, "model-policy.json"), "utf8")) as {
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
      await runCliCommand(["workspace", "status"], cwd);
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
      await runCliCommand(["model", "show"], cwd);
    });
    await silenceStdout(async () => {
      await runCliCommand(["workspace", "status"], cwd);
    });

    const policy = JSON.parse(await readFile(path.join(expandedHome, "model-policy.json"), "utf8")) as {
      provider: string;
    };
    assert.equal(policy.provider, "openrouter");

    const workspaces = await new WorkspaceStore(expandedHome).load();
    assert.equal(workspaces.workspaces[0]?.rootPath, expectedCwd);
    assert.equal(
      resolveDefaultDevShellBaseDir({ KESTREL_HOME: relativeHome } as NodeJS.ProcessEnv),
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
    await silenceStdout(async () => {
      await runCliCommand(
        [
          "setup",
          "--store",
          "sqlite",
          "--sqlite-path",
          "./.kestrel/runtime.db",
          "--approval-pack",
          "production",
          "--full",
        ],
        cwd,
      );
    });

    const settingsRaw = await readFile(path.join(home, "settings.json"), "utf8");
    const settings = JSON.parse(settingsRaw) as {
      version: number;
      defaults: {
        storeDriver: string;
        sqlitePath: string;
        approvalPolicyPackId: string;
        minimalMode: boolean;
      };
    };
    assert.equal(settings.version, 1);
    assert.equal(settings.defaults.storeDriver, "sqlite");
    assert.equal(settings.defaults.sqlitePath, "./.kestrel/runtime.db");
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
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await operation();
  } finally {
    process.stdout.write = original;
  }
}

async function captureStdout(operation: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const originalLocalCoreDirect = process.env.KESTREL_LOCAL_CORE_DIRECT;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
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
