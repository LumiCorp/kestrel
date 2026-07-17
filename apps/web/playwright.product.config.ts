import { defineConfig, devices } from "@playwright/test";

const port = 43_123;
const fakeOpenRouterPort = 43_116;
const postgresPort = 58_433;
const redisPort = 56_380;
const minioApiPort = 59_002;
const minioConsolePort = 59_003;
const workerReadyFile = "/tmp/kestrel-one-product-contract-worker.ready";
const baseURL = `http://127.0.0.1:${port}`;
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/kestrel_product_contract`;
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
  COMPOSE_PROJECT_NAME: "kestrel-one-product-contract",
  LOCAL_POSTGRES_PORT: String(postgresPort),
  LOCAL_REDIS_PORT: String(redisPort),
  LOCAL_MINIO_API_PORT: String(minioApiPort),
  LOCAL_MINIO_CONSOLE_PORT: String(minioConsolePort),
  KESTREL_RUNNER_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/kestrel_product_runtime`,
  KESTREL_SKIP_RAG_FIXTURES: "true",
  NEXT_PUBLIC_APP_URL: baseURL,
  OPENROUTER_API_KEY: "product-contract-key",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${fakeOpenRouterPort}`,
  OPENROUTER_MODEL: "openai/gpt-5.2-chat",
  STORAGE_ACCESS_KEY_ID: "minioadmin",
  STORAGE_BUCKET: "unified-app-storage",
  STORAGE_ENDPOINT: `http://127.0.0.1:${minioApiPort}`,
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_PROVIDER: "local-s3",
  STORAGE_REGION: "us-east-1",
  STORAGE_SECRET_ACCESS_KEY: "minioadmin",
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
};

export default defineConfig({
  globalSetup: "./tests/product/global-setup.ts",
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
      command: "./scripts/product-dev-all.sh",
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: webServerEnv,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(process.env.KESTREL_PRODUCT_WEBKIT === "true"
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
      : []),
  ],
});
