import test from "node:test";
import assert from "node:assert/strict";
import {
  callbackUriForPlatformOAuthProvider,
  PlatformOAuthRegistrationError,
  scopesForPlatformOAuthRegistration,
  toPublicPlatformOAuthRegistration,
} from "./platform-oauth-registrations";

test("Platform registration callbacks are fixed Kestrel One integration callbacks", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    NEXT_PUBLIC_APP_URL: "https://one.example.test",
  };
  assert.equal(
    callbackUriForPlatformOAuthProvider("google_workspace", env),
    "https://one.example.test/api/integrations/oauth/google-workspace/callback",
  );
  assert.equal(
    callbackUriForPlatformOAuthProvider("microsoft_365", env),
    "https://one.example.test/api/integrations/oauth/microsoft-365/callback",
  );
});

test("Platform registration derives only the in-scope provider packs", () => {
  const googleScopes = scopesForPlatformOAuthRegistration({
    provider: "google_workspace",
    packs: ["gmail", "calendar"],
  });
  assert.deepEqual(googleScopes, [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]);

  assert.deepEqual(
    scopesForPlatformOAuthRegistration({
      provider: "microsoft_365",
      packs: ["teams"],
    }),
    [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Chat.Read",
      "ChatMessage.Send",
    ],
  );
});

test("Platform registration rejects deferred Outlook and SharePoint packs", () => {
  for (const pack of ["outlook", "sharepoint"]) {
    assert.throws(
      () =>
        scopesForPlatformOAuthRegistration({
          provider: "microsoft_365",
          packs: [pack],
        }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformOAuthRegistrationError);
        assert.equal(error.code, "OAUTH_PACK_UNSUPPORTED");
        return true;
      },
    );
  }
});

test("public Platform registration state never serializes an encrypted secret", () => {
  const storedSecret = "kgc:v1:key:iv:tag:provider-secret";
  const publicRegistration = toPublicPlatformOAuthRegistration({
    provider: "google_workspace",
    clientId: "google-client-id",
    encryptedClientSecret: storedSecret,
    enabled: true,
    enabledPacks: ["gmail"],
    revision: 4,
    updatedAt: new Date("2026-08-28T12:00:00.000Z"),
    persisted: true,
    env: {
      NODE_ENV: "test",
      NEXT_PUBLIC_APP_URL: "https://one.example.test",
    },
  });
  const serialized = JSON.stringify(publicRegistration);
  assert.equal(serialized.includes(storedSecret), false);
  assert.equal(serialized.includes("provider-secret"), false);
  assert.equal(publicRegistration.revision, 4);
  assert.equal(publicRegistration.status, "ready");
});
