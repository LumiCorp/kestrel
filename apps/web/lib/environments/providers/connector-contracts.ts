import { z } from "zod";
import { parseConnectorCommandSecrets } from "@lumi/kestrel-environment-auth";
import {
  ENVIRONMENT_PROVIDER_ERROR_CODES_V2,
  environmentProviderEvidenceSchema,
  environmentResourceRefSchema,
  environmentPlacementSchema,
  environmentStorageSecuritySchema,
  type EnvironmentResourceRole,
} from "./contracts-v2";

export const INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION =
  "infrastructure-connector-command-v1" as const;
export const INFRASTRUCTURE_CONNECTOR_RESULT_VERSION =
  "infrastructure-connector-result-v1" as const;

export const KUBERNETES_CONNECTOR_COMMAND_TYPES = [
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

export type KubernetesConnectorCommandType =
  (typeof KUBERNETES_CONNECTOR_COMMAND_TYPES)[number];

const identifierSchema = z.string().trim().min(1).max(255);
const digestImageSchema = z.string().regex(/@sha256:[a-f0-9]{64}$/u);
const encryptedSecretsSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]+$/u, "Encrypted secrets must be an opaque base64url envelope.")
  .max(65_536)
  .refine((value) => {
    try {
      parseConnectorCommandSecrets(value);
      return true;
    } catch {
      return false;
    }
  }, "Encrypted secrets envelope is invalid.");

const kubernetesResourceRefSchema = environmentResourceRefSchema.refine(
  (resource) => resource.provider === "kubernetes",
  "Connector lifecycle resources must belong to Kubernetes.",
);
const lifecycleBaseSchema = z.object({
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  profile: z.record(z.string(), z.unknown()),
}).strict();
const scopedPayloadSchema = lifecycleBaseSchema.extend({
  scope: kubernetesResourceRefSchema,
}).strict();
const computePayloadSchema = scopedPayloadSchema.extend({
  compute: kubernetesResourceRefSchema,
}).strict();
const runtimeDesiredSchema = z.object({
  runtimeImage: digestImageSchema,
  ticketPublicKey: z.string().min(32).max(8192),
  controlPlaneUrl: z.string().url(),
  serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
  source: z.object({
    type: z.enum(["blank", "github"]),
    resourceId: identifierSchema.optional(),
    repository: z.string().trim().min(1).max(500).optional(),
    defaultBranch: identifierSchema.optional(),
  }).strict(),
  idleTimeoutMinutes: z.number().int().positive(),
}).strict();

export const kubernetesLifecyclePayloadSchemas = {
  ensure_environment_scope: lifecycleBaseSchema.extend({
    workspaceLimit: z.number().int().positive(),
    runtimeTemplate: z.literal("kestrel-standard-v1"),
  }).strict(),
  ensure_environment_gateway: scopedPayloadSchema.extend({
    placement: environmentPlacementSchema,
    runtimeImage: digestImageSchema,
    ticketPublicKey: z.string().min(32).max(8192),
    controlPlaneUrl: z.string().url(),
    serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }).strict(),
  ensure_workspace_storage: scopedPayloadSchema.extend({
    placement: environmentPlacementSchema,
    sizeGb: z.literal(20),
  }).strict(),
  ensure_workspace_compute: scopedPayloadSchema.extend({
    storage: kubernetesResourceRefSchema,
    placement: environmentPlacementSchema,
    desired: runtimeDesiredSchema,
  }).strict(),
  get_workspace_compute: computePayloadSchema,
  start_workspace_compute: computePayloadSchema,
  stop_workspace_compute: computePayloadSchema,
  update_workspace_image: computePayloadSchema.extend({
    runtimeImage: digestImageSchema,
    environmentPatch: z.record(z.string(), z.string().optional()).optional(),
    stopConfig: z.object({ signal: identifierSchema, timeout: z.number().int().positive() }).strict().optional(),
  }).strict(),
  create_workspace_snapshot: scopedPayloadSchema.extend({ storage: kubernetesResourceRefSchema }).strict(),
  is_workspace_snapshot_usable: scopedPayloadSchema.extend({
    storage: kubernetesResourceRefSchema,
    snapshot: kubernetesResourceRefSchema,
  }).strict(),
  create_replacement_workspace_storage: scopedPayloadSchema.extend({
    placement: environmentPlacementSchema,
    replacementId: identifierSchema,
    sourceStorage: kubernetesResourceRefSchema.optional(),
    snapshot: kubernetesResourceRefSchema,
  }).strict(),
  create_replacement_workspace_compute: scopedPayloadSchema.extend({
    storage: kubernetesResourceRefSchema,
    placement: environmentPlacementSchema,
    replacementId: identifierSchema,
    desired: runtimeDesiredSchema,
  }).strict(),
  list_environment_resources: scopedPayloadSchema,
  delete_workspace_compute: computePayloadSchema,
  delete_workspace_storage: scopedPayloadSchema.extend({ storage: kubernetesResourceRefSchema }).strict(),
  delete_environment_scope: scopedPayloadSchema,
  wait_for_workspace_state: computePayloadSchema.extend({
    state: z.enum(["started", "stopped", "destroyed"]),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
  }).strict(),
  wait_for_workspace_health: computePayloadSchema.extend({
    checkName: identifierSchema,
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
  }).strict(),
} as const;

