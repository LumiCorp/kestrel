import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  qualificationPayloadSchema,
  qualificationReportSchema,
  type QualificationReport,
} from "./contracts.js";
import type { ActiveIdentity, ControlPlaneClient } from "./control-plane-client.js";
import {
  assertKubernetesName,
  assertOwnedNamespace,
  KubernetesApiError,
  KubernetesClient,
} from "./kubernetes-client.js";
import { discoverDeletableNamespacedResources } from "./kubernetes-discovery.js";

const name = z.string().trim().min(1).max(253).regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u);
export const connectorKubernetesProfileSchema = z
  .object({
    contract: z.literal("kubernetes-byoc-profile-v1"),
    selectedCertificationProfile: z.enum(["gke-gateway-v1", "eks-ingress-v1"]).nullable(),
    namespacePrefix: name,
    baseDomain: name,
    storageClassName: name,
    volumeSnapshotClassName: name,
    controllerNamespace: name,
    controllerPodSelector: z.record(z.string(), z.string()),
    pullSecretRef: name.nullable(),
    encryptionAttestations: z.record(z.string(), z.unknown()),
    edge: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("gateway_api"), parentNamespace: name, parentName: name, sectionName: name.optional() }).strict(),
      z.object({ mode: z.literal("ingress"), ingressClassName: name }).strict(),
    ]),
    platform: z
      .object({
        distribution: z.enum(["gke", "eks", "other"]),
        computeProfile: z.string().min(1),
        networkPolicyProvider: z.string().min(1),
        storageCsiDriver: z.string().min(1),
        snapshotCsiDriver: z.string().min(1),
        edgeController: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ConnectorKubernetesProfile = z.infer<
  typeof connectorKubernetesProfileSchema
>;
type Profile = ConnectorKubernetesProfile;
type Check = QualificationReport["checks"][number];

const CHECK_IDS: Check["id"][] = [
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
];

const WORKSPACE_PVC_ACCESS_MODE = "ReadWriteOnce" as const;

type Requirement = readonly [string, string, readonly string[]];

const REQUIREMENTS: readonly Requirement[] = [
  ["v1", "namespaces", ["get", "list", "create", "patch", "delete"]],
  ["v1", "services", ["get", "list", "create", "patch", "delete"]],
  ["v1", "secrets", ["get", "list", "create", "patch", "delete"]],
  ["v1", "serviceaccounts", ["get", "list", "create", "patch", "delete"]],
  ["v1", "resourcequotas", ["get", "list", "create", "patch", "delete"]],
  ["v1", "limitranges", ["get", "list", "create", "patch", "delete"]],
  ["v1", "persistentvolumeclaims", ["get", "list", "create", "patch", "delete"]],
  ["v1", "pods", ["get", "list"]],
  ["v1", "nodes", ["get", "list"]],
  ["apps/v1", "deployments", ["get", "list", "create", "patch", "delete"]],
  ["rbac.authorization.k8s.io/v1", "roles", ["get", "list", "create", "patch", "delete"]],
  ["rbac.authorization.k8s.io/v1", "rolebindings", ["get", "list", "create", "patch", "delete"]],
  ["networking.k8s.io/v1", "networkpolicies", ["get", "list", "create", "patch", "delete"]],
  ["storage.k8s.io/v1", "storageclasses", ["get", "list"]],
  ["snapshot.storage.k8s.io/v1", "volumesnapshots", ["get", "list", "create", "patch", "delete"]],
  ["snapshot.storage.k8s.io/v1", "volumesnapshotclasses", ["get", "list"]],
];

export async function runQualification(input: {
  commandPayload: unknown;
  connectionId: string;
  kubernetes: KubernetesClient;
  controlPlane: ControlPlaneClient;
  identity: ActiveIdentity;
  connectorNamespace: string;
  signal?: AbortSignal;
  onProgress?: (state: string, message: string) => Promise<void>;
}): Promise<QualificationReport> {
  const payload = qualificationPayloadSchema.parse(input.commandPayload);
  const profile = connectorKubernetesProfileSchema.parse(payload.profile);
  const shortId = payload.runId.replace(/-/gu, "").slice(0, 10);
  const namespace = assertOwnedNamespace(
    `kestrel-qualification-${shortId}`,
    "kestrel-qualification",
  );
  const peerNamespace = assertOwnedNamespace(`${namespace}-peer`, "kestrel-qualification");
  const startedAt = new Date();
  const checks = new Map<Check["id"], Check>();
  let observedVersion = "unknown";
  let observedDistribution: Profile["platform"]["distribution"] = "other";
  let cleanupResiduals: string[] = [];
  let blocked = false;

  const record = (
    id: Check["id"],
    status: Check["status"],
    detail: string,
    evidenceClass: Check["evidenceClass"],
    evidence: Partial<Pick<Check, "observedVersion" | "auditId">> = {},
  ) => {
    checks.set(id, { id, status, detail, evidenceClass, ...evidence });
    if (status === "failed" || status === "blocked") blocked = true;
  };

  const execute = async (
    id: Check["id"],
    evidenceClass: Check["evidenceClass"],
    operation: () => Promise<string>,
  ) => {
    if (blocked) {
      record(id, "not_run", "Skipped because an earlier qualification check did not pass.", evidenceClass);
      return;
    }
    await input.onProgress?.(id, `Running ${id}.`);
    try {
      record(id, "passed", await operation(), evidenceClass);
    } catch (error) {
      record(
        id,
        error instanceof KubernetesApiError && [401, 403, 404].includes(error.status)
          ? "blocked"
          : "failed",
        safeFailure(error),
        evidenceClass,
        error instanceof KubernetesApiError && error.auditId
          ? { auditId: error.auditId }
          : {},
      );
    }
  };

  await execute("discovery.version", "cluster_preflight", async () => {
    const version = await input.kubernetes.get("/version") as { gitVersion?: unknown };
    if (typeof version.gitVersion !== "string" || !version.gitVersion) {
      throw new Error("Kubernetes version response is invalid.");
    }
    observedVersion = version.gitVersion;
    observedDistribution = distributionFromVersion(version.gitVersion);
    return `Observed Kubernetes ${version.gitVersion}.`;
  });
  await execute("discovery.resources", "cluster_preflight", async () => {
    await inspectDiscovery(input.kubernetes, profile);
    return "Required Kubernetes API resources and advertised verbs are present.";
  });
  await execute("authorization.exact_verbs", "cluster_preflight", async () => {
    await inspectBootstrapAuthorization(input.kubernetes, profile, namespace);
    return "Bootstrap, prerequisite-read, namespace, binding, and self-review verbs are explicitly authorized; namespaced manager verbs are verified after the disposable binding is created.";
  });
  await execute("prerequisite.storage_class", "cluster_preflight", async () => {
    const storage = await input.kubernetes.get(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(profile.storageClassName)}`) as { provisioner?: unknown };
    if (storage.provisioner !== profile.platform.storageCsiDriver) {
      throw new Error("Configured StorageClass CSI driver does not match the profile.");
    }
    return `StorageClass ${profile.storageClassName} uses ${String(storage.provisioner)}.`;
  });
  await execute("prerequisite.snapshot_class", "cluster_preflight", async () => {
    const snapshot = await input.kubernetes.get(`/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses/${encodeURIComponent(profile.volumeSnapshotClassName)}`) as { driver?: unknown };
    if (snapshot.driver !== profile.platform.snapshotCsiDriver) {
      throw new Error("Configured VolumeSnapshotClass driver does not match the profile.");
    }
    return `VolumeSnapshotClass ${profile.volumeSnapshotClassName} uses ${String(snapshot.driver)}.`;
  });
  await execute("prerequisite.edge", "cluster_preflight", async () => {
    if (profile.edge.mode === "gateway_api") {
      await input.kubernetes.get(`/apis/gateway.networking.k8s.io/v1/namespaces/${encodeURIComponent(profile.edge.parentNamespace)}/gateways/${encodeURIComponent(profile.edge.parentName)}`);
      await inspectControllerPods(input.kubernetes, profile);
      return `Gateway ${profile.edge.parentNamespace}/${profile.edge.parentName} and the declared controller Pods are present.`;
    }
    await input.kubernetes.get(`/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(profile.edge.ingressClassName)}`);
    await inspectControllerPods(input.kubernetes, profile);
    return `IngressClass ${profile.edge.ingressClassName} and the declared controller Pods are present.`;
  });

  const nonce = randomBytes(24).toString("hex");
  const hostname = `${shortId}.${profile.baseDomain}`;
  await execute("active.baseline", "isolated_provider", async () => {
    await applyBaseline(
      input.kubernetes,
      namespace,
      payload.runId,
      profile,
      input.connectorNamespace,
    );
    await inspectAuthorization(input.kubernetes, profile, namespace);
    return `Applied Restricted namespace labels, quota, limits, ServiceAccounts, and baseline NetworkPolicies in ${namespace}.`;
  });
  await execute("active.image_pull_and_schedule", "isolated_provider", async () => {
    await applyProbe(input.kubernetes, { namespace, image: payload.probeImage, nonce, storageClassName: profile.storageClassName, pullSecretRef: profile.pullSecretRef, readOnlyNonce: false });
    await waitDeploymentReady(input.kubernetes, namespace, "probe", input.signal);
    return `Digest-pinned probe ${payload.probeImage} scheduled and became ready.`;
  });
  await execute("active.pvc_persistence", "isolated_provider", async () => {
    const observedAccessMode = await observeWorkspacePvcAccessMode(
      input.kubernetes,
      namespace,
      "probe",
    );
    const probeDeploymentPath = `/apis/apps/v1/namespaces/${namespace}/deployments/probe`;
    await input.kubernetes.delete(probeDeploymentPath);
    await input.kubernetes.waitFor(
      probeDeploymentPath,
      (value) => value === null,
      { timeoutMs: 120_000, signal: input.signal },
    );
    await waitForNoPods(
      input.kubernetes,
      namespace,
      "probe",
      input.signal,
    );
    await applyProbe(input.kubernetes, { namespace, image: payload.probeImage, nonce, storageClassName: profile.storageClassName, pullSecretRef: profile.pullSecretRef, readOnlyNonce: true });
    await waitDeploymentReady(input.kubernetes, namespace, "probe", input.signal);
    return `${observedAccessMode} PVC nonce remained readable after the probe Pod was replaced.`;
  });
  await execute("active.snapshot_restore", "isolated_provider", async () => {
    await applySnapshotRestore(input.kubernetes, { namespace, image: payload.probeImage, nonce, snapshotClassName: profile.volumeSnapshotClassName, pullSecretRef: profile.pullSecretRef, signal: input.signal });
    await waitDeploymentReady(input.kubernetes, namespace, "restore-probe", input.signal);
    const observedAccessMode = await observeWorkspacePvcAccessMode(
      input.kubernetes,
      namespace,
      "restore-probe",
    );
    return `VolumeSnapshot became ready, restored ${observedAccessMode} PVC bound, and restored probe read the persisted nonce.`;
  });
  await execute("active.edge_route", "isolated_provider", async () => {
    await applyEdge(input.kubernetes, { namespace, hostname, profile });
    return `Applied ${profile.edge.mode} route for ${hostname}.`;
  });
  await execute("active.public_dns_tls", "isolated_provider", async () => {
    const proof = await input.controlPlane.provePublicEndpoint({
      identity: input.identity,
      runId: payload.runId,
      url: `https://${hostname}/health?nonce=${nonce}`,
      nonce,
    }) as { passed?: unknown };
    if (proof.passed !== true) throw new Error("Kestrel could not verify public DNS, TLS, and signed health.");
    return `Kestrel verified public DNS, TLS, and signed health for ${hostname}.`;
  });
  await execute("active.allowed_network_paths", "isolated_provider", async () => {
    await runNetworkProbe(input.kubernetes, { namespace, image: payload.probeImage, name: "allowed-probe", target: "http://probe:8080/health", expect: "success", signal: input.signal });
    return "The explicitly permitted in-namespace probe path succeeded.";
  });
  await execute("active.denied_network_paths", "isolated_provider", async () => {
    await runNetworkProbe(input.kubernetes, { namespace, image: payload.probeImage, name: "denied-probe", target: "http://probe:8080/health", expect: "failure", labels: { "kestrel.lumi.dev/network-role": "denied" }, signal: input.signal });
    await runCrossNamespaceDeniedProbe(input.kubernetes, {
      namespace: peerNamespace,
      targetNamespace: namespace,
      connectorNamespace: input.connectorNamespace,
      runId: payload.runId,
      image: payload.probeImage,
      signal: input.signal,
    });
    return "Both the direct untrusted identity and a Pod in a separate namespace were denied.";
  });
  await execute("active.quota_rejection", "isolated_provider", async () => {
    await applyQuotaProbe(input.kubernetes, namespace, payload.probeImage);
    const deployment = await input.kubernetes.waitFor(
      `/apis/apps/v1/namespaces/${namespace}/deployments/quota-probe`,
      (value) => deploymentHasReplicaFailure(value),
      { timeoutMs: 60_000, signal: input.signal },
    );
    if (!deploymentHasReplicaFailure(deployment)) throw new Error("Quota overflow was not rejected.");
    return "A disposable workload beyond quota was rejected by Kubernetes.";
  });

  try {
    const cleanupFailures: string[] = [];
    for (const ownedNamespace of [namespace, peerNamespace]) {
      try {
        await input.kubernetes.delete(`/api/v1/namespaces/${ownedNamespace}`, { allowNotFound: true });
        await input.kubernetes.waitFor(
          `/api/v1/namespaces/${ownedNamespace}`,
          (value) => value === null,
          { timeoutMs: 120_000, signal: input.signal },
        );
      } catch (error) {
        cleanupFailures.push(`${ownedNamespace}: ${safeFailure(error)}`);
      }
    }
    if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("; "));
    record("cleanup.namespace_removed", "passed", `Qualification namespace ${namespace} was removed.`, "isolated_provider");
  } catch (error) {
    cleanupResiduals = [
      ...await residualInventory(input.kubernetes, namespace),
      ...await residualInventory(input.kubernetes, peerNamespace),
    ];
    record("cleanup.namespace_removed", "failed", safeFailure(error), "isolated_provider");
  }

  for (const id of CHECK_IDS) {
    if (!checks.has(id)) record(id, "not_run", "Qualification step did not run.", id.startsWith("active.") || id.startsWith("cleanup.") ? "isolated_provider" : "cluster_preflight");
  }
  const completedAt = new Date();
  return qualificationReportSchema.parse({
    contract: "kubernetes-qualification-report-v1",
    runId: payload.runId,
    connectionId: input.connectionId,
    configurationRevision: payload.configurationRevision,
    clusterFingerprint: createHash("sha256")
      .update(`${observedVersion}\n${observedDistribution}\n${profile.platform.storageCsiDriver}\n${profile.edge.mode}`)
      .digest("hex"),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    expiresAt: payload.expiresAt,
    evidenceClass: "isolated_provider",
    observed: {
      kubernetesVersion: observedVersion,
      distribution: observedDistribution,
      storageDriver: profile.platform.storageCsiDriver,
      snapshotDriver: profile.platform.snapshotCsiDriver,
      edgeController: profile.platform.edgeController,
      edgeMode: profile.edge.mode,
    },
    checks: CHECK_IDS.map((id) => checks.get(id)),
    cleanup: {
      status: checks.get("cleanup.namespace_removed")?.status === "passed" ? "passed" : "failed",
      namespace,
      residualResources: cleanupResiduals,
    },
  });
}

