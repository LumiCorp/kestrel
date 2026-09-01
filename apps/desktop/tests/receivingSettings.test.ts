import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Desktop receiving UX is tenant-explicit, role-gated, and hosted", async () => {
  const source = await fs.readFile(
    path.join(root, "renderer/src/SettingsWorkspace.tsx"),
    "utf8",
  );
  assert.match(source, /Inbound receiving/u);
  assert.match(source, /Choose an Organization/u);
  assert.match(source, /organizationRole === "owner"/u);
  assert.match(source, /organizationRole === "admin"/u);
  assert.match(source, /Read-only receiving status/u);
  assert.match(source, /ReceivingConnectionStatus/u);
  assert.match(source, /Resend-managed receiving domain/u);
  assert.match(source, /receivingManagedDomain/u);
  assert.match(source, /Kestrel One keeps receiving when Desktop is closed or offline/u);
  assert.match(source, /setReceivingApiKey\(""\)/u);
});

test("Desktop receiving crosses the typed account bridge and never DesktopSettings", async () => {
  const [contracts, preload, main, settingsStore, supportBundle] = await Promise.all([
    fs.readFile(path.join(root, "src/contracts.ts"), "utf8"),
    fs.readFile(path.join(root, "src/preload.ts"), "utf8"),
    fs.readFile(path.join(root, "src/main.ts"), "utf8"),
    fs.readFile(path.join(root, "src/settingsStore.ts"), "utf8"),
    fs.readFile(path.join(root, "src/supportBundle.ts"), "utf8"),
  ]);
  for (const source of [contracts, preload, main]) {
    assert.match(source, /KestrelOneReceiving|kestrel-one-receiving/u);
  }
  assert.match(contracts, /receivingDomain\?: string/u);
  assert.match(main, /\.resend\\\.app/u);
  for (const source of [settingsStore, supportBundle]) {
    assert.doesNotMatch(
      source,
      /receivingApiKey|receivingConnection|routeLocator|providerWebhookId|signingSecret/u,
    );
  }
});