export function parseKubernetesLifecyclePayload(
  type: Exclude<KubernetesConnectorCommandType, "qualify_connection">,
  payload: unknown,
) {
  return kubernetesLifecyclePayloadSchemas[type].parse(payload);
}

export const infrastructureConnectorCommandV1Schema = z
  .object({
    contract: z.literal(INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION),
    id: identifierSchema,
    idempotencyKey: identifierSchema,
    connectionId: identifierSchema,
    organizationId: identifierSchema,
    environmentId: identifierSchema.optional(),
    workspaceId: identifierSchema.optional(),
    desiredRevision: identifierSchema,
    type: z.enum(KUBERNETES_CONNECTOR_COMMAND_TYPES),
    payload: z.record(z.string(), z.unknown()),
    encryptedSecrets: encryptedSecretsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const environmentRequired = value.type !== "qualify_connection";
    if (environmentRequired && value.environmentId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["environmentId"],
        message: `${value.type} requires an Environment identity.`,
      });
    }
    const workspaceRequired = WORKSPACE_COMMAND_TYPES.has(value.type);
    if (workspaceRequired && value.workspaceId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workspaceId"],
        message: `${value.type} requires a workspace identity.`,
      });
    }
    if (value.type === "qualify_connection" && value.encryptedSecrets !== undefined) {
      context.addIssue({ code: "custom", path: ["encryptedSecrets"], message: "Qualification commands cannot carry secrets." });
    }
    if (value.type !== "qualify_connection") {
      const parsed = kubernetesLifecyclePayloadSchemas[value.type].safeParse(
        value.payload,
      );
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["payload", ...issue.path],
            message: issue.message,
          });
        }
      } else {
        const computePayload =
          value.type === "ensure_workspace_compute"
            ? kubernetesLifecyclePayloadSchemas.ensure_workspace_compute.parse(
                value.payload,
              )
            : value.type === "create_replacement_workspace_compute"
              ? kubernetesLifecyclePayloadSchemas.create_replacement_workspace_compute.parse(
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
      }
    }
  });

export type InfrastructureConnectorCommandV1 = z.infer<
  typeof infrastructureConnectorCommandV1Schema
>;

const connectorFailureSchema = z
  .object({
    code: z.enum(ENVIRONMENT_PROVIDER_ERROR_CODES_V2),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  })
  .strict();

const connectorOutputSchema = z
  .object({
    state: z.string().trim().min(1).max(120).optional(),
    usable: z.boolean().optional(),
    routerUrl: z.string().url().optional(),
    placement: environmentPlacementSchema.optional(),
    storageSecurity: environmentStorageSecuritySchema.optional(),
    sizeGb: z.number().int().positive().optional(),
    image: digestImageSchema.nullable().optional(),
    resolvedImageDigest: digestImageSchema.nullable().optional(),
    cpuKind: identifierSchema.nullable().optional(),
    cpus: z.number().positive().nullable().optional(),
    memoryMb: z.number().int().positive().nullable().optional(),
    workspaceId: identifierSchema.nullable().optional(),
    serviceTokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    resourceObservations: z.array(z.object({
      resource: kubernetesResourceRefSchema,
      disposition: z.enum(["created", "adopted", "unchanged", "updated", "deleted"]),
      providerUid: identifierSchema.optional(),
      observedGeneration: identifierSchema.optional(),
      kind: identifierSchema,
      namespace: identifierSchema.optional(),
      state: identifierSchema.optional(),
      workspaceId: identifierSchema.optional(),
      replacementId: identifierSchema.optional(),
      relatedResources: z.array(kubernetesResourceRefSchema).optional(),
      conditions: z.array(z.object({
        type: identifierSchema,
        status: identifierSchema,
        reason: z.string().trim().min(1).max(160).optional(),
        message: z.string().trim().min(1).max(500).optional(),
      }).strict()).optional(),
    }).strict()).optional(),
    conditions: z
      .array(
        z
          .object({
            type: z.string().trim().min(1).max(120),
            status: z.string().trim().min(1).max(120),
            reason: z.string().trim().min(1).max(160).optional(),
            message: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const infrastructureConnectorResultV1Schema = z
  .object({
    contract: z.literal(INFRASTRUCTURE_CONNECTOR_RESULT_VERSION),
    commandId: identifierSchema,
    connectionId: identifierSchema,
    commandType: z.enum(KUBERNETES_CONNECTOR_COMMAND_TYPES),
    status: z.enum(["succeeded", "failed"]),
    observedRevision: identifierSchema,
    resources: z.array(environmentResourceRefSchema),
    evidence: z.array(environmentProviderEvidenceSchema),
    output: connectorOutputSchema.optional(),
    error: connectorFailureSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed connector results require a normalized error.",
      });
    }
    if (value.status === "succeeded" && value.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Successful connector results cannot contain an error.",
      });
    }
    const allowedRoles = RESULT_ROLES[value.commandType];
    for (const [index, resource] of value.resources.entries()) {
      if (!allowedRoles.has(resource.role)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "role"],
          message: `${value.commandType} cannot return a ${resource.role} resource.`,
        });
      }
    }
    const allowedObservations = OBSERVATION_ROLES[value.commandType];
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

