import { KESTREL_APP_ORIGIN } from "./app-url";

export const publicAppUrl =
  process.env.VERCEL_ENV === "production"
    ? KESTREL_APP_ORIGIN
    : process.env.NEXT_PUBLIC_APP_URL?.trim() || null;

export const publicOgImageUrl =
  process.env.NEXT_PUBLIC_OG_IMAGE_URL?.trim() || null;

export const publicBillingEnabled =
  process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";
