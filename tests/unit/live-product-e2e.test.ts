import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapLiveProductEnv,
  classifyStepStatus,
  validateExternalProviderEnv,
} from "../../scripts/live-product-e2e.js";

test("live-product-e2e classifies database connectivity errors as infra_failed", () => {
  const status = classifyStepStatus(
    {
      id: "ops.cli",
      phase: "cli",
      title: "Ops CLI",
      command: "pnpm",
      args: ["run", "test:ops:cli"],
      requiresDatabase: true,
    },
    1,
    "AggregateError ECONNREFUSED",
    "",
  );
  assert.equal(status.status, "infra_failed");
});

test("live-product-e2e classifies web compile failures as build_failed", () => {
  const status = classifyStepStatus(
    {
      id: "ops.web",
      phase: "web",
      title: "Ops web",
      command: "pnpm",
      args: ["run", "test:ops:web"],
      requiresDatabase: true,
    },
    1,
    "",
    "Failed to compile.\nType error: Property 'status' does not exist",
  );
  assert.equal(status.status, "build_failed");
});

test("live-product-e2e classifies research stall convergence as failed", () => {
  const status = classifyStepStatus(
    {
      id: "core.operator-journey",
      phase: "core",
      title: "Core operator journey",
      command: "pnpm",
      args: ["run", "live:test:operator"],
    },
    1,
    "",
    "terminal reasonCode=research_stalled_partial",
  );
  assert.equal(status.status, "failed");
  assert.deepEqual(status.diagnostics, ["runtime research stall convergence"]);
});

test("live-product-e2e validates required provider credentials", () => {
  const missing = validateExternalProviderEnv({
    OPENROUTER_API_KEY: "",
    TAVILY_API_KEY: "",
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0] ?? "", /OPENROUTER_API_KEY/);
  assert.match(missing[0] ?? "", /TAVILY_API_KEY/);

  const present = validateExternalProviderEnv({
    OPENROUTER_API_KEY: "test",
    TAVILY_API_KEY: "test",
  });
  assert.deepEqual(present, []);
});

test("live-product-e2e bootstraps provider credentials from .env", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-live-product-env-"));
  await writeFile(
    path.join(tempDir, ".env"),
    [
      "OPENROUTER_API_KEY=dotenv-openrouter",
      "TAVILY_API_KEY=dotenv-tavily",
    ].join("\n"),
    "utf8",
  );

  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousTavily = process.env.TAVILY_API_KEY;
  process.env.OPENROUTER_API_KEY = "";
  process.env.TAVILY_API_KEY = "";

  try {
    await bootstrapLiveProductEnv(tempDir);
    assert.equal(process.env.OPENROUTER_API_KEY, "dotenv-openrouter");
    assert.equal(process.env.TAVILY_API_KEY, "dotenv-tavily");
  } finally {
    process.env.OPENROUTER_API_KEY = previousOpenRouter;
    process.env.TAVILY_API_KEY = previousTavily;
  }
});
