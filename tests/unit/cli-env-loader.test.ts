import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadShellAndDotEnv, parseDotEnv } from "../../cli/config/EnvLoader.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseDotEnv parses quoted and unquoted values", () => {
  const parsed = parseDotEnv([
    "OPENROUTER_MODEL=openai/gpt-5.2",
    'OPENROUTER_BASE_URL="https://openrouter.ai"',
    "OPENROUTER_SITE_URL='https://example.test'",
  ].join("\n"));

  assert.equal(parsed.OPENROUTER_MODEL, "openai/gpt-5.2");
  assert.equal(parsed.OPENROUTER_BASE_URL, "https://openrouter.ai");
  assert.equal(parsed.OPENROUTER_SITE_URL, "https://example.test");
});

contractTest("runtime.hermetic", "loadShellAndDotEnv keeps existing shell values by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-env-loader-default-"));
  await writeFile(
    path.join(tempDir, ".env"),
    [
      "OPENROUTER_MODEL=openai/gpt-5.2",
      "OPENROUTER_BASE_URL=https://openrouter.ai",
    ].join("\n"),
    "utf8",
  );

  const previousModel = process.env.OPENROUTER_MODEL;
  const previousBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_MODEL = "shell/model";
  process.env.OPENROUTER_BASE_URL = "https://shell.example";

  try {
    await loadShellAndDotEnv(tempDir);
    assert.equal(process.env.OPENROUTER_MODEL, "shell/model");
    assert.equal(process.env.OPENROUTER_BASE_URL, "https://shell.example");
  } finally {
    process.env.OPENROUTER_MODEL = previousModel;
    process.env.OPENROUTER_BASE_URL = previousBase;
  }
});

contractTest("runtime.hermetic", "loadShellAndDotEnv prefers .env for selected keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-env-loader-prefer-"));
  await writeFile(
    path.join(tempDir, ".env"),
    [
      "OPENROUTER_MODEL=openai/gpt-5.2",
      "OPENROUTER_BASE_URL=https://openrouter.ai",
    ].join("\n"),
    "utf8",
  );

  const previousModel = process.env.OPENROUTER_MODEL;
  const previousBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_MODEL = "shell/model";
  process.env.OPENROUTER_BASE_URL = "https://shell.example";

  try {
    await loadShellAndDotEnv(tempDir, {
      preferDotEnvKeys: ["OPENROUTER_MODEL", "OPENROUTER_BASE_URL"],
    });
    assert.equal(process.env.OPENROUTER_MODEL, "openai/gpt-5.2");
    assert.equal(process.env.OPENROUTER_BASE_URL, "https://openrouter.ai");
  } finally {
    process.env.OPENROUTER_MODEL = previousModel;
    process.env.OPENROUTER_BASE_URL = previousBase;
  }
});
