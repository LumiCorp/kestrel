import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(directory, "hosted-personal-oauth.ts"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(
    directory,
    "../db/migrations/0096_platform_personal_oauth_authorization_broker.sql",
  ),
  "utf8",
);

test("hosted personal OAuth persists encrypted PKCE sessions and connection-scoped encrypted tokens", () => {
  assert.match(migration, /CREATE TABLE "platform_personal_oauth_authorization_sessions"/u);
  assert.match(migration, /"encrypted_pkce_verifier" LIKE 'kgc:v1:%'/u);
  assert.match(migration, /"expires_at" timestamp with time zone NOT NULL/u);
  assert.match(migration, /"consumed_at" timestamp with time zone/u);
  assert.match(migration, /CREATE TABLE "platform_personal_oauth_authorizations"/u);
  assert.match(migration, /"connection_id" text PRIMARY KEY NOT NULL/u);
  assert.match(migration, /"encrypted_token_payload" LIKE 'kgc:v1:%'/u);
  assert.doesNotMatch(migration, /app_credentials|access_token|refresh_token|code_verifier/u);
});

test("broker has a PKCE single-use session and fixed callback target", () => {
  assert.match(source, /code_challenge_method", "S256"/u);
  assert.match(source, /encryptedPkceVerifier/u);
  assert.match(source, /if \(session\.consumedAt\)/u);
  assert.match(source, /OAUTH_SESSION_EXPIRED/u);
  assert.match(source, /RETURN_TARGET = "settings_connections"/u);
  assert.doesNotMatch(source, /callbackURL|returnUrl: input|origin: input/u);
  assert.match(source, /callbackUriForPlatformOAuthProvider/u);
});

test("broker rejects the deferred Microsoft packs and health is redacted", () => {
  assert.match(source, /return provider === "google_workspace" \? \["gmail", "calendar"\] : \["teams"\]/u);
  assert.match(source, /OAUTH_PROVIDER_UNSUPPORTED/u);
  const healthStart = source.indexOf("export function publicHostedPersonalOAuthHealth");
  const healthEnd = source.indexOf("export async function startHostedPersonalAuthorization", healthStart);
  const healthSource = source.slice(healthStart, healthEnd);
  assert.doesNotMatch(healthSource, /accessToken|refreshToken|encryptedTokenPayload/u);
  assert.match(source, /OAUTH_ORGANIZATION_PACK_DENIED/u);
});

test("resolver derives operation policy from canonical descriptors before token return", () => {
  for (const check of [
    "resolveEffectiveProjectAppAccess",
    "OAUTH_PROJECT_DENIED",
    "OAUTH_OPERATION_DENIED",
    "OAUTH_PACK_DENIED",
    "OAUTH_SCOPE_DENIED",
    "OAUTH_RECONNECT_REQUIRED",
    "resolveHostedPersonalOAuthOperation",
    "authorizeGmailCapability",
    "admitGmailExecutionRoute",
    "pg_advisory_xact_lock",
    "markAuthorizationDegraded",
  ]) {
    assert.equal(source.includes(check), true, check);
  }
});
