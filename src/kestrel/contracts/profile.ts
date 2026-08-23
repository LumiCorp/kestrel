import { createHash } from "node:crypto";

import { z } from "zod";

import type { CodeModeProfileConfig } from "../../code/contracts.js";
import type { DevShellProfileConfig } from "../../devshell/contracts.js";
import type { McpServerConfig } from "../../mcp/contracts.js";
import type { ActSubmode, InteractionMode } from "../../mode/contracts.js";
import type {
  CapabilityPackId,
  ModelProviderId,
  ShellKind,
  ShellPresetId,
} from "../../profile/runtimeProfile.js";
import {
  parseRuntimeEvaluationPolicyV1,
  type RuntimeEvaluationPolicyV1,
} from "./evaluation.js";
import {
  type ModelCredentialReferenceV1,
  type ModelRouteCapabilitiesV1,
} from "./model-route.js";

export const KESTREL_PROFILE_DEFINITION_VERSION =
  "kestrel_profile_definition_v1" as const;
export const KESTREL_ENVIRONMENT_BINDING_VERSION =
  "kestrel_environment_binding_v1" as const;
export const KESTREL_ENVIRONMENT_SELECTION_VERSION =
  "kestrel_environment_selection_v1" as const;

export const KESTREL_CANONICAL_PROFILE_ID = "kestrel" as const;
export const KESTREL_CANONICAL_PROFILE_LABEL = "Kestrel" as const;

export type KestrelEnvironmentPresetIdV1 = Exclude<
  ShellPresetId,
  "web_balanced"
>;
export type KestrelEnvironmentNameV1 =
  | "safe"
  | "developer"
  | "workspace_hosted";

export interface KestrelProfileDefinitionV1 {
  version: typeof KESTREL_PROFILE_DEFINITION_VERSION;
  id: typeof KESTREL_CANONICAL_PROFILE_ID;
  revision: string;
  label: typeof KESTREL_CANONICAL_PROFILE_LABEL;
  agent: "kestrel";
  interaction: {
    modeSystemV2Enabled: true;
    defaultInteractionMode: InteractionMode;
    defaultActSubmode: ActSubmode;
  };
  evaluationPolicy?: RuntimeEvaluationPolicyV1 | undefined;
  reasoning: {
    request: {
      mode: "off" | "summary" | "provider_visible";
      effort?: "low" | "medium" | "high" | undefined;
    };
    retention: {
      mode: "live_only" | "provider_visible";
      days: number;
    };
  };
  delegation: {
    allowAgentSpawn: true;
    allowNestedCollaborators: false;
    maxConcurrentChildSessions: number;
    maxDepth: number;
  };
}

export interface KestrelPinnedModelRouteV1 {
  kind: "pinned";
  provider: ModelProviderId;
  model: string;
  modelRegistrationRevision: string;
  capabilities: ModelRouteCapabilitiesV1;
  credentialReference?: ModelCredentialReferenceV1 | undefined;
  pricingRecord?:
    | {
        recordId: string;
        revision: string;
      }
    | undefined;
  calibrationRecord?:
    | {
        recordId: string;
        revision: string;
      }
    | undefined;
}

export interface KestrelRuntimeConfigurationModelRouteV1 {
  kind: "runtime_configuration";
  registrationSource: "local_core" | "hosted_control_plane";
}

export type KestrelEnvironmentModelRouteV1 =
  | KestrelPinnedModelRouteV1
  | KestrelRuntimeConfigurationModelRouteV1;