async function inspectDiscovery(kubernetes: KubernetesClient, profile: Profile) {
  const requirements: Requirement[] = [
    ...REQUIREMENTS,
    profile.edge.mode === "gateway_api"
      ? ["gateway.networking.k8s.io/v1", "httproutes", ["get", "list", "create", "patch", "delete"]]
      : ["networking.k8s.io/v1", "ingresses", ["get", "list", "create", "patch", "delete"]],
  ];
  const groups = new Set(requirements.map(([group]) => group));
  for (const group of groups) {
    const path = group === "v1" ? "/api/v1" : `/apis/${group}`;
    const response = await kubernetes.get(path) as { resources?: Array<{ name?: unknown; verbs?: unknown }> };
    if (!Array.isArray(response.resources)) throw new Error(`Kubernetes discovery for ${group} is invalid.`);
    for (const [requiredGroup, resource, verbs] of requirements.filter(([requiredGroup]) => requiredGroup === group)) {
      const advertised = response.resources.find((item) => item.name === resource);
      if (!advertised || !Array.isArray(advertised.verbs)) {
        throw new Error(`Kubernetes discovery is missing ${requiredGroup}/${resource}.`);
      }
      for (const verb of verbs) {
        if (!advertised.verbs.includes(verb)) {
          throw new Error(`Kubernetes discovery for ${requiredGroup}/${resource} is missing ${verb}.`);
        }
      }
    }
  }
}