export type InfrastructureConnectorResultV1 = z.infer<
  typeof infrastructureConnectorResultV1Schema
>;

export const infrastructureConnectorPresenceV1Schema = z
  .object({
    connectionId: identifierSchema,
    connectorVersion: identifierSchema,
    commandVersions: z.array(identifierSchema).min(1),
    resultVersions: z.array(identifierSchema).min(1),
  })
  .strict();

export type InfrastructureConnectorPresenceV1 = z.infer<
  typeof infrastructureConnectorPresenceV1Schema
>;

export class InfrastructureConnectorCompatibilityError extends Error {
  readonly code = "CONNECTOR_CONTRACT_INCOMPATIBLE";

  constructor(message: string) {
    super(message);
    this.name = "InfrastructureConnectorCompatibilityError";
  }
}

export function parseInfrastructureConnectorCommandV1(value: unknown) {
  return infrastructureConnectorCommandV1Schema.parse(value);
}

export function parseInfrastructureConnectorResultV1(value: unknown) {
  return infrastructureConnectorResultV1Schema.parse(value);
}

export function parseInfrastructureConnectorPresenceV1(value: unknown) {
  return infrastructureConnectorPresenceV1Schema.parse(value);
}

export function negotiateInfrastructureConnectorV1(value: unknown) {
  let presence: InfrastructureConnectorPresenceV1;
  try {
    presence = parseInfrastructureConnectorPresenceV1(value);
  } catch {
    throw new InfrastructureConnectorCompatibilityError(
      "Connector does not advertise the required command and result contracts.",
    );
  }
  if (
    !presence.commandVersions.includes(
      INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
    ) ||
    !presence.resultVersions.includes(INFRASTRUCTURE_CONNECTOR_RESULT_VERSION)
  ) {
    throw new InfrastructureConnectorCompatibilityError(
      "Connector does not support the required v1 command and result contracts.",
    );
  }
  return {
    commandVersion: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
    resultVersion: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
    connectorVersion: presence.connectorVersion,
  } as const;
}

const WORKSPACE_COMMAND_TYPES = new Set<KubernetesConnectorCommandType>([
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
  "delete_workspace_compute",
  "delete_workspace_storage",
  "wait_for_workspace_state",
  "wait_for_workspace_health",
]);

const allRoles = new Set<EnvironmentResourceRole>([
  "environment_scope",
  "gateway",
  "workspace_compute",
  "workspace_storage",
  "snapshot",
  "edge_route",
]);
const noRoles = new Set<EnvironmentResourceRole>();

const RESULT_ROLES: Record<
  KubernetesConnectorCommandType,
  ReadonlySet<EnvironmentResourceRole>
> = {
  qualify_connection: noRoles,
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
  list_environment_resources: allRoles,
  delete_workspace_compute: noRoles,
  delete_workspace_storage: noRoles,
  delete_environment_scope: noRoles,
  wait_for_workspace_state: new Set(["workspace_compute"]),
  wait_for_workspace_health: new Set(["workspace_compute"]),
};

const OBSERVATION_ROLES: Record<
  KubernetesConnectorCommandType,
  ReadonlySet<EnvironmentResourceRole>
> = {
  ...RESULT_ROLES,
  delete_workspace_compute: new Set(["workspace_compute"]),
  delete_workspace_storage: new Set(["workspace_storage"]),
  delete_environment_scope: new Set(["environment_scope"]),
};
