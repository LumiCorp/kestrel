import { z } from "zod";
import {
  assertEnvironmentProviderCompatibility,
  type EnvironmentProviderCapability,
  type EnvironmentProviderDescriptor,
  REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
} from "./contracts";
import {
  parseKubernetesByocProfileV1,
  profileHasRequiredEncryptionAttestations,
  resolveKubernetesByocSupportState,
  type KubernetesByocProfileV1,
  type KubernetesByocSupportState,
} from "./kubernetes-byoc-profile";

const kubernetesVersionSchema = z.object({
  gitVersion: z.string().trim().min(1),
});

const kubernetesApiResourceListSchema = z.object({
  groupVersion: z.string().trim().min(1),
  resources: z.array(
    z.object({
      name: z.string().trim().min(1),
      verbs: z.array(z.string().trim().min(1)),
    }),
  ),
});

const kubernetesSelfSubjectAccessReviewSchema = z.object({
  status: z.object({
    allowed: z.boolean(),
  }),
});

const kubernetesIngressClassSchema = z.object({
  metadata: z.object({ name: z.string().trim().min(1) }),
  spec: z.object({ controller: z.string().trim().min(1) }),
});

const kubernetesGatewaySchema = z.object({
  metadata: z.object({
    name: z.string().trim().min(1),
    namespace: z.string().trim().min(1),
  }),
});

const kubernetesStorageClassSchema = z.object({
  metadata: z.object({ name: z.string().trim().min(1) }),
  provisioner: z.string().trim().min(1),
});

const kubernetesVolumeSnapshotClassSchema = z.object({
  metadata: z.object({ name: z.string().trim().min(1) }),
  driver: z.string().trim().min(1),
});

type KubernetesResourceRequirement = {
  groupVersion: string;
  resource: string;
  verbs: readonly string[];
  namespaced: boolean;
  capabilities: readonly EnvironmentProviderCapability[];
};