async function inspectControllerPods(kubernetes: KubernetesClient, profile: Profile) {
  const selector = Object.entries(profile.controllerPodSelector)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const pods = await kubernetes.get(
    `/api/v1/namespaces/${encodeURIComponent(profile.controllerNamespace)}/pods?labelSelector=${encodeURIComponent(selector)}`,
  ) as { items?: unknown[] };
  if (!Array.isArray(pods.items) || pods.items.length === 0) {
    throw new Error("No edge-controller Pod matches the configured namespace and selector.");
  }
}

function distributionFromVersion(version: string): Profile["platform"]["distribution"] {
  if (/-gke[.-]/u.test(version)) return "gke";
  if (/-eks[.-]/u.test(version)) return "eks";
  return "other";
}

async function inspectAuthorization(kubernetes: KubernetesClient, profile: Profile, namespace: string) {
  const requirements: Requirement[] = [...REQUIREMENTS];
  requirements.push(
    profile.edge.mode === "gateway_api"
      ? ["gateway.networking.k8s.io/v1", "httproutes", ["get", "list", "create", "patch", "delete"]] as const
      : ["networking.k8s.io/v1", "ingresses", ["get", "list", "create", "patch", "delete"]] as const,
  );
  for (const [groupVersion, resource, verbs] of requirements) {
    for (const verb of verbs) {
      const review = await kubernetes.create(
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              group: groupVersion === "v1" ? "" : groupVersion.split("/")[0],
              version: groupVersion === "v1" ? "v1" : groupVersion.split("/")[1],
              resource,
              verb,
              ...(["namespaces", "nodes", "storageclasses", "volumesnapshotclasses"].includes(resource) ? {} : { namespace }),
            },
          },
        },
      ) as { status?: { allowed?: unknown } };
      if (review.status?.allowed !== true) throw new Error(`${verb} ${groupVersion}/${resource} is not authorized.`);
    }
  }
  for (const resource of await discoverDeletableNamespacedResources(kubernetes)) {
    const review = await kubernetes.create(
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
          resourceAttributes: {
            group: resource.group,
            version: resource.version,
            resource: resource.resource,
            verb: "list",
            namespace,
          },
        },
      },
    ) as { status?: { allowed?: unknown } };
    if (review.status?.allowed !== true) {
      throw new Error(
        `list ${resource.groupVersion}/${resource.resource} is not authorized for safe namespace cleanup.`,
      );
    }
  }
}

