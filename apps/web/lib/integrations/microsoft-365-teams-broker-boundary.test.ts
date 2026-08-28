import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relative: string) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("Outlook and Teams use the hosted broker with no static Microsoft authority", async () => {
  const [connectionRoute, runtimeRoute, card, authSource, registry, profile] = await Promise.all([
    source("../../app/api/apps/microsoft-365/route.ts"),
    source("../../app/api/runtime/microsoft-365/action/route.ts"),
    source("../../components/apps/microsoft-365-connection-card.tsx"),
    source("../auth.ts"),
    source("../tools/registry.ts"),
    source("../agent/kestrel-tool-profile.ts"),
  ]);
  assert.match(connectionRoute, /startHostedPersonalAuthorization\(\{/u);
  assert.match(connectionRoute, /provider:\s*"microsoft_365"/u);
  assert.doesNotMatch(connectionRoute, /auth\.api/u);
  assert.doesNotMatch(connectionRoute, /MICROSOFT_CLIENT_(?:ID|SECRET)/u);
  assert.match(connectionRoute, /requireMicrosoft365HostedConnectionPacks/u);
  assert.match(
    connectionRoute,
    /configured:\s*registration\.status === "ready"/u,
    "A malformed Platform registration must not appear connectable.",
  );
  assert.match(connectionRoute, /availablePacks:\s*registration\.enabledPacks/u);
  assert.match(card, /const HOSTED_PACKS = \["outlook", "teams"\] as const/u);
  assert.match(card, /useState<HostedMicrosoft365Pack\[\]>\(\[\]\)/u);
  assert.match(
    card,
    /next\.packs\.filter\(isHostedMicrosoft365Pack\)/u,
  );
  assert.match(card, /Reconnect Microsoft 365/u);
  assert.match(card, /status\.availablePacks\.filter\(isHostedMicrosoft365Pack\)/u);
  assert.match(card, /availablePacks\.map\(\(pack\) =>/u);
  assert.doesNotMatch(card, /sharepoint/iu);
  assert.match(runtimeRoute, /resolveHostedPersonalProviderToken\(\{/u);
  assert.match(runtimeRoute, /provider:\s*"microsoft_365"/u);
  assert.match(runtimeRoute, /input\.operation === "sites\.search"/u);
  assert.doesNotMatch(runtimeRoute, /auth\.api\.getAccessToken/u);
  assert.doesNotMatch(authSource, /MICROSOFT_CLIENT_(?:ID|SECRET|TENANT)/u);
  assert.doesNotMatch(authSource, /microsoftEntraId/u);
  assert.doesNotMatch(registry, /sharepoint\.sites\.search/u);
  assert.doesNotMatch(profile, /microsoft_365_search_sites/u);
});
