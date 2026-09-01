import { z } from "zod";
import {
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
} from "../../../../src/browser/domainAuthority.js";

const httpsUrl = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Connection endpoints must be credential-free HTTPS URLs.",
      });
    }
  });

const apiKeyEnvironmentConnectionSchema = z.object({
  kind: z.literal("api_key").default("api_key"),
  name: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(16_384),
  projectId: z.string().trim().min(1).max(256).optional(),
  baseUrl: httpsUrl.optional(),
});

export const createEnvironmentAppConnectionSchema =
  apiKeyEnvironmentConnectionSchema;

export const environmentAppCapabilityGrantSchema = z
  .object({
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
    loggingMode: z.enum(["full", "metadata_only", "minimal"]),
    rateLimitMode: z.enum(["default", "strict", "off"]),
  })
  .transform((value) =>
    value.enabled ? value : { ...value, approvalMode: "deny" as const },
  );

const browserPublicDomainAuthorityInputSchema = z
  .union([
    z.string().trim().min(1).max(2_048),
    z
      .object({
        version: z.literal(BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION),
        scheme: z.literal("https"),
        canonicalDomain: z.string().trim().min(1).max(253),
        includeSubdomains: z.literal(true),
        port: z.literal(443),
      })
      .strict(),
  ])
  .transform((value, context) => {
    try {
      const authority = canonicalizePublicBrowserDestination(
        typeof value === "string"
          ? value.includes("://")
            ? value
            : `https://${value}`
          : `https://${value.canonicalDomain}`,
      );
      if (
        typeof value !== "string" &&
        authority.canonicalDomain !== value.canonicalDomain
      ) {
        throw new Error("Browser domain authority is not canonical.");
      }
      return authority;
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "Browser domain authority is invalid.",
      });
      return z.NEVER;
    }
  });

const browserModesSchema = z
  .array(z.enum(["qa", "operator"]))
  .max(2)
  .refine((modes) => new Set(modes).size === modes.length, {
    message: "Browser modes cannot contain duplicates.",
  })
  .transform((modes) => modes.slice().sort());

const browserDomainSetSchema = z
  .array(browserPublicDomainAuthorityInputSchema)
  .max(256)
  .refine(
    (domains) =>
      new Set(domains.map((domain) => domain.canonicalDomain)).size ===
      domains.length,
    { message: "Browser domains cannot contain duplicates." },
  )
  .transform((domains) =>
    domains
      .slice()
      .sort((left, right) =>
        left.canonicalDomain.localeCompare(right.canonicalDomain),
      ),
  );

export const browserEnvironmentAppSettingsSchema = z
  .object({
    enabledModes: browserModesSchema,
    personalGrantsEnabled: z.boolean(),
    configuredPublicDomains: browserDomainSetSchema,
    blockedPublicDomains: browserDomainSetSchema,
  })
  .strict();

export const browserProjectAppSettingsSchema = z
  .object({
    enabledModes: browserModesSchema,
    personalGrantsEnabled: z.boolean(),
    blockedPublicDomains: browserDomainSetSchema,
  })
  .strict();

export const browserEnvironmentAppCapabilityGrantSchema = z
  .object({
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
    loggingMode: z.enum(["full", "metadata_only", "minimal"]),
    rateLimitMode: z.enum(["default", "strict", "off"]),
    settings: browserEnvironmentAppSettingsSchema,
  })
  .strict()
  .transform((value) =>
    value.enabled ? value : { ...value, approvalMode: "deny" as const },
  );

export const projectAppEnabledSchema = z.object({ enabled: z.boolean() });

export const projectAppConnectionAttachmentSchema = z.object({
  scope: z.enum(["shared", "personal"]),
  isDefault: z.boolean().default(true),
});

export const projectAppCapabilityPolicySchema = z
  .object({
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
  })
  .transform((value) =>
    value.enabled ? value : { ...value, approvalMode: "deny" as const },
  );

export const browserProjectAppCapabilityPolicySchema = z
  .object({
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
    settings: browserProjectAppSettingsSchema,
  })
  .strict()
  .transform((value) =>
    value.enabled ? value : { ...value, approvalMode: "deny" as const },
  );

export type CreateEnvironmentAppConnectionInput = z.input<
  typeof createEnvironmentAppConnectionSchema
>;

export type EnvironmentAppCapabilityGrantInput = z.infer<
  typeof environmentAppCapabilityGrantSchema
>;

export type BrowserEnvironmentAppCapabilityGrantInput = z.infer<
  typeof browserEnvironmentAppCapabilityGrantSchema
>;

export type BrowserProjectAppCapabilityPolicyInput = z.infer<
  typeof browserProjectAppCapabilityPolicySchema
>;
