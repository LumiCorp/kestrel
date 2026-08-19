import { z } from "zod";
import { parseConnectorCommandSecrets } from "@lumi/kestrel-environment-auth";

export const COMMAND_VERSION = "infrastructure-connector-command-v1" as const;
export const RESULT_VERSION = "infrastructure-connector-result-v1" as const;
export const EVENT_VERSION = "infrastructure-connector-event-v1" as const;
export const PRESENCE_VERSION = "infrastructure-connector-presence-v1" as const;
export const QUALIFICATION_REPORT_VERSION =
  "kubernetes-qualification-report-v1" as const;

const identifier = z.string().trim().min(1).max(255);
const digestImage = z.string().regex(/@sha256:[a-f0-9]{64}$/u);
export const commandTypes = [
  "qualify_connection",
  "ensure_environment_scope",
  "ensure_environment_gateway",
  "ensure_workspace_storage",
  "ensure_workspace_compute",
  "get_workspace_compute",
  "start_workspace_compute",
  "stop_workspace_compute",
  "update_workspace_image",
  "create_workspace_snapshot",
  "is_workspace_snapshot_usable",
  "create_replacement_workspace_storage",
  "create_replacement_workspace_compute",
  "list_environment_resources",
  "delete_workspace_compute",
  "delete_workspace_storage",
  "delete_environment_scope",
  "wait_for_workspace_state",
  "wait_for_workspace_health",
] as const;

export type ConnectorCommandType = (typeof commandTypes)[number];

const resourceRole = z.enum([
  "environment_scope",
  "gateway",
  "workspace_compute",
  "workspace_storage",
  "snapshot",
  "edge_route",
]);

export const connectorResourceRefSchema = z
  .object({
    provider: z.literal("kubernetes"),
    role: resourceRole,
    externalId: identifier,
    observedGeneration: identifier.optional(),
  })
  .strict();

const placementSchema = z
  .object({
    connectionId: identifier,
    requested: z.record(z.string(), z.string()).nullable(),
    observed: z.record(z.string(), z.string()).nullable(),
  })
  .strict();

const sourceSchema = z
  .object({
    type: z.enum(["blank", "github"]),
    resourceId: identifier.optional(),
    repository: z.string().trim().min(1).max(500).optional(),
    defaultBranch: identifier.optional(),
  })
  .strict();

const runtimeDesiredSchema = z
  .object({
    runtimeImage: digestImage,
    ticketPublicKey: z.string().min(32).max(8192),
    controlPlaneUrl: z.string().url(),
    serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    source: sourceSchema,
    idleTimeoutMinutes: z.number().int().positive(),
  })
  .strict();

const lifecycleBaseSchema = z
  .object({
    configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    profile: z.record(z.string(), z.unknown()),
  })
  .strict();

const scopePayloadSchema = lifecycleBaseSchema.extend({
  workspaceLimit: z.number().int().positive(),
  runtimeTemplate: z.literal("kestrel-standard-v1"),
}).strict();

const scopedPayloadSchema = lifecycleBaseSchema.extend({
  scope: connectorResourceRefSchema,
}).strict();

const computeReferencePayloadSchema = scopedPayloadSchema.extend({
  compute: connectorResourceRefSchema,
}).strict();

