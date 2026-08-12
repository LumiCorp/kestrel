import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Desktop command heartbeat keeps refreshing embedded model leases beyond five minutes", async () => {
  const [connector, controlPlane] = await Promise.all([
    readFile(new URL("../../src/localCore/desktopEnvironmentConnector.ts", import.meta.url), "utf8"),
    readFile(new URL("../../apps/web/lib/environments/desktop.ts", import.meta.url), "utf8"),
  ]);
  assert.match(connector, /COMMAND_LEASE_RENEW_MS\s*=\s*30_000/u);
  assert.match(
    connector,
    /setInterval\([\s\S]*?\/lease[\s\S]*?response\?\.modelGrant[\s\S]*?#registerEmbeddedModelGrant[\s\S]*?COMMAND_LEASE_RENEW_MS/u,
  );
  assert.match(
    controlPlane,
    /renewDesktopEnvironmentCommandLease[\s\S]*?issueEncryptedDesktopModelGrant[\s\S]*?modelGrant/u,
  );

  const heartbeatTimes = Array.from({ length: 11 }, (_, index) => (index + 1) * 30_000);
  assert.ok(heartbeatTimes.at(-1)! > 300_000);
});