async function inspectBootstrapAuthorization(
  kubernetes: KubernetesClient,
  profile: Profile,
  namespace: string,
) {
  const requirements: Array<{
    group: string;
    version: string;
    resource: string;
    verb: string;
    namespace?: string;
    name?: string;
  }> = [
    ...["get", "list", "create", "patch", "delete"].map((verb) => ({ group: "", version: "v1", resource: "namespaces", verb })),
    { group: "rbac.authorization.k8s.io", version: "v1", resource: "rolebindings", verb: "create", namespace },
    { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterroles", verb: "get", name: "kestrel-environment-manager" },
    { group: "rbac.authorization.k8s.io", version: "v1", resource: "clusterroles", verb: "bind", name: "kestrel-environment-manager" },
    { group: "authorization.k8s.io", version: "v1", resource: "selfsubjectaccessreviews", verb: "create" },
    { group: "storage.k8s.io", version: "v1", resource: "storageclasses", verb: "get", name: profile.storageClassName },
    { group: "snapshot.storage.k8s.io", version: "v1", resource: "volumesnapshotclasses", verb: "get", name: profile.volumeSnapshotClassName },
    ...(profile.edge.mode === "gateway_api"
      ? [{ group: "gateway.networking.k8s.io", version: "v1", resource: "gateways", verb: "get", namespace: profile.edge.parentNamespace, name: profile.edge.parentName }]
      : [{ group: "networking.k8s.io", version: "v1", resource: "ingressclasses", verb: "get", name: profile.edge.ingressClassName }]),
  ];
  for (const requirement of requirements) {
    const review = await kubernetes.create(
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: { resourceAttributes: requirement },
      },
    ) as { status?: { allowed?: unknown } };
    if (review.status?.allowed !== true) {
      throw new Error(`${requirement.verb} ${requirement.group || "core"}/${requirement.resource} is not authorized.`);
    }
  }
}