export const lifecyclePayloadSchemas = {
  ensure_environment_scope: scopePayloadSchema,
  ensure_environment_gateway: scopedPayloadSchema.extend({
    placement: placementSchema,
    runtimeImage: digestImage,
    ticketPublicKey: z.string().min(32).max(8192),
    controlPlaneUrl: z.string().url(),
    serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }).strict(),
  ensure_workspace_storage: scopedPayloadSchema.extend({
    placement: placementSchema,
    sizeGb: z.literal(20),
  }).strict(),
  ensure_workspace_compute: scopedPayloadSchema.extend({
    storage: connectorResourceRefSchema,
    placement: placementSchema,
    desired: runtimeDesiredSchema,
  }).strict(),
  get_workspace_compute: computeReferencePayloadSchema,
  start_workspace_compute: computeReferencePayloadSchema,
  stop_workspace_compute: computeReferencePayloadSchema,
  update_workspace_image: computeReferencePayloadSchema.extend({
    runtimeImage: digestImage,
    environmentPatch: z.record(z.string(), z.string().optional()).optional(),
    stopConfig: z.object({ signal: identifier, timeout: z.number().int().positive() }).strict().optional(),
  }).strict(),
  create_workspace_snapshot: scopedPayloadSchema.extend({
    storage: connectorResourceRefSchema,
  }).strict(),
  is_workspace_snapshot_usable: scopedPayloadSchema.extend({
    storage: connectorResourceRefSchema,
    snapshot: connectorResourceRefSchema,
  }).strict(),
  create_replacement_workspace_storage: scopedPayloadSchema.extend({
    placement: placementSchema,
    replacementId: identifier,
    sourceStorage: connectorResourceRefSchema.optional(),
    snapshot: connectorResourceRefSchema,
  }).strict(),
  create_replacement_workspace_compute: scopedPayloadSchema.extend({
    storage: connectorResourceRefSchema,
    placement: placementSchema,
    replacementId: identifier,
    desired: runtimeDesiredSchema,
  }).strict(),
  list_environment_resources: scopedPayloadSchema,
  delete_workspace_compute: computeReferencePayloadSchema,
  delete_workspace_storage: scopedPayloadSchema.extend({
    storage: connectorResourceRefSchema,
  }).strict(),
  delete_environment_scope: scopedPayloadSchema,
  wait_for_workspace_state: computeReferencePayloadSchema.extend({
    state: z.enum(["started", "stopped", "destroyed"]),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
  }).strict(),
  wait_for_workspace_health: computeReferencePayloadSchema.extend({
    checkName: identifier,
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
  }).strict(),
} as const;

export const connectorCommandSchema = z
  .object({
    contract: z.literal(COMMAND_VERSION),
    id: identifier,
    idempotencyKey: identifier,
    connectionId: identifier,
    organizationId: identifier,
    environmentId: identifier.optional(),
    workspaceId: identifier.optional(),
    desiredRevision: identifier,
    type: z.enum(commandTypes),
    payload: z.record(z.string(), z.unknown()),
    encryptedSecrets: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(65_536).refine((value) => {
      try {
        parseConnectorCommandSecrets(value);
        return true;
      } catch {
        return false;
      }
    }, "Encrypted secrets envelope is invalid.").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "qualify_connection") {
      if (value.encryptedSecrets !== undefined) {
        context.addIssue({ code: "custom", path: ["encryptedSecrets"], message: "Qualification commands cannot carry secrets." });
      }
      return;
    }
    const parsed = lifecyclePayloadSchemas[value.type].safeParse(value.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["payload", ...issue.path],
          message: issue.message,
        });
      }
      return;
    }
    const computePayload =
      value.type === "ensure_workspace_compute"
        ? lifecyclePayloadSchemas.ensure_workspace_compute.parse(value.payload)
        : value.type === "create_replacement_workspace_compute"
          ? lifecyclePayloadSchemas.create_replacement_workspace_compute.parse(
              value.payload,
            )
          : null;
    const computeServiceTokenHash =
      computePayload?.desired.serviceTokenHash;
    const secretRequired =
      value.type === "ensure_environment_gateway" ||
      computeServiceTokenHash !== undefined;
    const secretAllowed =
      secretRequired ||
      value.type === "ensure_workspace_compute" ||
      value.type === "create_replacement_workspace_compute";
    if (secretRequired && value.encryptedSecrets === undefined) {
      context.addIssue({ code: "custom", path: ["encryptedSecrets"], message: "Encrypted command secrets are required." });
    }
    if (!secretAllowed && value.encryptedSecrets !== undefined) {
      context.addIssue({ code: "custom", path: ["encryptedSecrets"], message: `${value.type} cannot carry command secrets.` });
    }
    if (
      (value.type === "ensure_workspace_compute" ||
        value.type === "create_replacement_workspace_compute") &&
      value.encryptedSecrets !== undefined &&
      computeServiceTokenHash === undefined
    ) {
      context.addIssue({ code: "custom", path: ["payload", "desired", "serviceTokenHash"], message: "Encrypted service tokens require their hash." });
    }
  });