export interface KestrelEnvironmentBindingV1 {
  version: typeof KESTREL_ENVIRONMENT_BINDING_VERSION;
  bindingId: string;
  revision: string;
  presetId: KestrelEnvironmentPresetIdV1;
  shellKind: ShellKind;
  capabilityPacks: CapabilityPackId[];
  modelRoute: KestrelEnvironmentModelRouteV1;
  sandbox: {
    codeMode?: CodeModeProfileConfig | undefined;
    devShell?: DevShellProfileConfig | undefined;
  };
  apps: {
    approvalModes: Record<string, "auto" | "ask">;
    approvalPolicies?:
      | Record<
          string,
          import("../../mode/contracts.js").ToolApprovalPolicyEvidenceV1
        >
      | undefined;
  };
  tools: {
    additionalToolNames: string[];
    mcpServers: McpServerConfig[];
    ociMcpEgressBindings: Array<Record<string, unknown>>;
  };
  approvals: {
    policyPackId: "dev" | "ci_bot" | "production";
  };
  storage: {
    driver: "auto" | "postgres" | "sqlite";
  };
  queues: {
    tool: {
      perRunConcurrency?: number | undefined;
      globalConcurrency?: number | undefined;
      maxQueuedJobsPerRun?: number | undefined;
      checkpointSize?: number | undefined;
      retryCount?: number | undefined;
    };
  };
  tenant:
    | { scope: "local" }
    | {
        scope: "hosted_runtime";
        authoritySource: "trusted_host_context";
      }
    | {
        scope: "hosted";
        organizationId: string;
        environmentId: string;
      };
}

