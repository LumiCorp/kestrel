import assert from "node:assert/strict";
import { getStripeBillingConfigStatus } from "./config";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "stripe billing config reports missing values when billing is enabled", () => {
  const config = getStripeBillingConfigStatus({
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    BETTER_AUTH_URL: "http://127.0.0.1:43103",
  });

  assert.equal(config.isReady, false);
  assert.deepEqual(config.missingEnvVars, [
    "STRIPE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_PRICE_ID",
    "STRIPE_PRO_ANNUAL_PRICE_ID",
    "STRIPE_PLUS_PRICE_ID",
    "STRIPE_PLUS_ANNUAL_PRICE_ID",
  ]);
  assert.equal(
    config.webhookUrl,
    "http://127.0.0.1:43103/api/auth/stripe/webhook"
  );
});

contractTest("web.hermetic", "stripe billing config reports ready when all required vars exist", () => {
  const config = getStripeBillingConfigStatus({
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    BETTER_AUTH_URL: "http://127.0.0.1:43103",
    STRIPE_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_123",
    STRIPE_PRO_PRICE_ID: "price_pro_monthly",
    STRIPE_PRO_ANNUAL_PRICE_ID: "price_pro_annual",
    STRIPE_PLUS_PRICE_ID: "price_plus_monthly",
    STRIPE_PLUS_ANNUAL_PRICE_ID: "price_plus_annual",
  });

  assert.equal(config.isReady, true);
  assert.deepEqual(config.missingEnvVars, []);
});
