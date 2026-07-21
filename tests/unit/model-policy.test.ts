import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  createDefaultModelPolicy,
  MODEL_POLICY_FILE_NAME,
  ModelPolicyStore,
  resolveProfileWithModelPolicy,
} from "../../src/profile/modelPolicy.js";
import { createWebDemoProfile } from "../../src/web/profile.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "model policy store bootstraps defaults when the file is missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kestrel-model-policy-unit-"));

  try {
    const store = new ModelPolicyStore(tempDir);
    const policy = store.read();

    assert.deepEqual(policy, createDefaultModelPolicy());
    const raw = JSON.parse(await readFile(path.join(tempDir, MODEL_POLICY_FILE_NAME), "utf8")) as Record<string, unknown>;
    assert.equal(raw.provider, "openrouter");
    assert.equal(raw.model, "z-ai/glm-5.2");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "model policy store recovers from invalid JSON by rewriting defaults", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kestrel-model-policy-unit-"));
  const policyPath = path.join(tempDir, MODEL_POLICY_FILE_NAME);

  try {
    await writeFile(policyPath, "{not-json}\n", "utf8");
    const store = new ModelPolicyStore(tempDir);
    const policy = store.read();

    assert.deepEqual(policy, createDefaultModelPolicy());
    const raw = await readFile(policyPath, "utf8");
    assert.match(raw, /"provider": "openrouter"/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "model policy store rewrites defaults when persisted stage overrides are invalid", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kestrel-model-policy-unit-"));
  const policyPath = path.join(tempDir, MODEL_POLICY_FILE_NAME);

  try {
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      modelByStage: {
        "agent.invalid": "bad-model",
      },
      modelCapabilities: {
        visionInputEnabled: false,
      },
    }, null, 2)}\n`, "utf8");
    const store = new ModelPolicyStore(tempDir);
    const policy = store.read();

    assert.deepEqual(policy, createDefaultModelPolicy());
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.modelByStage, {});
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "model policy store rejects unknown stage ids on write", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kestrel-model-policy-unit-"));

  try {
    const store = new ModelPolicyStore(tempDir);
    assert.throws(() => {
      store.write({
        version: 1,
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        modelByStage: {
          "agent.invalid": "bad-model",
        },
        modelCapabilities: {
          visionInputEnabled: false,
        },
      });
    }, /unknown stage/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "resolveProfileWithModelPolicy overlays shared model authority onto shell-local profiles", () => {
  const baseProfile = {
    ...createWebDemoProfile(),
    modelProvider: "anthropic",
    model: "claude-3-5-sonnet-latest",
    agentStageConfig: {
      modelByStage: {
        "agent.loop": "legacy-model",
      },
    },
    modelCapabilities: {
      visionInputEnabled: false,
    },
  } satisfies TuiProfile;

  const resolved = resolveProfileWithModelPolicy(baseProfile, {
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
  });

  assert.equal(resolved.modelProvider, "openai");
  assert.equal(resolved.model, "gpt-5.4-2026-03-05");
  assert.deepEqual(resolved.agentStageConfig?.modelByStage, {
    "agent.loop": "gpt-5.4-mini",
  });
  assert.equal(resolved.modelTimeoutMs, 45_000);
  assert.equal(resolved.modelCapabilities?.visionInputEnabled, true);
});

contractTest("runtime.hermetic", "resolveProfileWithModelPolicy defaults agent.loop to the shared model when stage overrides are empty", () => {
  const baseProfile = {
    ...createWebDemoProfile(),
    modelProvider: "openrouter",
    model: "z-ai/glm-5.2",
    agentStageConfig: {
      modelByStage: {
        "agent.loop": "legacy-model",
      },
    },
    modelCapabilities: {
      visionInputEnabled: false,
    },
  } satisfies TuiProfile;

  const resolved = resolveProfileWithModelPolicy(baseProfile, {
    version: 1,
    provider: "openrouter",
    model: "deepseek/deepseek-r1-0528",
    modelByStage: {},
    modelCapabilities: {
      visionInputEnabled: false,
    },
  });

  assert.equal(resolved.modelProvider, "openrouter");
  assert.equal(resolved.model, "deepseek/deepseek-r1-0528");
  assert.deepEqual(resolved.agentStageConfig?.modelByStage, {
    "agent.loop": "deepseek/deepseek-r1-0528",
  });
});

contractTest("runtime.hermetic", "model policy store accepts local provider ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kestrel-model-policy-unit-"));

  try {
    const store = new ModelPolicyStore(tempDir);
    const policy = store.write({
      version: 1,
      provider: "ollama",
      model: "llama3.2:3b",
      modelByStage: {},
      modelCapabilities: {
        visionInputEnabled: false,
      },
    });

    assert.equal(policy.provider, "ollama");
    assert.equal(policy.model, "llama3.2:3b");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
