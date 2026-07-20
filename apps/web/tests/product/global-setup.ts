import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set by the product contract launcher.`);
  }
  return value;
}

const appPort = requiredEnvironmentValue("KESTREL_PRODUCT_APP_PORT");
const baseURL = `http://127.0.0.1:${appPort}`;
const workerReadyFile = requiredEnvironmentValue(
  "KESTREL_PRODUCT_WORKER_READY_FILE"
);
const prewarmNavigationTimeoutMs = 90_000;

async function waitForWorkerReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await access(workerReadyFile);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Kestrel One durable turn worker did not become ready.");
}

export default async function globalSetup() {
  await waitForWorkerReady();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    const threadId = randomUUID();

    await page.goto("/dashboard", {
      waitUntil: "commit",
      timeout: prewarmNavigationTimeoutMs,
    });
    await page.goto(`/threads/${threadId}`, {
      waitUntil: "commit",
      timeout: prewarmNavigationTimeoutMs,
    });
    await page.request.post("/api/mobile/v2/threads", { data: {} });
    await page.request.get(`/api/mobile/v2/threads/${threadId}`);
    await page.request.get(`/api/threads/${threadId}`);
    await page.request.post("/api/kestrel/gateway-credentials/lease", {
      data: {},
    });
  } finally {
    await browser.close();
  }
}
