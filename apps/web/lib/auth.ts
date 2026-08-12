import { createHash } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import {
  genericOAuth,
  microsoftEntraId,
} from "better-auth/plugins/generic-oauth";
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
import { logAdminEvent } from "@/lib/admin/logs";
import { canUserManageOrganizationBilling } from "@/lib/billing/access";
import { getStripeBillingConfigStatus } from "@/lib/billing/config";
import { deliverTransactionalEmail } from "@/lib/email/service";
import { resolveKestrelAppUrl } from "./app-url";
import { isDisallowedToolProviderSignIn } from "./auth-policy";
import { resolveAuthSecurityPolicy } from "./auth-security-policy";
import {
  assertInvitationSignupFromHeaders,
  INVITATION_EXPIRY_SECONDS,
} from "./invitations";
import {
  reserveSignupAccessCodeFromHeaders,
} from "./signup-access-codes";
import {
  isSignupAccessCodePolicyError,
  signupAccessCodeTemporarilyUnavailableMessage,
  signupAccessCodeUnavailableMessage,
} from "./signup-access-code-policy";
import { SIGNUP_ACCESS_CODE_HEADER } from "./signup-access-code-shared";
import { resolveSignupAuthority } from "./signup-authority";
import { INVITATION_SIGNUP_HEADER } from "./invitation-shared";
import { invitationOrigin } from "./invitation-origin";
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

const configuredAppUrl = resolveKestrelAppUrl(process.env);
const baseURL: string | undefined =
  process.env.VERCEL === "1" ? configuredAppUrl : undefined;
const authSecurityPolicy = resolveAuthSecurityPolicy(process.env);

function throwPublicSignupAccessCodeError(error: unknown): never {
  if (isSignupAccessCodePolicyError(error)) {
    throw new APIError("BAD_REQUEST", {
      message: signupAccessCodeUnavailableMessage(),
    });
  }
  void logAdminEvent({
    level: "error",
    category: "signup_onboarding",
    action: "signup_code_reservation_failed",
    message: "Signup access code reservation failed.",
    metadata: {
      errorType: error instanceof Error ? error.name : typeof error,
    },
  }).catch(() => {});
  throw new APIError("SERVICE_UNAVAILABLE", {
    message: signupAccessCodeTemporarilyUnavailableMessage(),
  });
}

const adminUserIds = (process.env.ADMIN_USER_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const stripeConfigStatus = getStripeBillingConfigStatus();
const stripeEnvConfigured = stripeConfigStatus.isReady;
const githubOAuthConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
);
const googleOAuthConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);
const microsoftOAuthConfigured = Boolean(
  process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET,
);

export const auth = betterAuth({
  appName: "Kestrel One",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: {
    dialect,
    type: "postgres",
  },
  user: {
    additionalFields: {
      signupAccessCodeRedemptionId: {
        type: "string",
        required: false,
        input: false,
        returned: false,
        fieldName: "signup_access_code_redemption_id",
      },
    },
  },
  rateLimit: {
    enabled: process.env.KESTREL_PRODUCT_CONTRACT !== "true",
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
      trustedProviders: [
        "kestrel-one",
        "github",
        "google",
        "microsoft-entra-id",
      ],
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
      if (context.path === "/sign-up/email") {
        const invitationId = context.headers?.get(INVITATION_SIGNUP_HEADER);
        const signupCode = context.headers?.get(SIGNUP_ACCESS_CODE_HEADER);
        let authority;
        try {
          authority = resolveSignupAuthority({ invitationId, signupCode });
        } catch (error) {
          throw new APIError("BAD_REQUEST", {
            message:
              error instanceof Error
                ? error.message
                : "A valid signup method is required.",
          });
        }

        const email = (context.body as { email?: unknown } | undefined)?.email;
        if (authority.kind === "signup_code") {
          return;
        }
        await assertInvitationSignupFromHeaders({
          headers: context.headers,
          email,
        });
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        async before(user, context) {
          if (context?.path !== "/sign-up/email") {
            return;
          }
          const signupCode = context.headers?.get(SIGNUP_ACCESS_CODE_HEADER);
          if (!signupCode) {
            return;
          }
          try {
            const reservation = await reserveSignupAccessCodeFromHeaders({
              headers: context.headers,
              email: user.email,
            });
            return {
              data: {
                signupAccessCodeRedemptionId: reservation.id,
              },
            };
          } catch (error) {
            return throwPublicSignupAccessCodeError(error);
          }
        },
      },
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
    genericOAuth({
      config: microsoftOAuthConfigured
        ? [
            microsoftEntraId({
              clientId: process.env.MICROSOFT_CLIENT_ID as string,
              clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
              tenantId: process.env.MICROSOFT_TENANT_ID ?? "organizations",
              scopes: [
                "openid",
                "profile",
                "email",
                "offline_access",
                "User.Read",
              ],
              disableImplicitSignUp: true,
            }),
          ]
        : [],
    }),
    expo(),
    organization({
      invitationExpiresIn: INVITATION_EXPIRY_SECONDS,
      requireEmailVerificationOnInvitation: false,
      async sendInvitationEmail(data) {
        const inviteLink = `${invitationOrigin()}/accept-invitation/${data.id}`;
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
  trustedOrigins: authSecurityPolicy.trustedOrigins,
  advanced: authSecurityPolicy.advanced,
});