export interface KestrelEnvironmentSelectionV1 {
  version: typeof KESTREL_ENVIRONMENT_SELECTION_VERSION;
  surface: "cli" | "desktop" | "web";
  environment: KestrelEnvironmentNameV1;
  presetId: KestrelEnvironmentPresetIdV1;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const nonEmptyString = z.string().trim().min(1);
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const stringArray = z.array(nonEmptyString).max(4_096);

const reasoningSchema = z
  .object({
    request: z
      .object({
        mode: z.enum(["off", "summary", "provider_visible"]),
        effort: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict(),
    retention: z
      .object({
        mode: z.enum(["live_only", "provider_visible"]),
        days: nonNegativeSafeInteger,
      })
      .strict(),
  })
  .strict();

const interactionSchema = z
  .object({
    modeSystemV2Enabled: z.literal(true),
    defaultInteractionMode: z.enum(["chat", "plan", "build"]),
    defaultActSubmode: z.enum(["strict", "safe", "full_auto"]),
  })
  .strict();

const delegationSchema = z
  .object({
    allowAgentSpawn: z.literal(true),
    allowNestedCollaborators: z.literal(false),
    maxConcurrentChildSessions: positiveSafeInteger,
    maxDepth: positiveSafeInteger,
  })
  .strict();

const profileDefinitionSchema = z
  .object({
    version: z.literal(KESTREL_PROFILE_DEFINITION_VERSION),
    id: z.literal(KESTREL_CANONICAL_PROFILE_ID),
    revision: z.string().regex(HASH_PATTERN),
    label: z.literal(KESTREL_CANONICAL_PROFILE_LABEL),
    agent: z.literal("kestrel"),
    interaction: interactionSchema,
    evaluationPolicy: z.unknown().optional(),
    reasoning: reasoningSchema,
    delegation: delegationSchema,
  })
  .strict();

const credentialReferenceSchema = z
  .object({
    source: z.literal("kestrel-one"),
    runId: nonEmptyString,
    gatewayId: nonEmptyString,
    organizationId: nonEmptyString,
    environmentId: nonEmptyString,
    rawModelId: nonEmptyString,
    provider: z.enum(["openrouter", "openai", "anthropic", "ollama"]),
  })
  .strict();

const modelCapabilitiesSchema = z
  .object({
    visionInputEnabled: z.boolean(),
    toolCallingEnabled: z.boolean(),
    structuredOutputEnabled: z.boolean(),
    reasoningModes: z
      .array(z.enum(["off", "summary", "provider_visible"]))
      .min(1)
      .max(3),
  })
  .strict();

const recordReferenceSchema = z
  .object({ recordId: nonEmptyString, revision: nonEmptyString })
  .strict();

const modelRouteSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("runtime_configuration"),
      registrationSource: z.enum(["local_core", "hosted_control_plane"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pinned"),
      provider: z.enum([
        "openrouter",
        "openai",
        "anthropic",
        "ollama",
        "lmstudio",
      ]),
      model: nonEmptyString,
      modelRegistrationRevision: nonEmptyString,
      capabilities: modelCapabilitiesSchema,
      credentialReference: credentialReferenceSchema.optional(),
      pricingRecord: recordReferenceSchema.optional(),
      calibrationRecord: recordReferenceSchema.optional(),
    })
    .strict(),
]);

const codeModeSchema = z
  .object({
    enabled: z.boolean(),
    languages: z.array(z.enum(["javascript", "python", "bash"])).min(1),
    sandbox: z
      .object({
        executor: z.literal("docker"),
        timeoutMs: positiveSafeInteger,
        memoryMb: positiveSafeInteger,
        cpuShares: positiveSafeInteger,
        pidsLimit: positiveSafeInteger.optional(),
        workspaceSizeMb: positiveSafeInteger.optional(),
        workspaceInodes: positiveSafeInteger.optional(),
        tmpSizeMb: positiveSafeInteger.optional(),
        tmpInodes: positiveSafeInteger.optional(),
        networkDefault: z.enum(["off", "on"]),
        allowDependencyInstall: z.boolean(),
        maxOutputBytes: positiveSafeInteger,
        maxArtifacts: positiveSafeInteger,
        maxArtifactBytes: positiveSafeInteger,
      })
      .strict(),
    retention: z
      .object({ persistSummary: z.boolean(), persistArtifacts: z.boolean() })
      .strict(),
    approvalMode: z.literal("auto"),
    capabilities: z.array(z.object({
      version: z.literal(1),
      capabilityId: z.literal("tavily.search.read"),
      operations: z.tuple([z.literal("search")]),
      resource: z.literal("https://api.tavily.com/search"),
      audience: z.object({ tenantId: nonEmptyString, environmentId: nonEmptyString }).strict(),
      maxRequests: z.literal(1),
      maxQueryChars: z.number().int().min(1).max(400),
      maxResults: z.number().int().min(1).max(20),
      maxResponseBytes: z.number().int().min(256).max(64_000),
      timeoutMs: z.number().int().min(100).max(30_000),
      maxExpiryMs: z.number().int().min(100).max(60_000),
      brokerAuthority: z.object({ authorityId: nonEmptyString, revision: nonEmptyString }).strict(),
    }).strict()).optional(),
  })
  .strict();

const sourceWriteApprovalSchema = z
  .object({
    grantId: nonEmptyString,
    command: nonEmptyString,
    cwd: nonEmptyString.optional(),
    writablePaths: stringArray,
    expiresAt: nonEmptyString.optional(),
  })
  .strict();

const devShellSchema = z
  .object({
    enabled: z.boolean(),
    idleTimeoutMs: positiveSafeInteger.optional(),
    maxReadBytes: positiveSafeInteger.optional(),
    allowedEnvNames: stringArray.optional(),
    envMode: z.enum(["inherit", "allowlist"]).optional(),
    sourceWriteAuthority: z
      .enum(["source_readonly", "source_write"])
      .optional(),
    sourceWriteGuard: z
      .object({
        enabled: z.boolean().optional(),
        managedWorktree: z.boolean().optional(),
        sourceRoots: stringArray.optional(),
        allowedWriteRoots: stringArray.optional(),
        approvalGrants: z.array(sourceWriteApprovalSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const interactionModesSchema = z.array(z.enum(["chat", "plan", "build"]));
const mcpToolMetadataSchema = z
  .object({
    displayName: nonEmptyString,
    aliases: stringArray,
    keywords: stringArray,
    provider: nonEmptyString,
    toolFamily: nonEmptyString,
    capabilityClasses: stringArray,
    approvalMode: z.enum(["auto", "ask"]).optional(),
    allowedInteractionModes: interactionModesSchema.optional(),
  })
  .strict();
const mcpCommon = {
  id: nonEmptyString,
  enabled: z.boolean().optional(),
  toolMetadata: z.record(nonEmptyString, mcpToolMetadataSchema).optional(),
};
const mcpServerSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...mcpCommon,
      transport: z.literal("stdio"),
      command: nonEmptyString,
      args: stringArray.optional(),
    })
    .strict(),
  z
    .object({
      ...mcpCommon,
      transport: z.literal("http"),
      url: nonEmptyString,
      authTokenEnv: nonEmptyString.optional(),
      headerEnvs: z.record(nonEmptyString, nonEmptyString).optional(),
      oauthCredentialPrefix: z
        .string()
        .regex(/^mcp\..+/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...mcpCommon,
      transport: z.literal("sse"),
      url: nonEmptyString,
      authTokenEnv: nonEmptyString.optional(),
      headerEnvs: z.record(nonEmptyString, nonEmptyString).optional(),
      oauthCredentialPrefix: z
        .string()
        .regex(/^mcp\..+/u)
        .optional(),
    })
    .strict(),
]);

const ociEgressBindingSchema = z
  .object({
    version: z.literal(1),
    source: z.enum(["custom", "managed"]),
    organizationId: nonEmptyString,
    environmentId: nonEmptyString,
    serverId: nonEmptyString,
    imageDigest: z.string().regex(HASH_PATTERN),
    policyRevision: nonEmptyString,
    policyDigest: z.string().regex(HASH_PATTERN),
    policy: z.discriminatedUnion("mode", [
      z.object({ version: z.literal(1), mode: z.literal("none") }).strict(),
      z
        .object({
          version: z.literal(1),
          mode: z.literal("allow_hosts"),
          destinations: z
            .array(
              z
                .object({
                  hostname: nonEmptyString,
                  port: z.number().int().min(1).max(65_535),
                  protocol: z.enum(["http", "https"]),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
      z
        .object({
          version: z.literal(1),
          mode: z.literal("unrestricted"),
          acknowledgedRisk: z.literal(true),
          justification: nonEmptyString,
        })
        .strict(),
    ]),
  })
  .strict();

const toolQueueSchema = z
  .object({
    perRunConcurrency: positiveSafeInteger.optional(),
    globalConcurrency: positiveSafeInteger.optional(),
    maxQueuedJobsPerRun: positiveSafeInteger.optional(),
    checkpointSize: positiveSafeInteger.optional(),
    retryCount: nonNegativeSafeInteger.optional(),
  })
  .strict();

const environmentBindingSchema = z
  .object({
    version: z.literal(KESTREL_ENVIRONMENT_BINDING_VERSION),
    bindingId: nonEmptyString,
    revision: z.string().regex(HASH_PATTERN),
    presetId: z.enum([
      "cli_safe_local",
      "cli_dev_local",
      "desktop_safe_local",
      "desktop_dev_local",
      "workspace_hosted",
    ]),
    shellKind: z.enum(["cli", "desktop", "web"]),
    capabilityPacks: z.array(
      z.enum([
        "balanced",
        "filesystem",
        "dev_shell",
        "desktop_host",
        "sandbox_code",
      ]),
    ),
    modelRoute: modelRouteSchema,
    sandbox: z
      .object({
        codeMode: codeModeSchema.optional(),
        devShell: devShellSchema.optional(),
      })
      .strict(),
    apps: z
      .object({
        approvalModes: z.record(nonEmptyString, z.enum(["auto", "ask"])),
        approvalPolicies: z
          .record(
            nonEmptyString,
            z
              .object({
                environment: z.enum(["auto", "ask", "deny"]),
                project: z.enum(["auto", "ask", "deny"]).optional(),
                subject: z.enum(["auto", "ask", "deny"]).optional(),
                minimum: z.enum(["auto", "ask"]),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    tools: z
      .object({
        additionalToolNames: stringArray,
        mcpServers: z.array(mcpServerSchema),
        ociMcpEgressBindings: z.array(ociEgressBindingSchema),
      })
      .strict(),
    approvals: z
      .object({ policyPackId: z.enum(["dev", "ci_bot", "production"]) })
      .strict(),
    storage: z
      .object({ driver: z.enum(["auto", "postgres", "sqlite"]) })
      .strict(),
    queues: z.object({ tool: toolQueueSchema }).strict(),
    tenant: z.discriminatedUnion("scope", [
      z.object({ scope: z.literal("local") }).strict(),
      z
        .object({
          scope: z.literal("hosted_runtime"),
          authoritySource: z.literal("trusted_host_context"),
        })
        .strict(),
      z
        .object({
          scope: z.literal("hosted"),
          organizationId: nonEmptyString,
          environmentId: nonEmptyString,
        })
        .strict(),
    ]),
  })
  .strict();

const environmentSelectionSchema = z
  .object({
    version: z.literal(KESTREL_ENVIRONMENT_SELECTION_VERSION),
    surface: z.enum(["cli", "desktop", "web"]),
    environment: z.enum(["safe", "developer", "workspace_hosted"]),
    presetId: z.enum([
      "cli_safe_local",
      "cli_dev_local",
      "desktop_safe_local",
      "desktop_dev_local",
      "workspace_hosted",
    ]),
  })
  .strict();

export function createKestrelProfileDefinitionV1(
  input: Omit<
    KestrelProfileDefinitionV1,
    "version" | "id" | "revision" | "label"
  >,
): KestrelProfileDefinitionV1 {
  const draft = {
    ...structuredClone(input),
    version: KESTREL_PROFILE_DEFINITION_VERSION,
    id: KESTREL_CANONICAL_PROFILE_ID,
    revision: emptyHash(),
    label: KESTREL_CANONICAL_PROFILE_LABEL,
  } satisfies KestrelProfileDefinitionV1;
  draft.revision = fingerprintKestrelProfileDefinitionV1(draft);
  return parseKestrelProfileDefinitionV1(draft);
}

export function parseKestrelProfileDefinitionV1(
  value: unknown,
): KestrelProfileDefinitionV1 {
  const raw = profileDefinitionSchema.parse(value);
  const { evaluationPolicy: rawEvaluationPolicy, ...base } = raw;
  const parsed: KestrelProfileDefinitionV1 = {
    ...base,
    ...(rawEvaluationPolicy !== undefined
      ? {
          evaluationPolicy: parseRuntimeEvaluationPolicyV1(rawEvaluationPolicy),
        }
      : {}),
  };
  if (fingerprintKestrelProfileDefinitionV1(parsed) !== parsed.revision) {
    throw new Error(
      "Kestrel profile definition revision does not match its canonical payload.",
    );
  }
  return structuredClone(parsed);
}

export function fingerprintKestrelProfileDefinitionV1(
  value: KestrelProfileDefinitionV1,
): string {
  return digestCanonical(stripRevision(value));
}

export function createKestrelEnvironmentBindingV1(
  input: Omit<KestrelEnvironmentBindingV1, "version" | "revision">,
): KestrelEnvironmentBindingV1 {
  const draft = {
    ...structuredClone(input),
    version: KESTREL_ENVIRONMENT_BINDING_VERSION,
    revision: emptyHash(),
  } satisfies KestrelEnvironmentBindingV1;
  draft.revision = fingerprintKestrelEnvironmentBindingV1(draft);
  return parseKestrelEnvironmentBindingV1(draft);
}

export function parseKestrelEnvironmentBindingV1(
  value: unknown,
): KestrelEnvironmentBindingV1 {
  const raw = environmentBindingSchema.parse(value);
  const parsed = raw as KestrelEnvironmentBindingV1;
  requireUnique(parsed.capabilityPacks, "Kestrel environment capability packs");
  requireUnique(
    parsed.tools.additionalToolNames,
    "Kestrel environment additional tool names",
  );
  requireUnique(
    parsed.tools.mcpServers.map((server) => server.id),
    "Kestrel environment MCP server ids",
  );
  if (parsed.modelRoute.kind === "pinned") {
    requireUnique(
      parsed.modelRoute.capabilities.reasoningModes,
      "Kestrel environment model reasoning modes",
    );
  }
  assertEnvironmentPresetOwnership(parsed);
  assertPinnedRouteOwnership(parsed);
  if (fingerprintKestrelEnvironmentBindingV1(parsed) !== parsed.revision) {
    throw new Error(
      "Kestrel environment binding revision does not match its canonical payload.",
    );
  }
  return structuredClone(parsed);
}

export function fingerprintKestrelEnvironmentBindingV1(
  value: KestrelEnvironmentBindingV1,
): string {
  return digestCanonical(stripRevision(value));
}

export function parseKestrelEnvironmentSelectionV1(
  value: unknown,
): KestrelEnvironmentSelectionV1 {
  const parsed = environmentSelectionSchema.parse(value);
  const expected = resolveKestrelEnvironmentSelectionV1({
    surface: parsed.surface,
    environment: parsed.environment,
  });
  if (parsed.presetId !== expected.presetId) {
    throw new Error(
      "Kestrel environment selection preset does not match its surface and environment.",
    );
  }
  return parsed;
}

export function resolveKestrelEnvironmentSelectionV1(input: {
  surface: KestrelEnvironmentSelectionV1["surface"];
  environment: KestrelEnvironmentNameV1;
}): KestrelEnvironmentSelectionV1 {
  if (input.surface === "web") {
    if (input.environment !== "workspace_hosted") {
      throw new Error("Hosted Kestrel always resolves to workspace_hosted.");
    }
    return {
      version: KESTREL_ENVIRONMENT_SELECTION_VERSION,
      surface: "web",
      environment: "workspace_hosted",
      presetId: "workspace_hosted",
    };
  }
  if (input.environment === "workspace_hosted") {
    throw new Error("Local Kestrel surfaces cannot select workspace_hosted.");
  }
  const presetId =
    input.surface === "cli"
      ? input.environment === "developer"
        ? "cli_dev_local"
        : "cli_safe_local"
      : input.environment === "developer"
        ? "desktop_dev_local"
        : "desktop_safe_local";
  return {
    version: KESTREL_ENVIRONMENT_SELECTION_VERSION,
    surface: input.surface,
    environment: input.environment,
    presetId,
  };
}

export function canonicalizeFirstPartyKestrelProfileId(
  profileId: string,
): typeof KESTREL_CANONICAL_PROFILE_ID {
  if (profileId !== "kestrel" && profileId !== "kestrel-one") {
    throw new Error(
      `First-party Kestrel execution rejects non-canonical profile '${profileId}'.`,
    );
  }
  return KESTREL_CANONICAL_PROFILE_ID;
}

function assertEnvironmentPresetOwnership(
  binding: KestrelEnvironmentBindingV1,
): void {
  const expectedShellKind = binding.presetId.startsWith("cli_")
    ? "cli"
    : binding.presetId.startsWith("desktop_")
      ? "desktop"
      : "web";
  if (binding.shellKind !== expectedShellKind) {
    throw new Error(
      `Kestrel environment '${binding.bindingId}' preset does not belong to shell '${binding.shellKind}'.`,
    );
  }
  if (
    (binding.tenant.scope === "hosted" ||
      binding.tenant.scope === "hosted_runtime") &&
    binding.presetId !== "workspace_hosted"
  ) {
    throw new Error("Hosted tenant authority requires workspace_hosted.");
  }
  if (
    binding.tenant.scope === "local" &&
    binding.presetId === "workspace_hosted"
  ) {
    throw new Error("workspace_hosted requires hosted tenant authority.");
  }
  if (
    binding.modelRoute.kind === "runtime_configuration" &&
    (binding.modelRoute.registrationSource === "hosted_control_plane") !==
      (binding.presetId === "workspace_hosted")
  ) {
    throw new Error(
      "Kestrel runtime model registration source does not match its environment preset.",
    );
  }
}

function assertPinnedRouteOwnership(
  binding: KestrelEnvironmentBindingV1,
): void {
  if (binding.modelRoute.kind === "pinned") {
    const credential = binding.modelRoute.credentialReference;
    if (credential !== undefined) {
      if (
        credential.provider !== binding.modelRoute.provider ||
        credential.rawModelId !== binding.modelRoute.model
      ) {
        throw new Error(
          "Kestrel environment credential reference does not match its pinned route.",
        );
      }
      if (
        binding.tenant.scope !== "hosted" ||
        credential.organizationId !== binding.tenant.organizationId ||
        credential.environmentId !== binding.tenant.environmentId
      ) {
        throw new Error(
          "Kestrel environment credential reference does not match its tenant binding.",
        );
      }
    }
  }
}

function stripRevision<T extends { revision: string }>(
  value: T,
): Omit<T, "revision"> {
  const { revision: _revision, ...rest } = value;
  return rest;
}

function emptyHash(): string {
  return `sha256:${"0".repeat(64)}`;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
