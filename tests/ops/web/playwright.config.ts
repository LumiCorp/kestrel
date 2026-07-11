import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { resolveOpsTestDatabaseUrl } from "../helpers/database.js";

const databaseUrl = resolveOpsTestDatabaseUrl();
const port = 3105;
const fakeOpenRouterPort = 3116;
const runnerServicePort = 3117;
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(process.cwd());
const profileSettingsPath = "/tmp/kestrel-ops-web-profile.json";
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const webServerEnv: Record<string, string> = {
  ...inheritedEnv,
  PORT: String(port),
  DATABASE_URL: databaseUrl,
  KCHAT_OPS_CONSOLE_ENABLED: "true",
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_MODEL: "openai/gpt-5.2-chat",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${fakeOpenRouterPort}`,
  KESTREL_RUNNER_SERVICE_URL: `http://127.0.0.1:${runnerServicePort}`,
  KCHAT_PROFILE_SETTINGS_PATH: profileSettingsPath,
};

export default defineConfig({
  testDir: configDir,
  testMatch: ["ops-console.spec.ts", "cross-surface.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  globalSetup: fileURLToPath(new URL("./global-setup.ts", import.meta.url)),
  webServer: [
    {
      command: `node --import tsx tests/ops/helpers/fakeOpenRouter.ts --port ${fakeOpenRouterPort}`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${fakeOpenRouterPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `node --import tsx cli/runner/service.ts`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${runnerServicePort}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        ...webServerEnv,
        KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1",
        KESTREL_RUNNER_SERVICE_PORT: String(runnerServicePort),
      },
      timeout: 30_000,
    },
    {
      command: "node --import tsx tests/ops/web/startNextServer.ts",
      cwd: repoRoot,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI,
      env: webServerEnv,
      timeout: 300_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
});
