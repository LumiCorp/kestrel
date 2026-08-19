import { z } from "zod";

export const ENVIRONMENT_PROVIDER_KINDS = ["fly", "kubernetes"] as const;
export const ENVIRONMENT_RESOURCE_ROLES = [
  "environment_scope",
  "gateway",
  "workspace_compute",
  "workspace_storage",
  "snapshot",
  "edge_route",
] as const;
export const ENVIRONMENT_EVIDENCE_LEVELS = [
  "implementation",
  "api_discovery",
  "cluster_preflight",
  "isolated_provider",
  "pilot",
  "production",
] as const;
export const ENVIRONMENT_PROVIDER_ERROR_CODES_V2 = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REJECTED",
  "RESOURCE_CONFLICT",
  "RESPONSE_INVALID",
  "RESOURCE_UNHEALTHY",
  "CAPABILITY_UNSUPPORTED",
  "OPERATION_TIMEOUT",
] as const;

export type EnvironmentProviderKind =
  (typeof ENVIRONMENT_PROVIDER_KINDS)[number];
export type EnvironmentResourceRole =
  (typeof ENVIRONMENT_RESOURCE_ROLES)[number];
export type EnvironmentEvidenceLevel =
  (typeof ENVIRONMENT_EVIDENCE_LEVELS)[number];
export type EnvironmentProviderErrorCodeV2 =
  (typeof ENVIRONMENT_PROVIDER_ERROR_CODES_V2)[number];

const identifierSchema = z.string().trim().min(1).max(255);
const placementValuesSchema = z.record(
  z.string().trim().min(1).max(120),
  z.string().trim().min(1).max(500),
);

export const environmentResourceRefSchema = z
  .object({
    provider: z.enum(ENVIRONMENT_PROVIDER_KINDS),
    role: z.enum(ENVIRONMENT_RESOURCE_ROLES),
    externalId: identifierSchema,
    observedGeneration: identifierSchema.optional(),
  })
  .strict();

export type EnvironmentResourceRef = z.infer<
  typeof environmentResourceRefSchema
>;

export const environmentPlacementSchema = z
  .object({
    connectionId: identifierSchema,
    requested: placementValuesSchema.nullable(),
    observed: placementValuesSchema.nullable(),
  })
  .strict();

export type EnvironmentPlacement = z.infer<typeof environmentPlacementSchema>;

export const environmentStorageSecuritySchema = z
  .object({
    encryption: z.enum([
      "provider_verified",
      "provider_attested",
      "unknown",
    ]),
    evidenceRef: identifierSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.encryption !== "unknown" && value.evidenceRef === null) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRef"],
        message: "Positive encryption claims require an evidence reference.",
      });
    }
  });

export type EnvironmentStorageSecurity = z.infer<
  typeof environmentStorageSecuritySchema
>;

export const environmentProviderEvidenceSchema = z
  .object({
    level: z.enum(ENVIRONMENT_EVIDENCE_LEVELS),
    providerCode: z.string().trim().min(1).max(120).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    phase: z.string().trim().min(1).max(160).optional(),
    providerRequestId: identifierSchema.optional(),
    kubernetesAuditId: identifierSchema.optional(),
    connectorCommandId: identifierSchema.optional(),
    resourceRef: environmentResourceRefSchema.optional(),
    detail: z
      .string()
      .transform(sanitizeEnvironmentProviderDetail)
      .pipe(z.string().min(1).max(500))
      .optional(),
  })
  .strict();

export type EnvironmentProviderEvidence = z.infer<
  typeof environmentProviderEvidenceSchema
>;

export const environmentProviderDescriptorV2Schema = z
  .object({
    provider: z.enum(ENVIRONMENT_PROVIDER_KINDS),
    label: z.string().trim().min(1).max(120),
    capabilities: z.array(z.string().trim().min(1).max(120)),
    evidenceLevel: z.enum(ENVIRONMENT_EVIDENCE_LEVELS),
    contractVersion: z.literal("environment-infrastructure-provider-v2"),
  })
  .strict();

