import { isIP } from "node:net";
import { mcpCredentialPayloadSchema } from "./credential-crypto";
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_RUN_GRANT_TTL_SECONDS = 300;

export const mcpApprovalModeSchema = z.enum(["auto", "ask", "deny"]);
export type McpApprovalMode = z.infer<typeof mcpApprovalModeSchema>;

export const mcpCapabilityKindSchema = z.enum([
  "tool",
  "resource",
  "resource_template",
  "prompt",
  "root",
  "sampling",
  "elicitation",
  "completion",
  "logging",
  "task",
]);
export type McpCapabilityKind = z.infer<typeof mcpCapabilityKindSchema>;

const resourceLimitsSchema = z.object({
  cpuMillicores: z.number().int().positive().default(500),
  memoryMib: z.number().int().positive().default(512),
  pidsLimit: z.number().int().positive().default(128),
});

const authSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("oauth"), credentialId: z.string().uuid() }),
  z.object({
    mode: z.literal("secret_headers"),
    credentialId: z.string().uuid(),
  }),
]);

const serverIdentitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/u),
  auth: authSchema,
  launchArguments: z.array(z.string().max(4096)).max(64).default([]),
  egressAllowlist: z.array(z.string().url()).max(128).default([]),
  resources: resourceLimitsSchema.default({
    cpuMillicores: 500,
    memoryMib: 512,
    pidsLimit: 128,
  }),
});

const remoteServerSchema = serverIdentitySchema
  .extend({
    sourceType: z.literal("remote"),
    transport: z.literal("streamable_http"),
    remoteUrl: z.string().url(),
  })
  .superRefine((value, context) => {
    let endpoint: URL;
    try {
      endpoint = assertPublicHttpsEndpoint(value.remoteUrl);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["remoteUrl"],
        message:
          error instanceof Error ? error.message : "Invalid MCP endpoint.",
      });
      return;
    }
    const allowedOrigins = new Set(
      value.egressAllowlist.map((entry) => normalizeEgressOrigin(entry))
    );
    if (!allowedOrigins.has(endpoint.origin)) {
      context.addIssue({
        code: "custom",
        path: ["egressAllowlist"],
        message: "Remote MCP endpoint origin must be explicitly allowlisted.",
      });
    }
  });

const ociServerSchema = serverIdentitySchema
  .extend({
    sourceType: z.literal("oci"),
    transport: z.literal("stdio"),
    imageReference: z.string().trim().min(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .superRefine((value, context) => {
    if (!value.imageReference.endsWith(`@${value.digest}`)) {
      context.addIssue({
        code: "custom",
        path: ["imageReference"],
        message: "OCI image reference must be pinned to the declared digest.",
      });
    }
    if (value.auth.mode !== "none") {
      context.addIssue({
        code: "custom",
        path: ["auth"],
        message: "OCI stdio MCP servers do not accept remote credentials.",
      });
    }
    for (const [index, entry] of value.egressAllowlist.entries()) {
      try {
        assertPublicHttpsEndpoint(entry);
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["egressAllowlist", index],
          message:
            error instanceof Error
              ? error.message
              : "Invalid OCI MCP egress origin.",
        });
      }
    }
  });

export const createMcpServerInputSchema = z.discriminatedUnion("sourceType", [
  remoteServerSchema,
  ociServerSchema,
]);
export type CreateMcpServerInput = z.infer<typeof createMcpServerInputSchema>;

export const createMcpCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  payload: mcpCredentialPayloadSchema,
});
export type CreateMcpCredentialInput = z.infer<
  typeof createMcpCredentialInputSchema
>;

export type McpCapabilityAuthority = {
  id: string;
  kind: McpCapabilityKind;
  environmentEnabled: boolean;
  approvalMode: McpApprovalMode;
};

export type McpProjectCapabilityRestriction = {
  capabilityId: string;
  enabled: boolean;
  approvalMode: McpApprovalMode;
};

export type EffectiveMcpCapability = {
  id: string;
  kind: McpCapabilityKind;
  approvalMode: Exclude<McpApprovalMode, "deny">;
};

const APPROVAL_STRICTNESS: Record<McpApprovalMode, number> = {
  auto: 0,
  ask: 1,
  deny: 2,
};

export function resolveEffectiveMcpCapabilities(input: {
  environmentCapabilities: readonly McpCapabilityAuthority[];
  projectRestrictions?: readonly McpProjectCapabilityRestriction[] | undefined;
}): EffectiveMcpCapability[] {
  const projectRestrictions = input.projectRestrictions
    ? new Map(
        input.projectRestrictions.map((restriction) => [
          restriction.capabilityId,
          restriction,
        ])
      )
    : undefined;

  return input.environmentCapabilities.flatMap((capability) => {
    if (!capability.environmentEnabled) {
      return [];
    }
    const projectRestriction = projectRestrictions?.get(capability.id);
    if (projectRestrictions && !projectRestriction?.enabled) {
      return [];
    }
    const approvalMode = projectRestriction
      ? stricterApprovalMode(
          capability.approvalMode,
          projectRestriction.approvalMode
        )
      : capability.approvalMode;
    if (approvalMode === "deny") {
      return [];
    }
    return [
      {
        id: capability.id,
        kind: capability.kind,
        approvalMode: approvalMode as Exclude<McpApprovalMode, "deny">,
      },
    ];
  });
}

export function buildMcpRunGrant(input: {
  id: string;
  runExecutionId: string;
  organizationId: string;
  environmentId: string;
  projectId?: string | undefined;
  threadId: string;
  policyDigest: string;
  effectiveCapabilities: readonly EffectiveMcpCapability[];
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  return {
    id: z.string().uuid().parse(input.id),
    runExecutionId: input.runExecutionId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    threadId: input.threadId,
    policyDigest: input.policyDigest,
    effectiveCapabilities: input.effectiveCapabilities.map(
      (capability) => capability.id
    ),
    effectivePolicy: input.effectiveCapabilities.map((capability) => ({
      capabilityId: capability.id,
      approvalMode: capability.approvalMode,
    })),
    status: "issued" as const,
    createdAt: now,
    expiresAt: new Date(now.getTime() + MCP_RUN_GRANT_TTL_SECONDS * 1000),
  };
}

export function assertPublicHttpsEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") {
    throw new Error("Remote MCP endpoint must use HTTPS.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Remote MCP endpoint must not contain userinfo.");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isNonPublicIpLiteral(hostname)
  ) {
    throw new Error("Remote MCP endpoint must resolve to a public network.");
  }
  return endpoint;
}

function normalizeEgressOrigin(value: string): string {
  return assertPublicHttpsEndpoint(value).origin;
}

function stricterApprovalMode(
  environmentMode: McpApprovalMode,
  projectMode: McpApprovalMode
): McpApprovalMode {
  return APPROVAL_STRICTNESS[projectMode] > APPROVAL_STRICTNESS[environmentMode]
    ? projectMode
    : environmentMode;
}

function isNonPublicIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(normalized);
  if (version === 0) {
    return false;
  }
  if (version === 6) {
    const compact = normalized.toLowerCase();
    return (
      compact === "::" ||
      compact === "::1" ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      compact.startsWith("fe8") ||
      compact.startsWith("fe9") ||
      compact.startsWith("fea") ||
      compact.startsWith("feb")
    );
  }
  const [first = 0, second = 0] = normalized.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}
