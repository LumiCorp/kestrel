import { createHash } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import {
  admin,
  bearer,
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
import { isDisallowedToolProviderSignIn } from "./auth-policy";
import { pool } from "./db-client";
import { reactInvitationEmail } from "./email/invitation";
import { reactResetPasswordEmail } from "./email/reset-password";

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

const mobileTrustedOrigins = (
  process.env.KESTREL_ONE_MOBILE_TRUSTED_ORIGINS ?? "kestrelone://"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const trustedOrigins = Array.from(
  new Set(
    [
      ...(process.env.NODE_ENV === "production" ? [] : ["exp://"]),
      ...mobileTrustedOrigins,
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
const githubOAuthConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
);
const googleOAuthConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);

export const auth = betterAuth({
  appName: "Kestrel One",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
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
    encryptOAuthTokens: true,
    accountLinking: {
      trustedProviders: ["kestrel-one", "github", "google"],
      disableImplicitLinking: true,
      allowDifferentEmails: true,
      updateUserInfoOnLink: false,
    },
  },
  socialProviders: {
    ...(githubOAuthConfigured
      ? {
          github: {
          clientId: process.env.GITHUB_CLIENT_ID as string,
          clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
          scope: ["repo"],
          disableImplicitSignUp: true,
          },
        }
      : {}),
    ...(googleOAuthConfigured
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
            accessType: "offline" as const,
            prompt: "select_account consent",
            disableImplicitSignUp: true,
          },
        }
      : {}),
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        isDisallowedToolProviderSignIn({
          path: context.path,
          body: context.body,
        })
      ) {
        throw new APIError("BAD_REQUEST", {
          message:
            "This provider is available only as a linked organizational tool.",
        });
      }
    }),
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
    expo(),
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
      customAPIKeyGetter: (ctx) =>
        ctx.headers?.get("x-api-key")?.trim() || null,
    }),
    openAPI(),
    bearer(),
    admin({
      adminUserIds,
    }),
    multiSession(),
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
    nextCookies(),
  ],
  trustedOrigins,
  advanced: {
    crossSubDomainCookies: {
      enabled: process.env.NODE_ENV === "production",
      domain: cookieDomain,
    },
  },
});