export type EnvironmentProviderDescriptorV2 = Omit<
  z.infer<typeof environmentProviderDescriptorV2Schema>,
  "capabilities"
> & { capabilities: readonly string[] };

const environmentIdentitySchema = z
  .object({
    organizationId: identifierSchema,
    environmentId: identifierSchema,
  })
  .strict();

const workspaceIdentitySchema = environmentIdentitySchema
  .extend({ workspaceId: identifierSchema })
  .strict();

const sourceSchema = z
  .object({
    type: z.enum(["blank", "github"]),
    resourceId: identifierSchema.optional(),
    repository: z.string().trim().min(1).max(500).optional(),
    defaultBranch: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type EnvironmentIdentity = z.infer<typeof environmentIdentitySchema>;
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;
export type WorkspaceSourceV2 = z.infer<typeof sourceSchema>;

export type EnvironmentScopeStateV2 = {
  resource: EnvironmentResourceRef;
  placement: EnvironmentPlacement;
  evidence: EnvironmentProviderEvidence[];
};

export type EnvironmentGatewayStateV2 = {
  resource: EnvironmentResourceRef;
  edgeRoute: EnvironmentResourceRef;
  state: string;
  routerUrl: string;
  placement: EnvironmentPlacement;
  evidence: EnvironmentProviderEvidence[];
};

export type WorkspaceStorageStateV2 = {
  resource: EnvironmentResourceRef;
  sizeGb: number;
  placement: EnvironmentPlacement;
  security: EnvironmentStorageSecurity;
  evidence: EnvironmentProviderEvidence[];
};

export type WorkspaceComputeStateV2 = {
  resource: EnvironmentResourceRef;
  state: string;
  placement: EnvironmentPlacement;
  image: string | null;
  resolvedImageDigest: string | null;
  cpuKind: string | null;
  cpus: number | null;
  memoryMb: number | null;
  workspaceId: string | null;
  standbyFor: EnvironmentResourceRef[];
  storage: EnvironmentResourceRef[];
  evidence: EnvironmentProviderEvidence[];
};

export type WorkspaceSnapshotStateV2 = {
  resource: EnvironmentResourceRef;
  state: string;
  evidence: EnvironmentProviderEvidence[];
};

export type EnvironmentProviderInventoryV2 = {
  resources: Array<{
    ref: EnvironmentResourceRef;
    state: string | null;
    workspaceId: string | null;
    replacementId: string | null;
    relatedResources: EnvironmentResourceRef[];
  }>;
  evidence: EnvironmentProviderEvidence[];
};

export type WorkspaceRuntimeDesiredV2 = {
  runtimeImage: string;
  ticketPublicKey: string;
  controlPlaneUrl: string;
  serviceToken?: string | undefined;
  source: WorkspaceSourceV2;
  idleTimeoutMinutes: number;
};

export interface EnvironmentInfrastructureProviderV2 {
  readonly descriptor: EnvironmentProviderDescriptorV2;
  ensureEnvironmentScope(input: {
    identity: EnvironmentIdentity;
    placement: EnvironmentPlacement;
  }): Promise<EnvironmentScopeStateV2>;
  ensureEnvironmentGateway(input: {
    identity: EnvironmentIdentity;
    scope: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
    runtimeImage: string;
    ticketPublicKey: string;
    controlPlaneUrl: string;
    serviceToken: string;
  }): Promise<EnvironmentGatewayStateV2>;
  ensureWorkspaceStorage(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
  }): Promise<WorkspaceStorageStateV2>;
  ensureWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    storage: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
    desired: WorkspaceRuntimeDesiredV2;
  }): Promise<WorkspaceComputeStateV2>;
  getWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
  }): Promise<WorkspaceComputeStateV2 | null>;
  startWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
  }): Promise<void>;
  stopWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
  }): Promise<void>;
  updateWorkspaceImage(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
    runtimeImage: string;
    environmentPatch?: Record<string, string | undefined> | undefined;
    stopConfig?: { signal: string; timeout: number } | undefined;
  }): Promise<WorkspaceComputeStateV2>;
  createWorkspaceSnapshot(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    storage: EnvironmentResourceRef;
  }): Promise<WorkspaceSnapshotStateV2>;
  isWorkspaceSnapshotUsable(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    storage: EnvironmentResourceRef;
    snapshot: EnvironmentResourceRef;
  }): Promise<boolean>;
  createReplacementWorkspaceStorage(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
    replacementId: string;
    sourceStorage?: EnvironmentResourceRef | undefined;
    snapshot?: EnvironmentResourceRef | undefined;
  }): Promise<WorkspaceStorageStateV2>;
  createReplacementWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    storage: EnvironmentResourceRef;
    placement: EnvironmentPlacement;
    replacementId: string;
    desired: WorkspaceRuntimeDesiredV2;
  }): Promise<WorkspaceComputeStateV2>;
  listEnvironmentResources(input: {
    identity: EnvironmentIdentity;
    scope: EnvironmentResourceRef;
  }): Promise<EnvironmentProviderInventoryV2>;
  deleteWorkspaceCompute(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
  }): Promise<void>;
  deleteWorkspaceStorage(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    storage: EnvironmentResourceRef;
  }): Promise<void>;
  deleteEnvironmentScope(input: {
    identity: EnvironmentIdentity;
    scope: EnvironmentResourceRef;
  }): Promise<void>;
  waitForWorkspaceState(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
    state: "started" | "stopped" | "destroyed";
    timeoutSeconds?: number | undefined;
  }): Promise<void>;
  waitForWorkspaceHealth(input: {
    identity: WorkspaceIdentity;
    scope: EnvironmentResourceRef;
    compute: EnvironmentResourceRef;
    checkName: string;
    timeoutSeconds?: number | undefined;
  }): Promise<void>;
}

