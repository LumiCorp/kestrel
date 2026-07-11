import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseBenchmarkSmokeArgs,
  runBenchmarkSmoke,
} from "../../scripts/benchmark-smoke.js";
import {
  benchmarkProfileMode,
  benchmarkTurnMode,
  loadBenchmarkDotEnv,
} from "../../scripts/benchmark-provider-config.js";

test("benchmark smoke defaults to offline mode", () => {
  assert.deepEqual(parseBenchmarkSmokeArgs([]), {
    livePreflight: false,
  });
  assert.deepEqual(parseBenchmarkSmokeArgs(["--live-preflight"]), {
    livePreflight: true,
  });
});

test("benchmark smoke validates offline benchmark contracts", async () => {
  const code = await runBenchmarkSmoke([]);

  assert.equal(code, 0);
});

test("benchmark mode helpers expose canonical build full-auto mode", () => {
  assert.deepEqual(benchmarkTurnMode(), {
    interactionMode: "build",
    actSubmode: "full_auto",
  });
  assert.deepEqual(benchmarkProfileMode(), {
    defaultInteractionMode: "build",
    defaultActSubmode: "full_auto",
  });
});

test("benchmark dotenv loader ignores repo model while loading benchmark credentials", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kestrel-benchmark-dotenv-"));
  try {
    await writeFile(
      path.join(tmp, ".env"),
      [
        "OPENROUTER_API_KEY=dotenv-key",
        "OPENROUTER_MODEL=dotenv-model",
        "KCHAT_MODEL_TIMEOUT_MS=12345",
        "UNRELATED_ENV=ignored",
      ].join("\n"),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "shell-key",
      OPENROUTER_MODEL: "shell-model",
      UNRELATED_ENV: "shell-value",
    };

    loadBenchmarkDotEnv(tmp, env);

    assert.equal(env.OPENROUTER_API_KEY, "dotenv-key");
    assert.equal(env.OPENROUTER_MODEL, "shell-model");
    assert.equal(env.KCHAT_MODEL_TIMEOUT_MS, "12345");
    assert.equal(env.UNRELATED_ENV, "shell-value");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("benchmark dotenv loader no-ops without .env and honors disable flag", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kestrel-benchmark-dotenv-disabled-"));
  try {
    const missingEnv: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "shell-key" };
    loadBenchmarkDotEnv(tmp, missingEnv);
    assert.equal(missingEnv.OPENROUTER_API_KEY, "shell-key");

    await writeFile(path.join(tmp, ".env"), "OPENROUTER_API_KEY=dotenv-key\n", "utf8");
    const disabledEnv: NodeJS.ProcessEnv = {
      KESTREL_DISABLE_DOTENV: "1",
      OPENROUTER_API_KEY: "shell-key",
    };
    loadBenchmarkDotEnv(tmp, disabledEnv);
    assert.equal(disabledEnv.OPENROUTER_API_KEY, "shell-key");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
