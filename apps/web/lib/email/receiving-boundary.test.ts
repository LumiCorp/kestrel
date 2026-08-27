import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const config = fs.readFileSync(new URL("./receiving-config.ts", import.meta.url), "utf8");
const browserRoute = fs.readFileSync(
  new URL("../../app/api/organization/email/receiving/route.ts", import.meta.url),
  "utf8",
);
const desktopRoute = fs.readFileSync(
  new URL(
    "../../app/api/desktop/v1/organizations/[organizationId]/email/receiving/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const outbound = fs.readFileSync(new URL("./organization-config.ts", import.meta.url), "utf8");
const onePresentation = fs.readFileSync(
  new URL("../../components/settings/receiving-client.tsx", import.meta.url),
  "utf8",
);
const desktopPresentation = fs.readFileSync(
  new URL("../../../desktop/renderer/src/SettingsWorkspace.tsx", import.meta.url),
  "utf8",
);

test("receiving projection excludes provider and routing secrets", () => {
  const publicType = config.slice(
    config.indexOf("export type PublicReceivingConnection"),
    config.indexOf("export type ReceivingDomainOption"),
  );
  assert.doesNotMatch(
    publicType,
    /apiKey|signingSecret|routeLocator|providerWebhookId|receivingDomainId/u,
  );
  assert.match(config, /randomBytes\(32\)\.toString\("base64url"\)/u);
  assert.match(config, /pg_advisory_xact_lock/u);
});

test("receiving mutations stay Admin-only while Desktop members can read the public projection", () => {
  assert.match(browserRoute, /requireOrganizationAdmin/u);
  assert.match(desktopRoute, /GET[\s\S]*requireDesktopReceivingMember/u);
  assert.match(desktopRoute, /requireDesktopReceivingAdmin/u);
  assert.match(desktopRoute, /organizationId/u);
});

test("inbound configuration remains separate from outbound Email App state", () => {
  assert.doesNotMatch(outbound, /organizationReceivingConnections|receivingDomain|webhookStatus/u);
  assert.doesNotMatch(config, /syncOrganizationEmailAppConnection|email\.send/u);
});

test("One and Desktop present the same server-owned receiving health evidence", () => {
  for (const source of [onePresentation, desktopPresentation]) {
    for (const label of [
      "Overall readiness",
      "Inbound:",
      "Credential validated:",
      "Domain checked:",
      "Health checked:",
      "Last test:",
      "Last failure:",
    ]) {
      assert.match(source, new RegExp(label, "u"));
    }
    for (const field of [
      "readiness",
      "inboundEnabled",
      "credentialValidatedAt",
      "domainCheckedAt",
      "lastHealthCheckedAt",
      "lastTestedAt",
      "lastErrorCode",
    ]) {
      assert.match(source, new RegExp(field, "u"));
    }
  }
});
