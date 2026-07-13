import { createHash } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import {
  admin,
  bearer,
  customSession,
  lastLoginMethod,
  multiSession,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import { Stripe } from "stripe";
import { canUserManageOrganizationBilling } from "@/lib/billing/access";
import { getStripeBillingConfigStatus } from "@/lib/billing/config";
import { deliverTransactionalEmail } from "@/lib/email/service";
import { pool } from "./db-client";
import { reactInvitationEmail } from "./email/invitation";
import { reactResetPasswordEmail } from "./email/reset-password";
import { ensureSessionHasActiveOrganization } from "./personal-workspace";

function deliveryKey(kind: string, value: string) {
  return `${kind}-${createHash("sha256").update(value).digest("hex")}`;
}

// Create Postgres dialect for the shared auth pool
const dialect = new PostgresDialect({
  pool,
});

const baseURL: string | undefined = (() => {
  if (process.env.VERCEL !== "1") {
    return;
  }
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL;
  }
  return `https://${process.env.VERCEL_URL}`;
})();

const cookieDomain: string | undefined = (() => {
  if (process.env.VERCEL !== "1") {
    return;
  }
  if (process.env.BETTER_AUTH_URL) {
    return new URL(process.env.BETTER_AUTH_URL).hostname;
  }
  return `.${process.env.VERCEL_URL}`;
})();

const localDevOrigins = [3000, 3001, 3100, 43_103].flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

const devBaseUrl =
  process.env.BETTER_AUTH_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:43103";

const trustedOrigins = Array.from(
  new Set(
    [
      "exp://",
      "https://appleid.apple.com",
      process.env.BETTER_AUTH_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      ...localDevOrigins,
    ].filter((origin): origin is string => Boolean(origin))
  )
);

const adminUserIds = (process.env.ADMIN_USER_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const stripeConfigStatus = getStripeBillingConfigStatus();
const stripeEnvConfigured = stripeConfigStatus.isReady;

export const auth = betterAuth({
  appName: "Kestrel One",
  baseURL,
  database: {
    dialect,
    type: "postgres",
  },
  emailVerification: {
    async sendVerificationEmail({ user, url }) {
      await deliverTransactionalEmail({
        kind: "verification",
        to: user.email,
        subject: "Verify your email address",
        html: `<a href="${url}">Verify your email address</a>`,
        developmentContent: url,
        idempotencyKey: deliveryKey("verification", url),
      });
    },
  },
  account: {
    accountLinking: {
      trustedProviders: ["kestrel-one"],
    },
  },
  emailAndPassword: {
    enabled: true,
    async sendResetPassword({ user, url }) {
      await deliverTransactionalEmail({
        kind: "password_reset",
        to: user.email,
        subject: "Reset your password",
        react: reactResetPasswordEmail({
          username: user.email,
          resetLink: url,
        }),
        developmentContent: url,
        idempotencyKey: deliveryKey("password-reset", url),
      });
    },
  },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        const inviteLink = `${devBaseUrl}/accept-invitation/${data.id}`;
        await deliverTransactionalEmail({
          kind: "organization_invitation",
          to: data.email,
          subject: "You've been invited to join an organization",
          react: reactInvitationEmail({
            username: data.email,
            invitedByUsername: data.inviter.user.name,
            invitedByEmail: data.inviter.user.email,
            teamName: data.organization.name,
            inviteLink,
          }),
          developmentContent: inviteLink,
          idempotencyKey: `organization-invitation-${data.id}`,
        });
      },
    }),
    twoFactor({
      otpOptions: {
        async sendOTP({ user, otp }) {
          await deliverTransactionalEmail({
            kind: "two_factor_otp",
            to: user.email,
            subject: "Your OTP",
            html: `Your OTP is ${otp}`,
            developmentContent: otp,
            idempotencyKey: deliveryKey("two-factor-otp", `${user.id}:${otp}`),
          });
        },
      },
    }),
    passkey(),
    apiKey({
      enableSessionForAPIKeys: true,
      rateLimit: {
        enabled: false,
      },
      customAPIKeyGetter: (ctx) => {
        const xApiKey = ctx.headers?.get("x-api-key");
        if (xApiKey) {
          return xApiKey;
        }

        const authHeader = ctx.headers?.get("authorization");
        if (authHeader?.startsWith("Bearer ")) {
          return authHeader.slice(7);
        }

        return null;
      },
    }),
    openAPI(),
    bearer(),
    admin({
      adminUserIds,
    }),
    multiSession(),
    nextCookies(),
    customSession(async (session) =>
      session ? await ensureSessionHasActiveOrganization(session) : session
    ),
    ...(stripeEnvConfigured
      ? [
          stripe({
            stripeClient: new Stripe(process.env.STRIPE_KEY as string),
            stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET as string,
            organization: {
              enabled: true,
            },
            subscription: {
              enabled: true,
              allowReTrialsForDifferentPlans: true,
              authorizeReference: async ({ referenceId, user }) =>
                canUserManageOrganizationBilling({
                  organizationId: referenceId,
                  userId: user.id,
                }),
              plans: () => [
                {
                  name: "Plus",
                  priceId: process.env.STRIPE_PLUS_PRICE_ID as string,
                  annualDiscountPriceId: process.env
                    .STRIPE_PLUS_ANNUAL_PRICE_ID as string,
                  freeTrial: {
                    days: 7,
                  },
                },
                {
                  name: "Pro",
                  priceId: process.env.STRIPE_PRO_PRICE_ID as string,
                  annualDiscountPriceId: process.env
                    .STRIPE_PRO_ANNUAL_PRICE_ID as string,
                  freeTrial: {
                    days: 7,
                  },
                },
              ],
            },
          }),
        ]
      : []),
    lastLoginMethod(),
  ],
  trustedOrigins,
  advanced: {
    crossSubDomainCookies: {
      enabled: process.env.NODE_ENV === "production",
      domain: cookieDomain,
    },
  },
});