async function applyBaseline(
  kubernetes: KubernetesClient,
  namespace: string,
  runId: string,
  profile: Profile,
  connectorNamespace: string,
) {
  const labels = {
    "kestrel.lumi.dev/managed": "true",
    "kestrel.lumi.dev/qualification-run": runId,
    "kestrel.lumi.dev/expires-at": String(Math.floor(Date.now() / 1000) + 3600),
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  };
  const existing = await kubernetes.get(`/api/v1/namespaces/${namespace}`, {
    allowNotFound: true,
  }) as { metadata?: { labels?: Record<string, string> } } | null;
  if (
    existing &&
    existing.metadata?.labels?.["kestrel.lumi.dev/qualification-run"] !== runId
  ) {
    throw new Error(`Qualification namespace ${namespace} is owned by another run.`);
  }
  if (!existing) {
    await kubernetes.create("/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace, labels },
    });
  }
  await ensureManagerBinding(kubernetes, namespace, connectorNamespace);
  if (profile.pullSecretRef) {
    const source = await kubernetes.get(
      `/api/v1/namespaces/${connectorNamespace}/secrets/${encodeURIComponent(profile.pullSecretRef)}`,
    ) as { type?: unknown; data?: unknown };
    if (
      typeof source.type !== "string" ||
      !source.data ||
      typeof source.data !== "object" ||
      Array.isArray(source.data)
    ) {
      throw new Error("Configured source pull Secret is invalid.");
    }
    await kubernetes.apply(
      `/api/v1/namespaces/${namespace}/secrets/${profile.pullSecretRef}`,
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: profile.pullSecretRef, namespace },
        type: source.type,
        data: source.data,
      },
      "kestrel-qualification",
    );
  }
  await Promise.all([
    kubernetes.apply(`/api/v1/namespaces/${namespace}/resourcequotas/kestrel-qualification`, { apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "kestrel-qualification", namespace }, spec: { hard: { pods: "4", "requests.cpu": "2", "requests.memory": "2Gi", "limits.cpu": "4", "limits.memory": "4Gi" } } }, "kestrel-qualification"),
    kubernetes.apply(`/api/v1/namespaces/${namespace}/limitranges/kestrel-qualification`, { apiVersion: "v1", kind: "LimitRange", metadata: { name: "kestrel-qualification", namespace }, spec: { limits: [{ type: "Container", defaultRequest: { cpu: "50m", memory: "64Mi" }, default: { cpu: "250m", memory: "256Mi" } }] } }, "kestrel-qualification"),
    kubernetes.apply(`/api/v1/namespaces/${namespace}/serviceaccounts/probe`, { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "probe", namespace }, automountServiceAccountToken: false }, "kestrel-qualification"),
    kubernetes.apply(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/default-deny`, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny", namespace }, spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } }, "kestrel-qualification"),
    kubernetes.apply(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/allow-probe`, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-probe", namespace }, spec: { podSelector: { matchLabels: { app: "probe" } }, ingress: [{ from: [{ podSelector: { matchLabels: { "kestrel.lumi.dev/network-role": "allowed" } } }] }], policyTypes: ["Ingress"] } }, "kestrel-qualification"),
    kubernetes.apply(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/allow-qualified-egress`, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-qualified-egress", namespace }, spec: { podSelector: { matchLabels: { "kestrel.lumi.dev/network-role": "allowed" } }, egress: [{ to: [{ podSelector: { matchLabels: { app: "probe" } } }], ports: [{ protocol: "TCP", port: 8080 }] }, { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }], policyTypes: ["Egress"] } }, "kestrel-qualification"),
    kubernetes.apply(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/allow-edge-controller`, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "allow-edge-controller", namespace }, spec: { podSelector: { matchLabels: { app: "probe" } }, ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": profile.controllerNamespace } }, podSelector: { matchLabels: profile.controllerPodSelector } }] }], policyTypes: ["Ingress"] } }, "kestrel-qualification"),
  ]);
}