export type ConnectorCommand = z.infer<typeof connectorCommandSchema>;

export function parseConnectorCommandPayload(command: ConnectorCommand) {
  if (command.type === "qualify_connection") {
    return qualificationPayloadSchema.parse(command.payload);
  }
  return lifecyclePayloadSchemas[command.type].parse(command.payload);
}

export const connectorEventSchema = z
  .object({
    contract: z.literal(EVENT_VERSION),
    commandId: identifier,
    sequence: z.number().int().positive(),
    type: z.enum(["progress", "condition", "warning"]),
    state: z.string().trim().min(1).max(120).optional(),
    message: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const qualificationCheckIds = [
  "discovery.version",
  "discovery.resources",
  "authorization.exact_verbs",
  "prerequisite.storage_class",
  "prerequisite.snapshot_class",
  "prerequisite.edge",
  "active.baseline",
  "active.image_pull_and_schedule",
  "active.pvc_persistence",
  "active.snapshot_restore",
  "active.edge_route",
  "active.public_dns_tls",
  "active.allowed_network_paths",
  "active.denied_network_paths",
  "active.quota_rejection",
  "cleanup.namespace_removed",
] as const;

export const qualificationReportSchema = z
  .object({
    contract: z.literal(QUALIFICATION_REPORT_VERSION),
    runId: identifier,
    connectionId: identifier,
    configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    clusterFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceClass: z.literal("isolated_provider"),
    observed: z
      .object({
        kubernetesVersion: z.string().trim().min(1).max(120),
        distribution: z.enum(["gke", "eks", "other"]),
        storageDriver: z.string().trim().min(1).max(253),
        snapshotDriver: z.string().trim().min(1).max(253),
        edgeController: z.string().trim().min(1).max(253),
        edgeMode: z.enum(["gateway_api", "ingress"]),
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            id: z.enum(qualificationCheckIds),
            status: z.enum(["passed", "failed", "blocked", "not_run"]),
            evidenceClass: z.enum(["cluster_preflight", "isolated_provider"]),
            detail: z.string().trim().min(1).max(500),
            observedVersion: z.string().trim().min(1).max(120).optional(),
            auditId: z.string().trim().min(1).max(255).optional(),
          })
          .strict(),
      )
      .length(qualificationCheckIds.length),
    cleanup: z
      .object({
        status: z.enum(["passed", "failed"]),
        namespace: z.string().trim().min(1).max(63),
        residualResources: z.array(z.string().trim().min(1).max(255)).max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const ids = report.checks.map((check) => check.id);
    for (const expected of qualificationCheckIds) {
      if (ids.filter((id) => id === expected).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: `Qualification must contain exactly one ${expected} result.`,
        });
      }
    }
    if (new Date(report.expiresAt) <= new Date(report.completedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Qualification evidence must expire after completion.",
      });
    }
  });

export type QualificationReport = z.infer<typeof qualificationReportSchema>;

export const qualificationPayloadSchema = z
  .object({
    runId: identifier,
    configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    profile: z.record(z.string(), z.unknown()),
    probeImage: z
      .string()
      .regex(/@sha256:[a-f0-9]{64}$/u),
    expiresAt: z.string().datetime(),
  })
  .strict();

