import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relative: string) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("Teams connects through the hosted broker and resolves its token before legacy Microsoft token access", async () => {
  const [connectionRoute, runtimeRoute, card] = await Promise.all([
    source("../../app/api/apps/microsoft-365/route.ts"),
    source("../../app/api/runtime/microsoft-365/action/route.ts"),
    source("../../components/apps/microsoft-365-connection-card.tsx"),
  ]);
  assert.match(connectionRoute, /startHostedPersonalAuthorization\(\{/u);
  assert.match(connectionRoute, /provider:\s*"microsoft_365"/u);
  assert.doesNotMatch(connectionRoute, /auth\.api/u);
  assert.doesNotMatch(connectionRoute, /MICROSOFT_CLIENT_(?:ID|SECRET)/u);
  assert.match(connectionRoute, /requireMicrosoft365TeamsConnectionPacks/u);
  assert.match(
    connectionRoute,
    /configured:\s*registration\.status === "ready"/u,
    "A malformed Platform registration must not appear connectable.",
  );
  assert.match(card, /const TEAMS_PACKS: Microsoft365Pack\[\] = \["teams"\]/u);
  assert.doesNotMatch(card, /outlook|sharepoint/iu);

  const teamsBranch = runtimeRoute.slice(
    runtimeRoute.indexOf("if (isTeamsOperation(input.operation))"),
    runtimeRoute.indexOf("function isTeamsOperation"),
  );
  assert.match(teamsBranch, /resolveHostedPersonalProviderToken\(\{/u);
  assert.match(teamsBranch, /provider:\s*"microsoft_365"/u);
  assert.ok(
    runtimeRoute.indexOf("if (isTeamsOperation(input.operation))") <
      runtimeRoute.indexOf("auth.api.getAccessToken"),
    "Teams must reach the broker before the deferred legacy token path.",
  );
});