async function applyProbe(kubernetes: KubernetesClient, input: { namespace: string; image: string; nonce: string; storageClassName: string; pullSecretRef: string | null; readOnlyNonce: boolean }) {
  await kubernetes.apply(`/api/v1/namespaces/${input.namespace}/persistentvolumeclaims/probe`, { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "probe", namespace: input.namespace }, spec: { accessModes: [WORKSPACE_PVC_ACCESS_MODE], storageClassName: input.storageClassName, resources: { requests: { storage: "1Gi" } } } }, "kestrel-qualification");
  await kubernetes.apply(`/apis/apps/v1/namespaces/${input.namespace}/deployments/probe`, deployment({ namespace: input.namespace, name: "probe", image: input.image, pvc: "probe", nonce: input.nonce, pullSecretRef: input.pullSecretRef, readOnlyNonce: input.readOnlyNonce }), "kestrel-qualification");
  await kubernetes.apply(`/api/v1/namespaces/${input.namespace}/services/probe`, { apiVersion: "v1", kind: "Service", metadata: { name: "probe", namespace: input.namespace }, spec: { selector: { app: "probe" }, ports: [{ name: "http", port: 8080, targetPort: 8080 }] } }, "kestrel-qualification");
}

async function applySnapshotRestore(kubernetes: KubernetesClient, input: { namespace: string; image: string; nonce: string; snapshotClassName: string; pullSecretRef: string | null; signal?: AbortSignal }) {
  await kubernetes.apply(`/apis/snapshot.storage.k8s.io/v1/namespaces/${input.namespace}/volumesnapshots/probe`, { apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot", metadata: { name: "probe", namespace: input.namespace }, spec: { volumeSnapshotClassName: input.snapshotClassName, source: { persistentVolumeClaimName: "probe" } } }, "kestrel-qualification");
  await kubernetes.waitFor(`/apis/snapshot.storage.k8s.io/v1/namespaces/${input.namespace}/volumesnapshots/probe`, (value) => recordValue(value, "status.readyToUse") === true, { timeoutMs: 120_000, signal: input.signal });
  await kubernetes.apply(`/api/v1/namespaces/${input.namespace}/persistentvolumeclaims/restore-probe`, { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "restore-probe", namespace: input.namespace }, spec: { accessModes: [WORKSPACE_PVC_ACCESS_MODE], dataSource: { name: "probe", kind: "VolumeSnapshot", apiGroup: "snapshot.storage.k8s.io" }, resources: { requests: { storage: "1Gi" } } } }, "kestrel-qualification");
  await kubernetes.apply(`/apis/apps/v1/namespaces/${input.namespace}/deployments/restore-probe`, deployment({ namespace: input.namespace, name: "restore-probe", image: input.image, pvc: "restore-probe", nonce: input.nonce, pullSecretRef: input.pullSecretRef, readOnlyNonce: true }), "kestrel-qualification");
}

async function applyEdge(kubernetes: KubernetesClient, input: { namespace: string; hostname: string; profile: Profile }) {
  if (input.profile.edge.mode === "gateway_api") {
    await kubernetes.apply(`/apis/gateway.networking.k8s.io/v1/namespaces/${input.namespace}/httproutes/probe`, { apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute", metadata: { name: "probe", namespace: input.namespace }, spec: { parentRefs: [{ name: input.profile.edge.parentName, namespace: input.profile.edge.parentNamespace, ...(input.profile.edge.sectionName ? { sectionName: input.profile.edge.sectionName } : {}) }], hostnames: [input.hostname], rules: [{ backendRefs: [{ name: "probe", port: 8080 }] }] } }, "kestrel-qualification");
    return;
  }
  await kubernetes.apply(`/apis/networking.k8s.io/v1/namespaces/${input.namespace}/ingresses/probe`, { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "probe", namespace: input.namespace, ...(input.profile.selectedCertificationProfile === "eks-ingress-v1" ? { annotations: { "alb.ingress.kubernetes.io/scheme": "internet-facing", "alb.ingress.kubernetes.io/target-type": "ip", "alb.ingress.kubernetes.io/listen-ports": '[{"HTTPS":443}]', "alb.ingress.kubernetes.io/healthcheck-path": "/health" } } : {}) }, spec: { ingressClassName: input.profile.edge.ingressClassName, tls: [{ hosts: [input.hostname] }], rules: [{ host: input.hostname, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "probe", port: { number: 8080 } } } }] } }] } }, "kestrel-qualification");
}

