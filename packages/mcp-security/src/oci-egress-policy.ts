import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

const MAX_DESTINATIONS = 64;
const MAX_JUSTIFICATION_LENGTH = 1_000;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const OCI_MCP_NO_EGRESS_POLICY = {
  version: 1,
  mode: "none",
} as const;

const hostnameSchema = z.string().transform((value, context) => {
  const trimmed = value.trim();
  if (!trimmed || !/^[\p{L}\p{N}.-]+$/u.test(trimmed)) {
    context.addIssue({ code: "custom", message: "Expected a DNS hostname." });
    return z.NEVER;
  }
  const withoutTrailingDot = trimmed.endsWith(".")
    ? trimmed.slice(0, -1)
    : trimmed;
  if (
    !withoutTrailingDot ||
    isIP(withoutTrailingDot) !== 0 ||
    /^\d+(?:\.\d+){3}$/u.test(withoutTrailingDot)
  ) {
    context.addIssue({
      code: "custom",
      message: "Literal IP destinations are unsupported.",
    });
    return z.NEVER;
  }
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  const labels = ascii.split(".");
  if (
    !ascii ||
    ascii.length > 253 ||
    labels.some((label) => !DNS_LABEL_PATTERN.test(label))
  ) {
    context.addIssue({ code: "custom", message: "Invalid DNS hostname." });
    return z.NEVER;
  }
  return ascii;
});

export const ociMcpEgressDestinationV1Schema = z
  .object({
    hostname: hostnameSchema,
    port: z.number().int().min(1).max(65_535),
    protocol: z.enum(["http", "https"]),
  })
  .strict();

const nonePolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("none"),
  })
  .strict();

const allowHostsPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("allow_hosts"),
    destinations: z
      .array(ociMcpEgressDestinationV1Schema)
      .min(1)
      .max(MAX_DESTINATIONS),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>();
    policy.destinations.forEach((destination, index) => {
      const key = destinationKey(destination);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["destinations", index],
          message: "Duplicate canonical destination.",
        });
      }
      seen.add(key);
    });
  })
  .transform((policy) => ({
    ...policy,
    destinations: [...policy.destinations].sort(compareDestinations),
  }));

const unrestrictedPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("unrestricted"),
    acknowledgedRisk: z.literal(true),
    justification: z.string().trim().min(1).max(MAX_JUSTIFICATION_LENGTH),
  })
  .strict();

export const ociMcpEgressPolicyV1Schema = z.discriminatedUnion("mode", [
  nonePolicySchema,
  allowHostsPolicySchema,
  unrestrictedPolicySchema,
]);

export type OciMcpEgressDestinationV1 = z.infer<
  typeof ociMcpEgressDestinationV1Schema
>;
export type OciMcpEgressPolicyV1 = z.infer<typeof ociMcpEgressPolicyV1Schema>;

export const resolvedOciMcpEgressBindingV1Schema = z
  .object({
    version: z.literal(1),
    source: z.enum(["custom", "managed"]),
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    serverId: z.string().min(1),
    imageDigest: z.string().regex(SHA256_DIGEST_PATTERN),
    policyRevision: z.string().trim().min(1).max(200),
    policyDigest: z.string().regex(SHA256_DIGEST_PATTERN),
    policy: ociMcpEgressPolicyV1Schema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      binding.source === "managed" &&
      binding.policy.mode === "unrestricted"
    ) {
      context.addIssue({
        code: "custom",
        path: ["policy", "mode"],
        message: "Managed OCI MCP servers cannot use unrestricted egress.",
      });
    }
    if (binding.policyDigest !== digestOciMcpEgressPolicy(binding.policy)) {
      context.addIssue({
        code: "custom",
        path: ["policyDigest"],
        message: "OCI MCP egress policy digest does not match the policy.",
      });
    }
  });

export type ResolvedOciMcpEgressBindingV1 = z.infer<
  typeof resolvedOciMcpEgressBindingV1Schema
>;

export function parseOciMcpEgressPolicy(value: unknown): OciMcpEgressPolicyV1 {
  return ociMcpEgressPolicyV1Schema.parse(value);
}

export function resolveCustomOciMcpEgressPolicy(
  value: unknown,
): OciMcpEgressPolicyV1 {
  const parsed = ociMcpEgressPolicyV1Schema.safeParse(value);
  return parsed.success ? parsed.data : OCI_MCP_NO_EGRESS_POLICY;
}

export function digestOciMcpEgressPolicy(
  policy: OciMcpEgressPolicyV1,
): `sha256:${string}` {
  const canonical = ociMcpEgressPolicyV1Schema.parse(policy);
  return `sha256:${createHash("sha256")
    .update(stableJson(canonical))
    .digest("hex")}`;
}

export function parseResolvedOciMcpEgressBinding(
  value: unknown,
): ResolvedOciMcpEgressBindingV1 {
  return resolvedOciMcpEgressBindingV1Schema.parse(value);
}

function destinationKey(destination: OciMcpEgressDestinationV1): string {
  return `${destination.protocol}\u0000${destination.hostname}\u0000${destination.port}`;
}

function compareDestinations(
  left: OciMcpEgressDestinationV1,
  right: OciMcpEgressDestinationV1,
): number {
  return (
    left.hostname.localeCompare(right.hostname) ||
    left.port - right.port ||
    left.protocol.localeCompare(right.protocol)
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