const connectorConditionSchema = z
  .object({
    type: identifier,
    status: identifier,
    reason: z.string().trim().min(1).max(160).optional(),
    message: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const connectorResourceObservationSchema = z
  .object({
    resource: connectorResourceRefSchema,
    disposition: z.enum(["created", "adopted", "unchanged", "updated", "deleted"]),
    providerUid: identifier.optional(),
    observedGeneration: identifier.optional(),
    kind: identifier,
    namespace: identifier.optional(),
    state: identifier.optional(),
    workspaceId: identifier.optional(),
    replacementId: identifier.optional(),
    relatedResources: z.array(connectorResourceRefSchema).optional(),
    conditions: z.array(connectorConditionSchema).optional(),
  })
  .strict();

const connectorOutputSchema = z
  .object({
    state: identifier.optional(),
    usable: z.boolean().optional(),
    routerUrl: z.string().url().optional(),
    placement: placementSchema.optional(),
    storageSecurity: z
      .object({
        encryption: z.enum(["provider_verified", "provider_attested", "unknown"]),
        evidenceRef: identifier.nullable(),
      })
      .strict()
      .optional(),
    sizeGb: z.number().int().positive().optional(),
    image: digestImage.nullable().optional(),
    resolvedImageDigest: digestImage.nullable().optional(),
    cpuKind: identifier.nullable().optional(),
    cpus: z.number().positive().nullable().optional(),
    memoryMb: z.number().int().positive().nullable().optional(),
    workspaceId: identifier.nullable().optional(),
    serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    resourceObservations: z.array(connectorResourceObservationSchema).optional(),
    conditions: z.array(connectorConditionSchema).optional(),
  })
  .strict();

export const connectorResultSchema = z
  .object({
    contract: z.literal(RESULT_VERSION),
    commandId: identifier,
    connectionId: identifier,
    commandType: z.enum(commandTypes),
    status: z.enum(["succeeded", "failed"]),
    observedRevision: identifier,
    resources: z.array(z.record(z.string(), z.unknown())),
    evidence: z.array(z.record(z.string(), z.unknown())),
    output: connectorOutputSchema.optional(),
    error: z
      .object({
        code: identifier,
        message: z.string().trim().min(1).max(500),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allowed = allowedResultRoles[value.commandType];
    for (const [index, resource] of value.resources.entries()) {
      const role = resource.role;
      if (typeof role === "string" && !allowed.has(role)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "role"],
          message: `${value.commandType} cannot return a ${role} resource.`,
        });
      }
    }
    const allowedObservations = allowedObservationRoles[value.commandType];
    for (const [index, observation] of (value.output?.resourceObservations ?? []).entries()) {
      if (!allowedObservations.has(observation.resource.role)) {
        context.addIssue({
          code: "custom",
          path: ["output", "resourceObservations", index, "resource", "role"],
          message: `${value.commandType} cannot observe a ${observation.resource.role} resource.`,
        });
      }
    }
  });

const noResultRoles = new Set<string>();
const allResultRoles = new Set(resourceRole.options);
const allowedResultRoles: Record<ConnectorCommandType, ReadonlySet<string>> = {
  qualify_connection: noResultRoles,
  ensure_environment_scope: new Set(["environment_scope"]),
  ensure_environment_gateway: new Set(["gateway", "edge_route"]),
  ensure_workspace_storage: new Set(["workspace_storage"]),
  ensure_workspace_compute: new Set(["workspace_compute"]),
  get_workspace_compute: new Set(["workspace_compute"]),
  start_workspace_compute: new Set(["workspace_compute"]),
  stop_workspace_compute: new Set(["workspace_compute"]),
  update_workspace_image: new Set(["workspace_compute"]),
  create_workspace_snapshot: new Set(["snapshot"]),
  is_workspace_snapshot_usable: new Set(["snapshot"]),
  create_replacement_workspace_storage: new Set(["workspace_storage"]),
  create_replacement_workspace_compute: new Set(["workspace_compute"]),
  list_environment_resources: allResultRoles,
  delete_workspace_compute: noResultRoles,
  delete_workspace_storage: noResultRoles,
  delete_environment_scope: noResultRoles,
  wait_for_workspace_state: new Set(["workspace_compute"]),
  wait_for_workspace_health: new Set(["workspace_compute"]),
};

const allowedObservationRoles: Record<ConnectorCommandType, ReadonlySet<string>> = {
  ...allowedResultRoles,
  delete_workspace_compute: new Set(["workspace_compute"]),
  delete_workspace_storage: new Set(["workspace_storage"]),
  delete_environment_scope: new Set(["environment_scope"]),
};
