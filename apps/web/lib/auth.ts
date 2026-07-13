import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
import { isDisallowedGithubSignIn } from "./auth-policy";
import { pool } from "./db-client";
import { reactInvitationEmail } from "./email/invitation";
import { isEmailEnabled, resend } from "./email/resend";
import { reactResetPasswordEmail } from "./email/reset-password";
import { ensureSessionHasActiveOrganization } from "./personal-workspace";

const from = process.env.BETTER_AUTH_EMAIL || "delivered@resend.dev";
const to = process.env.TEST_EMAIL || "";
const emailEnabled = isEmailEnabled();

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
const githubOAuthConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
);

export const auth = betterAuth({
  appName: "Kestrel One",
  baseURL,
  database: {
    dialect,
    type: "postgres",
  },
  emailVerification: emailEnabled
    ? {
        async sendVerificationEmail({ user, url }) {
          if (!resend) {
            console.warn(
              "Email verification requested but Resend is not configured"
            );
            return;
          }
          const res = await resend.emails.send({
            from,
            to: to || user.email,
            subject: "Verify your email address",
            html: `<a href="${url}">Verify your email address</a>`,
          });
          console.log(res, user.email);
        },
      }
    : undefined,
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      trustedProviders: ["kestrel-one"],
      disableImplicitLinking: true,
      allowDifferentEmails: true,
      updateUserInfoOnLink: false,
    },
  },
  socialProviders: githubOAuthConfigured
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID as string,
          clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
          scope: ["repo"],
          disableImplicitSignUp: true,
        },
      }
    : undefined,
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        isDisallowedGithubSignIn({
          path: context.path,
          body: context.body,
        })
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "GitHub is available only as a linked organizational tool.",
        });
      }
    }),
  },
  emailAndPassword: {
    enabled: true,
    async sendResetPassword({ user, url }) {
      if (!resend) {
        console.warn("Password reset requested but Resend is not configured");
        console.warn(`Password reset link for ${user.email}: ${url}`);
        return;
      }
      await resend.emails.send({
        from,
        to: user.email,
        subject: "Reset your password",
        react: reactResetPasswordEmail({
          username: user.email,
          resetLink: url,
        }),
      });
    },
  },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        if (!resend) {
          console.warn(
            "Organization invitation requested but Resend is not configured"
          );
          const inviteLink =
            process.env.NODE_ENV === "development"
              ? `${devBaseUrl}/accept-invitation/${data.id}`
              : `${devBaseUrl}/accept-invitation/${data.id}`;
          console.warn(`Invitation link for ${data.email}: ${inviteLink}`);
          return;
        }
        await resend.emails.send({
          from,
          to: data.email,
          subject: "You've been invited to join an organization",
          react: reactInvitationEmail({
            username: data.email,
            invitedByUsername: data.inviter.user.name,
            invitedByEmail: data.inviter.user.email,
            teamName: data.organization.name,
            inviteLink:
              process.env.NODE_ENV === "development"
                ? `${devBaseUrl}/accept-invitation/${data.id}`
                : `${devBaseUrl}/accept-invitation/${data.id}`,
          }),
        });
      },
    }),
    twoFactor({
      otpOptions: {
        async sendOTP({ user, otp }) {
          if (!resend) {
            console.warn("2FA OTP requested but Resend is not configured");
            console.warn(`OTP for ${user.email}: ${otp}`);
            return;
          }
          await resend.emails.send({
            from,
            to: user.email,
            subject: "Your OTP",
            html: `Your OTP is ${otp}`,
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
