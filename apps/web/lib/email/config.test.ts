import assert from "node:assert/strict";
import {
  createEmailConfigFingerprint,
  matchesEmailTestAuthority,
  type ResolvedEmailConfig,
  toPublicEmailConfig,
} from "./config";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "email configuration fingerprints change with delivery authority", () => {
  const base = {
    credentialSource: "stored" as const,
    apiKey: "re_secret_one",
    fromName: "Kestrel One",
    fromEmail: "hello@example.com",
    replyTo: null,
  };
  const first = createEmailConfigFingerprint(base);
  assert.notEqual(
    first,
    createEmailConfigFingerprint({ ...base, apiKey: "re_secret_two" })
  );
  assert.notEqual(
    first,
    createEmailConfigFingerprint({ ...base, fromEmail: "new@example.com" })
  );
});

contractTest("web.hermetic", "email test authority rejects stale fingerprints and revisions", () => {
  const revision = new Date("2026-07-12T12:00:00.000Z");
  const config: ResolvedEmailConfig = {
    provider: "resend",
    enabled: false,
    credentialSource: "stored",
    apiKey: "re_test",
    fromName: "Kestrel One",
    fromEmail: "hello@example.com",
    replyTo: null,
    status: "disabled",
    credentialConfigured: true,
    lastTestedAt: null,
    lastTestMessageId: null,
    lastErrorCode: null,
    configFingerprint: "current-fingerprint",
    configRevision: revision,
    persisted: true,
  };

  assert.equal(
    matchesEmailTestAuthority(config, "current-fingerprint", revision),
    true
  );
  assert.equal(
    matchesEmailTestAuthority(config, "stale-fingerprint", revision),
    false
  );
  assert.equal(
    matchesEmailTestAuthority(
      config,
      "current-fingerprint",
      new Date("2026-07-12T12:00:01.000Z")
    ),
    false
  );
});

contractTest("web.hermetic", "public email configuration redacts secrets and fingerprints", () => {
  const config: ResolvedEmailConfig = {
    provider: "resend",
    enabled: true,
    credentialSource: "stored",
    apiKey: "re_raw_secret",
    fromName: "Kestrel One",
    fromEmail: "hello@example.com",
    replyTo: null,
    status: "ready",
    credentialConfigured: true,
    lastTestedAt: new Date(),
    lastTestMessageId: "message-id",
    lastErrorCode: null,
    configFingerprint: "secret-derived-fingerprint",
    configRevision: new Date(),
    persisted: true,
  };
  const serialized = JSON.stringify(toPublicEmailConfig(config));
  assert.equal(serialized.includes("re_raw_secret"), false);
  assert.equal(serialized.includes("secret-derived-fingerprint"), false);
  assert.equal(serialized.includes("configRevision"), false);
});
