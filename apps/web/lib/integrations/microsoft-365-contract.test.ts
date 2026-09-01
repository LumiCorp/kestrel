import test from "node:test";
import assert from "node:assert/strict";
import {
  hasMicrosoft365PackScopes,
  hasMicrosoft365CapabilityScopes,
  MICROSOFT_365_PACKS,
  microsoft365TeamsSendEligibility,
  microsoft365PackAllowsCapability,
  microsoft365RuntimeInputSchema,
  parseMicrosoftOAuthScopes,
  requireMicrosoft365HostedConnectionPacks,
  scopesForMicrosoft365Packs,
} from "./microsoft-365-contract";

test("Microsoft 365 packs request bounded delegated scopes", () => {
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

test("unselected Microsoft 365 packs cannot expose capabilities", () => {
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

test("Microsoft 365 scope checks are case-insensitive", () => {
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

test("Outlook and Teams use their own canonical granted-scope checks", () => {
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["mail.read"],
      capability: "outlook.mail.read",
    }),
    true,
  );
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["Mail.Read"],
      capability: "outlook.mail.send",
    }),
    false,
  );
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["chat.read"],
      capability: "teams.chat.read",
    }),
    true,
  );
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["Chat.Read"],
      capability: "teams.chat.send",
    }),
    false,
  );
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["Chat.Read"],
      capability: "teams.chat.messages.read",
    }),
    true,
  );
  assert.equal(
    hasMicrosoft365CapabilityScopes({
      grantedScopes: ["ChatMessage.Send"],
      capability: "teams.chat.send",
    }),
    true,
  );
});

test("Teams chat and message reads have distinct runtime input contracts", () => {
  assert.deepEqual(
    microsoft365RuntimeInputSchema.parse({ operation: "chats.list" }),
    { operation: "chats.list", maxResults: 20 },
  );
  assert.throws(
    () =>
      microsoft365RuntimeInputSchema.parse({
        operation: "chats.list",
        chatId: "chat-1",
      }),
    /unrecognized key/iu,
  );
  assert.throws(
    () => microsoft365RuntimeInputSchema.parse({ operation: "chat.messages.list" }),
    /chatId/u,
  );
  assert.deepEqual(
    microsoft365RuntimeInputSchema.parse({
      operation: "chat.messages.list",
      chatId: "chat-1",
    }),
    { operation: "chat.messages.list", chatId: "chat-1", maxResults: 20 },
  );
});

test("the hosted Microsoft connection admits Outlook and Teams while keeping tenant consent send-specific", () => {
  assert.deepEqual(requireMicrosoft365HostedConnectionPacks(["outlook"]), ["outlook"]);
  assert.deepEqual(requireMicrosoft365HostedConnectionPacks(["teams"]), ["teams"]);
  assert.deepEqual(requireMicrosoft365HostedConnectionPacks(["teams", "outlook"]), ["outlook", "teams"]);
  assert.throws(
    () => requireMicrosoft365HostedConnectionPacks(["outlook", "sharepoint"]),
    /Only Outlook and Teams capability pack/u,
  );
  assert.equal(
    microsoft365TeamsSendEligibility(["Chat.Read"]),
    "tenant_admin_consent_required",
  );
  assert.equal(
    microsoft365TeamsSendEligibility(["Chat.Read", "ChatMessage.Send"]),
    "granted",
  );
});
