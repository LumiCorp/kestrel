import { z } from "zod";

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

const wildcardDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
    "Wildcard domains must look like *.previews.example.com."
  );

const ngrokEnvironmentConnectionSchema = z.object({
  kind: z.literal("ngrok_agent"),
  name: z.string().trim().min(1).max(120),
  authtoken: z.string().trim().min(1).max(16_384),
  wildcardDomain,
});

export const createEnvironmentAppConnectionSchema = z.union([
  apiKeyEnvironmentConnectionSchema,
  ngrokEnvironmentConnectionSchema,
]);

export const environmentAppCapabilityGrantSchema = z
  .object({
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
    loggingMode: z.enum(["full", "metadata_only", "minimal"]),
    rateLimitMode: z.enum(["default", "strict", "off"]),
  })
  .transform((value) =>
    value.enabled ? value : { ...value, approvalMode: "deny" as const }
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
    value.enabled ? value : { ...value, approvalMode: "deny" as const }
  );

export type CreateEnvironmentAppConnectionInput = z.input<
  typeof createEnvironmentAppConnectionSchema
>;

export type EnvironmentAppCapabilityGrantInput = z.infer<
  typeof environmentAppCapabilityGrantSchema
>;
