import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  hasMicrosoft365PackScopes,
  MICROSOFT_365_PACKS,
  microsoft365PackAllowsCapability,
  parseMicrosoftOAuthScopes,
  scopesForMicrosoft365Packs,
} from "./microsoft-365-contract";

contractTest("web.hermetic", "Microsoft 365 packs request bounded delegated scopes", () => {
  assert.deepEqual(Object.keys(MICROSOFT_365_PACKS), [
    "outlook",
    "teams",
    "sharepoint",
  ]);
  const outlook = scopesForMicrosoft365Packs(["outlook"]);
  assert.ok(outlook.includes("Mail.Read"));
  assert.ok(outlook.includes("Mail.Send"));
  assert.ok(outlook.includes("Calendars.Read"));
  assert.ok(!outlook.includes("Chat.Read"));
  assert.ok(!outlook.includes("Sites.Read.All"));

  const widened = scopesForMicrosoft365Packs(["outlook", "teams"]);
  assert.ok(widened.includes("Chat.Read"));
  assert.ok(widened.includes("ChatMessage.Send"));
  assert.ok(!widened.includes("Sites.Read.All"));
});

contractTest("web.hermetic", "unselected Microsoft 365 packs cannot expose capabilities", () => {
  assert.equal(
    microsoft365PackAllowsCapability({
      selectedPacks: ["outlook"],
      capabilityMetadata: { pack: "outlook" },
    }),
    true
  );
  assert.equal(
    microsoft365PackAllowsCapability({
      selectedPacks: ["outlook"],
      capabilityMetadata: { pack: "teams" },
    }),
    false
  );
  assert.equal(
    microsoft365PackAllowsCapability({
      selectedPacks: ["outlook"],
      capabilityMetadata: {},
    }),
    false
  );
});

contractTest("web.hermetic", "Microsoft 365 scope checks are case-insensitive", () => {
  const scopes = scopesForMicrosoft365Packs(["sharepoint"]);
  assert.equal(
    hasMicrosoft365PackScopes({
      grantedScopes: parseMicrosoftOAuthScopes(scopes.join(" ").toUpperCase()),
      packs: ["sharepoint"],
    }),
    true
  );
  assert.equal(
    hasMicrosoft365PackScopes({
      grantedScopes: ["User.Read", "Sites.Read.All"],
      packs: ["sharepoint"],
    }),
    true
  );
  assert.equal(
    hasMicrosoft365PackScopes({
      grantedScopes: ["openid", "profile", "email", "offline_access", "User.Read"],
      packs: ["sharepoint"],
    }),
    false
  );
});
