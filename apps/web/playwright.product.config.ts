import { defineConfig, devices } from "@playwright/test";

function requiredPort(name: string): number {
  const value = process.env[name];
  if (!(value && /^\d+$/u.test(value))) {
    throw new Error(`${name} must be set by the product contract launcher.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return port;
}

const port = requiredPort("KESTREL_PRODUCT_APP_PORT");
const fakeOpenRouterPort = requiredPort(
  "KESTREL_PRODUCT_FAKE_OPENROUTER_PORT"
);
const runnerPort = requiredPort("KESTREL_PRODUCT_RUNNER_PORT");
const workerReadyFile = process.env.KESTREL_PRODUCT_WORKER_READY_FILE;
if (!workerReadyFile) {
  throw new Error(
    "KESTREL_PRODUCT_WORKER_READY_FILE must be set by the product contract launcher."
  );
}
const baseURL = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.KESTREL_PRODUCT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("KESTREL_PRODUCT_DATABASE_URL must be set by validation.");
}
const storageRoot = process.env.KESTREL_PRODUCT_STORAGE_ROOT;
if (!storageRoot) {
  throw new Error("KESTREL_PRODUCT_STORAGE_ROOT must be set by validation.");
}
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  )
);
const webServerEnv = {
  ...inheritedEnv,
  AI_AGENT_API_KEY: "product-contract-key",
  AI_AGENT_BASE_URL: `http://127.0.0.1:${fakeOpenRouterPort}`,
  AI_AGENT_MODEL: "openai/gpt-5.2-chat",
  AI_PROVIDER: "openrouter",
  BETTER_AUTH_URL: baseURL,
  DATABASE_URL: databaseUrl,
  DEV_ALL_HOST: "127.0.0.1",
  DEV_ALL_PORT: String(port),
  DEV_AUTH_BYPASS: "true",
  KESTREL_DISABLE_DOTENV: "1",
  KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "product-contract-key",
  KESTREL_GATEWAY_CREDENTIAL_KEYS:
    '{"product-contract-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
  KESTREL_ONE_APP_URL: baseURL,
  KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "product-contract-broker",
  KESTREL_ONE_TOOL_TOKEN: "product-contract-tool",
  KESTREL_PRODUCT_CONTRACT: "true",
  KESTREL_TURN_WORKER_READY_FILE: workerReadyFile,
  KESTREL_RUNNER_SERVICE_PORT: String(runnerPort),
  KESTREL_RUNNER_DATABASE_URL: process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL ?? databaseUrl,
  KESTREL_SKIP_RAG_FIXTURES: "true",
  NEXT_PUBLIC_APP_URL: baseURL,
  OPENROUTER_API_KEY: "product-contract-key",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${fakeOpenRouterPort}`,
  OPENROUTER_MODEL: "openai/gpt-5.2-chat",
  STORAGE_PROVIDER: "local",
  STORAGE_LOCAL_ROOT: storageRoot,
};

export default defineConfig({
  metadata: {
    fakeOpenRouterUrl: `http://127.0.0.1:${fakeOpenRouterPort}`,
  },
  testDir: "./tests/product",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "test-results/product",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node --import tsx ../../tests/ops/helpers/fake-open-router.ts --port ${fakeOpenRouterPort}`,
      url: `http://127.0.0.1:${fakeOpenRouterPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node scripts/product-validation-stack.mjs",
      url: `${baseURL}/api/health`,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
      reuseExistingServer: false,
      timeout: 180_000,
      env: webServerEnv,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
