import { publicAppUrl } from "@/lib/public-config";

export const STRIPE_REQUIRED_ENV_VARS = [
  "STRIPE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PRO_ANNUAL_PRICE_ID",
  "STRIPE_PLUS_PRICE_ID",
  "STRIPE_PLUS_ANNUAL_PRICE_ID",
] as const;

export function getStripeBillingConfigStatus(
  env: Record<string, string | undefined> = process.env
) {
  const billingEnabled = env.NEXT_PUBLIC_BILLING_ENABLED === "true";
  const missingEnvVars = STRIPE_REQUIRED_ENV_VARS.filter(
    (key) => !env[key]?.trim()
  );
  const appUrl =
    publicAppUrl?.trim() ||
    env.BETTER_AUTH_URL?.trim() ||
    env.NEXT_PUBLIC_APP_URL?.trim() ||
    null;
  const webhookPath = "/api/auth/stripe/webhook";

  return {
    appUrl,
    billingEnabled,
    isReady: billingEnabled && missingEnvVars.length === 0,
    missingEnvVars,
    webhookPath,
    webhookUrl: appUrl ? `${appUrl}${webhookPath}` : null,
  };
}
