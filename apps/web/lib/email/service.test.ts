import assert from "node:assert/strict";
import type { ResolvedEmailConfig } from "./config";
import { deliverTransactionalEmail, EmailDeliveryError } from "./service";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function config(
  overrides: Partial<ResolvedEmailConfig> = {}
): ResolvedEmailConfig {
  return {
    provider: "resend",
    enabled: true,
    credentialSource: "environment",
    apiKey: "re_test",
    fromName: "Kestrel One",
    fromEmail: "hello@example.com",
    replyTo: null,
    status: "ready",
    credentialConfigured: true,
    lastTestedAt: new Date(),
    lastTestMessageId: "test-id",
    lastErrorCode: null,
    configFingerprint: "fingerprint",
    configRevision: new Date(),
    persisted: true,
    ...overrides,
  };
}

const message = {
  kind: "password_reset" as const,
  to: "user@example.com",
  subject: "Reset",
  html: "reset body",
  developmentContent: "https://secret.example/reset",
  idempotencyKey: "password-reset-token",
};

contractTest("web.hermetic", "transactional email uses the dynamically resolved provider", async () => {
  let receivedKey = "";
  const result = await deliverTransactionalEmail(message, {
    resolveConfig: async () => config(),
    sendWithResend: async (resolved) => {
      receivedKey = resolved.apiKey ?? "";
      return { id: "accepted" };
    },
    environment: "production",
  });
  assert.equal(result.id, "accepted");
  assert.equal(receivedKey, "re_test");
});

contractTest("web.hermetic", "production failure never logs sensitive delivery content", async () => {
  const logged: string[] = [];
  await assert.rejects(
    deliverTransactionalEmail(message, {
      resolveConfig: async () => config({ enabled: false, apiKey: null }),
      environment: "production",
      logDevelopment: (value) => logged.push(value),
    }),
    EmailDeliveryError
  );
  assert.deepEqual(logged, []);
});

contractTest("web.hermetic", "production normalizes configuration resolution failures", async () => {
  await assert.rejects(
    deliverTransactionalEmail(message, {
      resolveConfig: async () => {
        throw new Error("database connection exposed detail");
      },
      environment: "production",
    }),
    (error: unknown) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.code, "EMAIL_DELIVERY_UNAVAILABLE");
      assert.doesNotMatch(error.message, /database connection exposed detail/);
      return true;
    }
  );
});

contractTest("web.hermetic", "development emits actionable console delivery when provider is unavailable", async () => {
  const logged: string[] = [];
  const result = await deliverTransactionalEmail(message, {
    resolveConfig: async () => config({ enabled: false, apiKey: null }),
    environment: "development",
    logDevelopment: (value) => logged.push(value),
  });
  assert.equal(result.id, "development:password_reset");
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /https:\/\/secret\.example\/reset/);
});

contractTest("web.hermetic", "development falls back when configuration resolution fails", async () => {
  const logged: string[] = [];
  const result = await deliverTransactionalEmail(message, {
    resolveConfig: async () => {
      throw new Error("configuration unavailable");
    },
    environment: "development",
    logDevelopment: (value) => logged.push(value),
  });

  assert.equal(result.id, "development:password_reset");
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /https:\/\/secret\.example\/reset/);
});

contractTest("web.hermetic", "persisted delivery fails closed when the configuration is not ready", async () => {
  let providerCalled = false;
  await assert.rejects(
    deliverTransactionalEmail(message, {
      resolveConfig: async () => config({ status: "needs_test" }),
      sendWithResend: async () => {
        providerCalled = true;
        return { id: "unexpected" };
      },
      environment: "production",
    }),
    EmailDeliveryError
  );
  assert.equal(providerCalled, false);
});

contractTest("web.hermetic", "unpersisted environment configuration preserves legacy delivery", async () => {
  const result = await deliverTransactionalEmail(message, {
    resolveConfig: async () =>
      config({
        status: "needs_test",
        configRevision: null,
        persisted: false,
      }),
    sendWithResend: async () => ({ id: "legacy-accepted" }),
    environment: "production",
  });
  assert.equal(result.id, "legacy-accepted");
});
