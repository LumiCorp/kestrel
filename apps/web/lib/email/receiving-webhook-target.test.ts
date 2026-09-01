import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareReceivingWebhookIntent,
  ReceivingWebhookTargetError,
  requiresReceivingWebhookOverride,
  resolveReceivingWebhookBaseUrl,
} from "./receiving-webhook-target";

test("local development requires an explicit public webhook origin", () => {
  const env: NodeJS.ProcessEnv = {
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43103",
    NODE_ENV: "test",
  };
  assert.equal(requiresReceivingWebhookOverride(env), true);
  assert.throws(
    () => resolveReceivingWebhookBaseUrl({ env }),
    (error: unknown) =>
      error instanceof ReceivingWebhookTargetError &&
      error.code === "RESEND_RECEIVING_PUBLIC_WEBHOOK_URL_REQUIRED",
  );
  assert.equal(
    resolveReceivingWebhookBaseUrl({
      env,
      requestedBaseUrl: "https://kestrel-dev.ngrok.app",
    }),
    "https://kestrel-dev.ngrok.app",
  );
});

test("webhook overrides reject non-public or non-origin URLs", () => {
  const env: NodeJS.ProcessEnv = {
    NEXT_PUBLIC_APP_URL: "http://localhost:43103",
    NODE_ENV: "test",
  };
  for (const requestedBaseUrl of [
    "http://public.example.test",
    "https://localhost:43103",
    "https://public.example.test/path",
    "https://public.example.test?query=yes",
  ]) {
    assert.throws(
      () => resolveReceivingWebhookBaseUrl({ env, requestedBaseUrl }),
      (error: unknown) =>
        error instanceof ReceivingWebhookTargetError &&
        error.code === "RESEND_RECEIVING_WEBHOOK_URL_INVALID",
    );
  }
});

test("hosted deployments use their configured origin and reject overrides", () => {
  const env: NodeJS.ProcessEnv = {
    NEXT_PUBLIC_APP_URL: "https://one.example.test",
    NODE_ENV: "test",
  };
  assert.equal(requiresReceivingWebhookOverride(env), false);
  assert.equal(
    resolveReceivingWebhookBaseUrl({ env }),
    "https://one.example.test",
  );
  assert.throws(
    () =>
      resolveReceivingWebhookBaseUrl({
        env,
        requestedBaseUrl: "https://other.example.test",
      }),
    (error: unknown) =>
      error instanceof ReceivingWebhookTargetError &&
      error.code === "RESEND_RECEIVING_WEBHOOK_URL_INVALID",
  );
});

test("the durable intent appends only the secret route locator", () => {
  assert.deepEqual(
    prepareReceivingWebhookIntent({
      env: {
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43103",
        NODE_ENV: "test",
      },
      requestedBaseUrl: "https://kestrel-dev.ngrok.app",
      routeLocator: "route/locator",
    }),
    {
      endpoint:
        "https://kestrel-dev.ngrok.app/api/webhooks/resend/inbound/route%2Flocator",
      events: ["email.received"],
    },
  );
});
