import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = new URL(process.argv[2]);
assert.equal(base.protocol, "https:");
assert.equal(base.username + base.password, "");
assert.equal(base.pathname, "/");
assert.equal(base.search + base.hash, "");
const browser = await chromium.launch({ headless: true });
const watchdog = setTimeout(() => { console.error("Fixture check exceeded 30 seconds"); void browser.close(); }, 30_000);
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(new URL("/fixture", base).href, { waitUntil: "networkidle" });
  if ((await page.title()).startsWith("ERR_NGROK_6024")) {
    await page.getByText("Visit Site", { exact: true }).click();
    console.info("Fresh-profile ngrok acknowledgement completed with ordinary click");
  }
  await page.getByRole("heading", { name: "Kestrel transfer fixture", exact: true }).waitFor();
  const bytes = Buffer.from("Chromium synthetic upload through ngrok\n");
  const sent = page.waitForResponse(response => response.url() === new URL("/fixture/upload", base).href && response.request().method() === "POST");
  await page.getByLabel("Attachment", { exact: true }).setInputFiles({ name: "proof.txt", mimeType: "text/plain", buffer: bytes });
  const response = await sent;
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("{"));
  assert.deepEqual(JSON.parse(await page.locator("#status").innerText()), { receivedBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  console.info("Upload receiver digest matched");
  const pending = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download fixture", exact: true }).click();
  const download = await pending;
  console.info("Download event received; waiting for file completion");
  assert.equal(download.suggestedFilename(), "fixture.txt");
  assert.deepEqual(await readFile(await download.path()), Buffer.from("Kestrel Fly transfer fixture: exact bytes\n"));
  await download.delete();
  console.info("PASS: real Chromium fixture, receiver-verified upload, exact download. Not a hosted Browser approval test.");
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