export class EnvironmentProviderErrorV2 extends Error {
  readonly code: EnvironmentProviderErrorCodeV2;
  readonly evidence: EnvironmentProviderEvidence;
  readonly retryable: boolean;
  readonly reconciliationState:
    | {
        resource: EnvironmentResourceRef | null;
        state: string | null;
        image: string | null;
      }
    | undefined;

  constructor(input: {
    code: EnvironmentProviderErrorCodeV2;
    message: string;
    evidence: EnvironmentProviderEvidence;
    retryable?: boolean | undefined;
    reconciliationState?:
      | {
          resource: EnvironmentResourceRef | null;
          state: string | null;
          image: string | null;
        }
      | undefined;
  }) {
    super(input.message);
    this.name = "EnvironmentProviderErrorV2";
    this.code = input.code;
    this.evidence = environmentProviderEvidenceSchema.parse(input.evidence);
    this.retryable = input.retryable ?? false;
    this.reconciliationState = input.reconciliationState;
  }
}

export function parseEnvironmentResourceRef(value: unknown) {
  return environmentResourceRefSchema.parse(value);
}

export function parseEnvironmentPlacement(value: unknown) {
  return environmentPlacementSchema.parse(value);
}

export function parseEnvironmentStorageSecurity(value: unknown) {
  return environmentStorageSecuritySchema.parse(value);
}

export function parseEnvironmentProviderEvidence(value: unknown) {
  return environmentProviderEvidenceSchema.parse(value);
}

export function compareEnvironmentEvidenceLevels(
  left: EnvironmentEvidenceLevel,
  right: EnvironmentEvidenceLevel,
) {
  return (
    ENVIRONMENT_EVIDENCE_LEVELS.indexOf(left) -
    ENVIRONMENT_EVIDENCE_LEVELS.indexOf(right)
  );
}

export function sanitizeEnvironmentProviderDetail(value: string) {
  return value
    .replace(/authorization\s*[:=]\s*\S+/giu, "authorization=[redacted]")
    .replace(/bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 500);
}