async function runNetworkProbe(kubernetes: KubernetesClient, input: { namespace: string; image: string; name: string; target: string; expect: "success" | "failure"; labels?: Record<string, string>; signal?: AbortSignal }) {
  const body = deployment({ namespace: input.namespace, name: input.name, image: input.image, pvc: null, nonce: "network", pullSecretRef: null });
  const spec = body.spec as Record<string, unknown>;
  const template = spec.template as { metadata: { labels: Record<string, string> }; spec: { containers: Array<Record<string, unknown>> } };
  template.metadata.labels = { ...template.metadata.labels, "kestrel.lumi.dev/network-role": input.expect === "success" ? "allowed" : "denied", ...input.labels };
  template.spec.containers[0] = {
    ...template.spec.containers[0],
    args: ["network-probe-server"],
    env: [{ name: "PROBE_TARGET", value: input.target }, { name: "PROBE_EXPECT", value: input.expect }],
  };
  await kubernetes.apply(`/apis/apps/v1/namespaces/${input.namespace}/deployments/${input.name}`, body, "kestrel-qualification");
  await waitDeploymentReady(kubernetes, input.namespace, input.name, input.signal);
}

async function runCrossNamespaceDeniedProbe(
  kubernetes: KubernetesClient,
  input: {
    namespace: string;
    targetNamespace: string;
    connectorNamespace: string;
    runId: string;
    image: string;
    signal?: AbortSignal;
  },
) {
  const existing = await kubernetes.get(`/api/v1/namespaces/${input.namespace}`, {
    allowNotFound: true,
  }) as { metadata?: { labels?: Record<string, string> } } | null;
  if (
    existing &&
    existing.metadata?.labels?.["kestrel.lumi.dev/qualification-run"] !== input.runId
  ) {
    throw new Error(`Qualification peer namespace ${input.namespace} is owned by another run.`);
  }
  if (!existing) {
    await kubernetes.create("/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: input.namespace,
        labels: {
          "kestrel.lumi.dev/managed": "true",
          "kestrel.lumi.dev/qualification-run": input.runId,
          "pod-security.kubernetes.io/enforce": "restricted",
        },
      },
    });
  }
  await ensureManagerBinding(kubernetes, input.namespace, input.connectorNamespace);
  await kubernetes.apply(
    `/api/v1/namespaces/${input.namespace}/serviceaccounts/probe`,
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "probe", namespace: input.namespace },
      automountServiceAccountToken: false,
    },
    "kestrel-qualification",
  );
  await runNetworkProbe(kubernetes, {
    namespace: input.namespace,
    image: input.image,
    name: "cross-namespace-denied",
    target: `http://probe.${input.targetNamespace}.svc.cluster.local:8080/health`,
    expect: "failure",
    signal: input.signal,
  });
}

