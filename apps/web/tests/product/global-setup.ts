import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

const baseURL = "http://127.0.0.1:43123";
const workerReadyFile = "/tmp/kestrel-one-product-contract-worker.ready";

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

    await page.goto("/dashboard");
    await page.goto(`/threads/${threadId}`);
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