const KUBERNETES_BYOC_BASE_RESOURCE_REQUIREMENTS = [
  {
    groupVersion: "v1",
    resource: "namespaces",
    verbs: ["get", "list", "create", "delete"],
    namespaced: false,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "services",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: [
      "public_gateway",
      "private_workspace_routing",
      "resource_inventory",
    ],
  },
  {
    groupVersion: "v1",
    resource: "secrets",
    verbs: ["get", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["public_gateway", "workspace_compute"],
  },
  {
    groupVersion: "v1",
    resource: "serviceaccounts",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "resourcequotas",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "limitranges",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "persistentvolumeclaims",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["persistent_workspace_storage", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "pods",
    verbs: ["get", "list"],
    namespaced: true,
    capabilities: ["health_readiness", "resource_inventory"],
  },
  {
    groupVersion: "v1",
    resource: "nodes",
    verbs: ["get", "list"],
    namespaced: false,
    capabilities: ["regional_placement"],
  },
  {
    groupVersion: "apps/v1",
    resource: "deployments",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: [
      "public_gateway",
      "workspace_compute",
      "workspace_start_stop",
      "immutable_image_updates",
      "health_readiness",
      "resource_inventory",
    ],
  },
  {
    groupVersion: "rbac.authorization.k8s.io/v1",
    resource: "roles",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "rbac.authorization.k8s.io/v1",
    resource: "rolebindings",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["environment_scope", "resource_inventory"],
  },
  {
    groupVersion: "networking.k8s.io/v1",
    resource: "networkpolicies",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["private_workspace_routing", "resource_inventory"],
  },
  {
    groupVersion: "storage.k8s.io/v1",
    resource: "storageclasses",
    verbs: ["get", "list"],
    namespaced: false,
    capabilities: ["persistent_workspace_storage", "resource_inventory"],
  },
  {
    groupVersion: "snapshot.storage.k8s.io/v1",
    resource: "volumesnapshots",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["volume_snapshots", "resource_inventory"],
  },
  {
    groupVersion: "snapshot.storage.k8s.io/v1",
    resource: "volumesnapshotclasses",
    verbs: ["get", "list"],
    namespaced: false,
    capabilities: ["volume_snapshots"],
  },
] as const satisfies readonly KubernetesResourceRequirement[];

const KUBERNETES_BYOC_INGRESS_REQUIREMENTS = [
  {
    groupVersion: "networking.k8s.io/v1",
    resource: "ingresses",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["public_gateway", "resource_inventory"],
  },
  {
    groupVersion: "networking.k8s.io/v1",
    resource: "ingressclasses",
    verbs: ["get", "list"],
    namespaced: false,
    capabilities: ["public_gateway", "resource_inventory"],
  },
] as const satisfies readonly KubernetesResourceRequirement[];

const KUBERNETES_BYOC_GATEWAY_REQUIREMENTS = [
  {
    groupVersion: "gateway.networking.k8s.io/v1",
    resource: "gateways",
    verbs: ["get", "list"],
    namespaced: true,
    capabilities: ["public_gateway", "resource_inventory"],
  },
  {
    groupVersion: "gateway.networking.k8s.io/v1",
    resource: "httproutes",
    verbs: ["get", "list", "create", "patch", "delete"],
    namespaced: true,
    capabilities: ["public_gateway", "resource_inventory"],
  },
] as const satisfies readonly KubernetesResourceRequirement[];

export const KUBERNETES_BYOC_RESOURCE_REQUIREMENTS = [
  ...KUBERNETES_BYOC_BASE_RESOURCE_REQUIREMENTS,
  ...KUBERNETES_BYOC_INGRESS_REQUIREMENTS,
  ...KUBERNETES_BYOC_GATEWAY_REQUIREMENTS,
] as const;

const KUBERNETES_DISCOVERY_PATHS = [
  { groupVersion: "v1", path: "/api/v1" },
  { groupVersion: "apps/v1", path: "/apis/apps/v1" },
  {
    groupVersion: "networking.k8s.io/v1",
    path: "/apis/networking.k8s.io/v1",
  },
  {
    groupVersion: "storage.k8s.io/v1",
    path: "/apis/storage.k8s.io/v1",
  },
  {
    groupVersion: "rbac.authorization.k8s.io/v1",
    path: "/apis/rbac.authorization.k8s.io/v1",
  },
  {
    groupVersion: "snapshot.storage.k8s.io/v1",
    path: "/apis/snapshot.storage.k8s.io/v1",
  },
  {
    groupVersion: "gateway.networking.k8s.io/v1",
    path: "/apis/gateway.networking.k8s.io/v1",
  },
] as const;

export type KubernetesByocMissingRequirement = {
  groupVersion: string;
  resource: string;
  missingVerbs: string[];
  deniedVerbs: string[];
  capabilities: EnvironmentProviderCapability[];
};

export type KubernetesByocMissingPrerequisite = {
  capability: EnvironmentProviderCapability;
  kind:
    | "Gateway"
    | "IngressClass"
    | "StorageClass"
    | "VolumeSnapshotClass"
    | "EncryptionAttestation";
  name: string;
  reason: "not_found" | "driver_mismatch" | "attestation_required";
};

export type KubernetesByocCompatibility = {
  version: string;
  profile: KubernetesByocProfileV1;
  support: KubernetesByocSupportState;
  descriptor: EnvironmentProviderDescriptor;
  missingRequirements: KubernetesByocMissingRequirement[];
  missingPrerequisites: KubernetesByocMissingPrerequisite[];
};

export class KubernetesByocProviderError extends Error {
  readonly code:
    | "KUBERNETES_PROVIDER_NOT_CONFIGURED"
    | "KUBERNETES_PROVIDER_UNAVAILABLE"
    | "KUBERNETES_PROVIDER_REJECTED"
    | "KUBERNETES_RESPONSE_INVALID";
  readonly status?: number | undefined;
  readonly phase?: string | undefined;

  constructor(
    code: KubernetesByocProviderError["code"],
    message: string,
    evidence?: { status?: number | undefined; phase?: string | undefined },
  ) {
    super(message);
    this.name = "KubernetesByocProviderError";
    this.code = code;
    this.status = evidence?.status;
    this.phase = evidence?.phase;
  }
}

export class KubernetesByocDiscoveryClient {
  private readonly serverUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly namespace: string;
  private readonly profile: KubernetesByocProfileV1;

  constructor(input: {
    profile: KubernetesByocProfileV1;
    namespace: string;
    testAuthority: {
      serverUrl: string;
      bearerToken: string;
      fetchImpl: typeof fetch;
    };
  }) {
    this.profile = parseKubernetesByocProfileV1(input.profile);
    this.serverUrl = requireKubernetesServerUrl(
      input.testAuthority.serverUrl,
    );
    this.bearerToken = requireConfigured(
      input.testAuthority.bearerToken,
      "Test-only Kubernetes bearer token",
    );
    this.namespace = requireConfigured(input.namespace, "Kubernetes namespace");
    this.fetchImpl = input.testAuthority.fetchImpl;
  }

  async inspectCompatibility(): Promise<KubernetesByocCompatibility> {
    const resourceRequirements =
      kubernetesByocResourceRequirementsForProfile(this.profile);
    const discoveryPaths = discoveryPathsFor(this.profile);
    const [versionResponse, ...discoveryResponses] = await Promise.all([
      this.request("kubernetes.version", "/version"),
      ...discoveryPaths.map(({ path, groupVersion }) =>
        this.request(`kubernetes.discovery.${groupVersion}`, path, {
          allowNotFound: true,
        }),
      ),
    ]);
    const version = parseKubernetesResponse(
      kubernetesVersionSchema,
      versionResponse,
      "Kubernetes version response",
    ).gitVersion;
    const discovered = new Map<string, Map<string, ReadonlySet<string>>>();
    for (const [index, response] of discoveryResponses.entries()) {
      if (response === null) continue;
      const expected = discoveryPaths[index]?.groupVersion;
      const list = parseKubernetesResponse(
        kubernetesApiResourceListSchema,
        response,
        `${expected ?? "unknown"} discovery response`,
      );
      if (list.groupVersion !== expected) {
        throw new KubernetesByocProviderError(
          "KUBERNETES_RESPONSE_INVALID",
          `Kubernetes discovery returned '${list.groupVersion}' for '${expected ?? "unknown"}'.`,
        );
      }
      discovered.set(
        list.groupVersion,
        new Map(
          list.resources.map((resource) => [
            resource.name,
            new Set(resource.verbs),
          ]),
        ),
      );
    }
    const authorizationResults = await Promise.all(
      resourceRequirements.flatMap((requirement) =>
        requirement.verbs.map(async (verb) => {
          const supported =
            discovered
              .get(requirement.groupVersion)
              ?.get(requirement.resource)
              ?.has(verb) ?? false;
          return {
            requirement,
            verb,
            allowed:
              supported && (await this.isAuthorized({ requirement, verb })),
          };
        }),
      ),
    );
    const allowedOperations = new Set(
      authorizationResults
        .filter((result) => result.allowed)
        .map((result) =>
          operationKey(
            result.requirement.groupVersion,
            result.requirement.resource,
            result.verb,
          ),
        ),
    );
    const missingRequirements = resourceRequirements.flatMap(
      (requirement): KubernetesByocMissingRequirement[] => {
        const verbs = discovered
          .get(requirement.groupVersion)
          ?.get(requirement.resource);
        const missingVerbs = requirement.verbs.filter(
          (verb) => !verbs?.has(verb),
        );
        const deniedVerbs = requirement.verbs.filter(
          (verb) =>
            verbs?.has(verb) &&
            !allowedOperations.has(
              operationKey(
                requirement.groupVersion,
                requirement.resource,
                verb,
              ),
            ),
        );
        return missingVerbs.length === 0 && deniedVerbs.length === 0
          ? []
          : [
              {
                groupVersion: requirement.groupVersion,
                resource: requirement.resource,
                missingVerbs,
                deniedVerbs,
                capabilities: [...requirement.capabilities],
              },
            ];
      },
    );
    const missingPrerequisites = await this.inspectConfiguredPrerequisites(
      missingRequirements,
    );
    const incompleteCapabilities = new Set([
      ...missingRequirements.flatMap((requirement) => requirement.capabilities),
      ...missingPrerequisites.map((requirement) => requirement.capability),
    ]);
    const descriptor = {
      id: "kubernetes",
      label: "Kubernetes BYOC",
      capabilities: REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES.filter(
        (capability) => !incompleteCapabilities.has(capability),
      ),
      evidence: "cluster_preflight",
    } as const;
    return {
      version,
      profile: this.profile,
      support: resolveKubernetesByocSupportState({
        profile: this.profile,
        compatible:
          descriptor.capabilities.length ===
          REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES.length,
      }),
      descriptor,
      missingRequirements,
      missingPrerequisites,
    };
  }

  async assertCompatible() {
    const compatibility = await this.inspectCompatibility();
    assertEnvironmentProviderCompatibility(compatibility.descriptor);
    if (compatibility.support.state === "unsupported") {
      throw new KubernetesByocProviderError(
        "KUBERNETES_PROVIDER_NOT_CONFIGURED",
        `Kubernetes BYOC profile is unsupported: ${compatibility.support.reason}.`,
      );
    }
    return compatibility;
  }

  private async isAuthorized(input: {
    requirement: KubernetesResourceRequirement;
    verb: string;
  }) {
    const response = await this.request(
      `kubernetes.authorization.${input.requirement.groupVersion}.${input.requirement.resource}.${input.verb}`,
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      {
        method: "POST",
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              group: apiGroup(input.requirement.groupVersion),
              version: apiVersion(input.requirement.groupVersion),
              resource: input.requirement.resource,
              verb: input.verb,
              ...(input.requirement.namespaced
                ? { namespace: this.namespace }
                : {}),
            },
          },
        },
      },
    );
    return parseKubernetesResponse(
      kubernetesSelfSubjectAccessReviewSchema,
      response,
      "Kubernetes SelfSubjectAccessReview response",
    ).status.allowed;
  }

  private async inspectConfiguredPrerequisites(
    missingRequirements: KubernetesByocMissingRequirement[],
  ): Promise<KubernetesByocMissingPrerequisite[]> {
    const requirementAvailable = (groupVersion: string, resource: string) =>
      !missingRequirements.some(
        (requirement) =>
          requirement.groupVersion === groupVersion &&
          requirement.resource === resource,
      );
    const [edgeResponse, storageClassResponse, snapshotClassResponse] =
      await Promise.all([
        this.profile.edge.mode === "ingress" &&
        requirementAvailable("networking.k8s.io/v1", "ingressclasses")
          ? this.request(
              "kubernetes.prerequisite.ingress-class",
              `/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(this.profile.edge.ingressClassName)}`,
              { allowNotFound: true },
            )
          : this.profile.edge.mode === "gateway_api" &&
              requirementAvailable(
                "gateway.networking.k8s.io/v1",
                "gateways",
              )
            ? this.request(
                "kubernetes.prerequisite.gateway",
                `/apis/gateway.networking.k8s.io/v1/namespaces/${encodeURIComponent(this.profile.edge.parentNamespace)}/gateways/${encodeURIComponent(this.profile.edge.parentName)}`,
                { allowNotFound: true },
              )
            : undefined,
        requirementAvailable("storage.k8s.io/v1", "storageclasses")
          ? this.request(
              "kubernetes.prerequisite.storage-class",
              `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(this.profile.storageClassName)}`,
              { allowNotFound: true },
            )
          : undefined,
        requirementAvailable(
          "snapshot.storage.k8s.io/v1",
          "volumesnapshotclasses",
        )
          ? this.request(
              "kubernetes.prerequisite.volume-snapshot-class",
              `/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses/${encodeURIComponent(this.profile.volumeSnapshotClassName)}`,
              { allowNotFound: true },
            )
          : undefined,
      ]);
    const missing: KubernetesByocMissingPrerequisite[] = [];
    if (this.profile.edge.mode === "ingress") {
      parseConfiguredClass(
        kubernetesIngressClassSchema,
        edgeResponse,
        "IngressClass",
        this.profile.edge.ingressClassName,
        "public_gateway",
        missing,
      );
    } else {
      parseConfiguredGateway(
        edgeResponse,
        this.profile.edge.parentNamespace,
        this.profile.edge.parentName,
        missing,
      );
    }
    const storageClass = parseConfiguredClass(
      kubernetesStorageClassSchema,
      storageClassResponse,
      "StorageClass",
      this.profile.storageClassName,
      "persistent_workspace_storage",
      missing,
    );
    const snapshotClass = parseConfiguredClass(
      kubernetesVolumeSnapshotClassSchema,
      snapshotClassResponse,
      "VolumeSnapshotClass",
      this.profile.volumeSnapshotClassName,
      "volume_snapshots",
      missing,
    );
    if (
      storageClass &&
      snapshotClass &&
      storageClass.provisioner !== snapshotClass.driver
    ) {
      missing.push({
        capability: "volume_snapshots",
        kind: "VolumeSnapshotClass",
        name: this.profile.volumeSnapshotClassName,
        reason: "driver_mismatch",
      });
    }
    if (!profileHasRequiredEncryptionAttestations(this.profile)) {
      missing.push({
        capability: "persistent_workspace_storage",
        kind: "EncryptionAttestation",
        name: "persistent-volumes-and-kubernetes-secrets",
        reason: "attestation_required",
      });
    }
    return missing;
  }

  private async request(
    phase: string,
    path: string,
    options: {
      allowNotFound?: boolean;
      method?: "GET" | "POST";
      body?: unknown;
    } = {},
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(kubernetesApiUrl(this.serverUrl, path), {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.bearerToken}`,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        cache: "no-store",
      });
    } catch {
      throw new KubernetesByocProviderError(
        "KUBERNETES_PROVIDER_UNAVAILABLE",
        "Kubernetes API request failed.",
        { phase },
      );
    }
    if (response.status === 404 && options.allowNotFound) return null;
    if (!response.ok) {
      throw new KubernetesByocProviderError(
        "KUBERNETES_PROVIDER_REJECTED",
        `Kubernetes API rejected ${phase} (${response.status}).`,
        { phase, status: response.status },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new KubernetesByocProviderError(
        "KUBERNETES_RESPONSE_INVALID",
        `Kubernetes API returned invalid JSON for ${phase}.`,
        { phase, status: response.status },
      );
    }
  }
}

export function kubernetesByocResourceRequirementsForProfile(
  profile: KubernetesByocProfileV1,
): readonly KubernetesResourceRequirement[] {
  return profile.edge.mode === "gateway_api"
    ? [
        ...KUBERNETES_BYOC_BASE_RESOURCE_REQUIREMENTS,
        ...KUBERNETES_BYOC_GATEWAY_REQUIREMENTS,
      ]
    : [
        ...KUBERNETES_BYOC_BASE_RESOURCE_REQUIREMENTS,
        ...KUBERNETES_BYOC_INGRESS_REQUIREMENTS,
      ];
}

function discoveryPathsFor(profile: KubernetesByocProfileV1) {
  const requiredGroups = new Set(
    kubernetesByocResourceRequirementsForProfile(profile).map(
      (requirement) => requirement.groupVersion,
    ),
  );
  return KUBERNETES_DISCOVERY_PATHS.filter(({ groupVersion }) =>
    requiredGroups.has(groupVersion),
  );
}

function requireKubernetesServerUrl(value: string) {
  const configured = requireConfigured(value, "Kubernetes API server URL");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new KubernetesByocProviderError(
      "KUBERNETES_PROVIDER_NOT_CONFIGURED",
      "Kubernetes API server URL is invalid.",
    );
  }
  if (url.protocol !== "https:") {
    throw new KubernetesByocProviderError(
      "KUBERNETES_PROVIDER_NOT_CONFIGURED",
      "Kubernetes API server URL must use HTTPS.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new KubernetesByocProviderError(
      "KUBERNETES_PROVIDER_NOT_CONFIGURED",
      "Kubernetes API server URL cannot contain credentials, query parameters, or a fragment.",
    );
  }
  return url.toString();
}

function parseConfiguredGateway(
  value: unknown | null | undefined,
  expectedNamespace: string,
  expectedName: string,
  missing: KubernetesByocMissingPrerequisite[],
) {
  if (value === undefined) return null;
  if (value === null) {
    missing.push({
      capability: "public_gateway",
      kind: "Gateway",
      name: `${expectedNamespace}/${expectedName}`,
      reason: "not_found",
    });
    return null;
  }
  const parsed = parseKubernetesResponse(
    kubernetesGatewaySchema,
    value,
    "Kubernetes Gateway response",
  );
  if (
    parsed.metadata.namespace !== expectedNamespace ||
    parsed.metadata.name !== expectedName
  ) {
    throw new KubernetesByocProviderError(
      "KUBERNETES_RESPONSE_INVALID",
      `Kubernetes returned Gateway '${parsed.metadata.namespace}/${parsed.metadata.name}' for '${expectedNamespace}/${expectedName}'.`,
    );
  }
  return parsed;
}

function kubernetesApiUrl(serverUrl: string, path: string) {
  const url = new URL(serverUrl);
  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix}/${path.replace(/^\/+/, "")}`;
  return url;
}

function apiGroup(groupVersion: string) {
  const separator = groupVersion.lastIndexOf("/");
  return separator === -1 ? "" : groupVersion.slice(0, separator);
}

function apiVersion(groupVersion: string) {
  const separator = groupVersion.lastIndexOf("/");
  return separator === -1 ? groupVersion : groupVersion.slice(separator + 1);
}

function operationKey(groupVersion: string, resource: string, verb: string) {
  return `${groupVersion}\u0000${resource}\u0000${verb}`;
}

function parseConfiguredClass<T extends { metadata: { name: string } }>(
  schema: z.ZodType<T>,
  value: unknown | null | undefined,
  kind: KubernetesByocMissingPrerequisite["kind"],
  expectedName: string,
  capability: EnvironmentProviderCapability,
  missing: KubernetesByocMissingPrerequisite[],
) {
  if (value === undefined) return null;
  if (value === null) {
    missing.push({
      capability,
      kind,
      name: expectedName,
      reason: "not_found",
    });
    return null;
  }
  const parsed = parseKubernetesResponse(
    schema,
    value,
    `Kubernetes ${kind} response`,
  );
  if (parsed.metadata.name !== expectedName) {
    throw new KubernetesByocProviderError(
      "KUBERNETES_RESPONSE_INVALID",
      `Kubernetes returned ${kind} '${parsed.metadata.name}' for '${expectedName}'.`,
    );
  }
  return parsed;
}

function requireConfigured(value: string, label: string) {
  const configured = value.trim();
  if (!configured) {
    throw new KubernetesByocProviderError(
      "KUBERNETES_PROVIDER_NOT_CONFIGURED",
      `${label} is required.`,
    );
  }
  return configured;
}

function parseKubernetesResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new KubernetesByocProviderError(
      "KUBERNETES_RESPONSE_INVALID",
      `${label} does not satisfy the Kubernetes discovery contract.`,
    );
  }
  return parsed.data;
}
