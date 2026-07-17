import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 43_103);
const externalBaseURL = process.env.UNIFIED_BASE_URL;
const baseURL = externalBaseURL || `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 4,
  retries: 0,
  use: {
    baseURL,
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: "pnpm dev:all",
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          ...process.env,
          DEV_ALL_HOST: "127.0.0.1",
          DEV_ALL_PORT: String(port),
          NEXT_PUBLIC_APP_URL: baseURL,
          BETTER_AUTH_URL: baseURL,
          DEV_AUTH_BYPASS: "true",
        },
      },
});