async function ensureManagerBinding(
  kubernetes: KubernetesClient,
  namespace: string,
  connectorNamespace: string,
) {
  const path = `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings/kestrel-environment-manager`;
  const existing = await kubernetes.get(path, { allowNotFound: true }) as {
    roleRef?: { kind?: unknown; name?: unknown };
    subjects?: Array<{ kind?: unknown; name?: unknown; namespace?: unknown }>;
  } | null;
  const exact =
    existing?.roleRef?.kind === "ClusterRole" &&
    existing.roleRef.name === "kestrel-environment-manager" &&
    existing.subjects?.length === 1 &&
    existing.subjects[0]?.kind === "ServiceAccount" &&
    existing.subjects[0].name === "kestrel-connector" &&
    existing.subjects[0].namespace === connectorNamespace;
  if (existing && !exact) {
    throw new Error(`Qualification RoleBinding in ${namespace} does not match the fixed manager binding.`);
  }
  if (existing) return;
  await kubernetes.create(
    `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "kestrel-environment-manager", namespace },
      subjects: [{ kind: "ServiceAccount", name: "kestrel-connector", namespace: connectorNamespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "kestrel-environment-manager" },
    },
  );
}

async function applyQuotaProbe(kubernetes: KubernetesClient, namespace: string, image: string) {
  await kubernetes.apply(`/apis/apps/v1/namespaces/${namespace}/deployments/quota-probe`, { ...deployment({ namespace, name: "quota-probe", image, pvc: null, nonce: "quota", pullSecretRef: null }), spec: { ...deployment({ namespace, name: "quota-probe", image, pvc: null, nonce: "quota", pullSecretRef: null }).spec, replicas: 8 } }, "kestrel-qualification");
}

function deployment(input: { namespace: string; name: string; image: string; pvc: string | null; nonce: string; pullSecretRef: string | null; readOnlyNonce?: boolean }) {
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: input.name, namespace: input.namespace }, spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: input.name } }, template: { metadata: { labels: { app: input.name } }, spec: { serviceAccountName: "probe", automountServiceAccountToken: false, ...(input.pullSecretRef ? { imagePullSecrets: [{ name: input.pullSecretRef }] } : {}), securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" }, fsGroup: 10001 }, containers: [{ name: "probe", image: input.image, imagePullPolicy: "IfNotPresent", args: ["qualification-probe"], env: [{ name: "QUALIFICATION_NONCE", value: input.nonce }, { name: "QUALIFICATION_READ_ONLY", value: input.readOnlyNonce ? "true" : "false" }], ports: [{ name: "http", containerPort: 8080 }], readinessProbe: { httpGet: { path: "/health", port: "http" } }, securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }, resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "250m", memory: "256Mi" } }, ...(input.pvc ? { volumeMounts: [{ name: "workspace", mountPath: "/workspace" }] } : {}) }], ...(input.pvc ? { volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: input.pvc } }] } : {}) } } } };
}

async function waitDeploymentReady(kubernetes: KubernetesClient, namespace: string, nameValue: string, signal?: AbortSignal) {
  assertKubernetesName(nameValue);
  await kubernetes.waitFor(`/apis/apps/v1/namespaces/${namespace}/deployments/${nameValue}`, (value) => Number(recordValue(value, "status.readyReplicas")) >= 1, { timeoutMs: 120_000, signal });
}

async function observeWorkspacePvcAccessMode(
  kubernetes: KubernetesClient,
  namespace: string,
  nameValue: string,
) {
  assertKubernetesName(nameValue);
  const pvc = await kubernetes.get(
    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${nameValue}`,
  );
  const accessModes = recordValue(pvc, "spec.accessModes");
  if (
    !Array.isArray(accessModes) ||
    accessModes.length !== 1 ||
    accessModes[0] !== WORKSPACE_PVC_ACCESS_MODE
  ) {
    throw new Error(
      `PVC ${nameValue} must report exactly ${WORKSPACE_PVC_ACCESS_MODE}.`,
    );
  }
  return WORKSPACE_PVC_ACCESS_MODE;
}

async function waitForNoPods(
  kubernetes: KubernetesClient,
  namespace: string,
  appName: string,
  signal?: AbortSignal,
) {
  assertKubernetesName(appName);
  const selector = encodeURIComponent(`app=${appName}`);
  await kubernetes.waitFor(
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`,
    (value) => {
      const items = recordValue(value, "items");
      if (!Array.isArray(items)) {
        throw new Error("Kubernetes Pod list is invalid.");
      }
      return items.length === 0;
    },
    { timeoutMs: 120_000, signal },
  );
}

function deploymentHasReplicaFailure(value: unknown) {
  const conditions = recordValue(value, "status.conditions");
  return Array.isArray(conditions) && conditions.some((condition) => recordValue(condition, "type") === "ReplicaFailure" && recordValue(condition, "status") === "True");
}

async function residualInventory(kubernetes: KubernetesClient, namespace: string) {
  const value = await kubernetes.get(`/api/v1/namespaces/${namespace}`, { allowNotFound: true });
  return value ? [`Namespace/${namespace}`] : [];
}

function recordValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function safeFailure(error: unknown) {
  if (error instanceof KubernetesApiError) return `${error.message} Phase: ${error.phase}.`.slice(0, 500);
  return (error instanceof Error ? error.message : "Qualification failed.")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 500);
}
