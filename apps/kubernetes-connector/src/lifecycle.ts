import { createHash } from "node:crypto";
import {
  decryptConnectorCommandSecrets,
  parseConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import type { ConnectorCommand, ConnectorCommandType } from "./contracts.js";
import {
  connectorResultSchema,
  parseConnectorCommandPayload,
  RESULT_VERSION,
} from "./contracts.js";
import type { ConnectorIdentity } from "./identity.js";
import {
  assertKubernetesName,
  KubernetesApiError,
  KubernetesWaitTimeoutError,
  type KubernetesClient,
} from "./kubernetes-client.js";
import {
  discoverDeletableNamespacedResources,
  KubernetesDiscoveryError,
} from "./kubernetes-discovery.js";
import {
  connectorKubernetesProfileSchema,
  type ConnectorKubernetesProfile,
} from "./qualification.js";

const FIELD_MANAGER = "kestrel-connector";
const WORKSPACE_PORT = 43_104;
const GATEWAY_PORT = 43_116;
const WORKSPACE_STORAGE_GB = 20;
const MANAGED_BY = "kestrel-connector";

type JsonRecord = Record<string, unknown>;
type ResourceRef = {
  provider: "kubernetes";
  role:
    | "environment_scope"
    | "gateway"
    | "workspace_compute"
    | "workspace_storage"
    | "snapshot"
    | "edge_route";
  externalId: string;
  observedGeneration?: string;
};
type Observation = {
  resource: ResourceRef;
  disposition: "created" | "adopted" | "unchanged" | "updated" | "deleted";
  providerUid?: string;
  observedGeneration?: string;
  kind: string;
  namespace?: string;
  state?: string;
  workspaceId?: string;
  replacementId?: string;
  relatedResources?: ResourceRef[];
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
};

export class KubernetesLifecycleError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_UNAVAILABLE"
      | "PROVIDER_REJECTED"
      | "RESOURCE_CONFLICT"
      | "RESPONSE_INVALID"
      | "RESOURCE_UNHEALTHY"
      | "CAPABILITY_UNSUPPORTED"
      | "OPERATION_TIMEOUT",
    message: string,
    readonly retryable: boolean,
    readonly apiError?: KubernetesApiError,
  ) {
    super(message);
    this.name = "KubernetesLifecycleError";
  }
}

export async function executeLifecycleCommand(input: {
  command: ConnectorCommand;
  kubernetes: KubernetesClient;
  identity: ConnectorIdentity;
  connectorNamespace: string;
  signal?: AbortSignal;
  onProgress?: (state: string, message: string) => Promise<void>;
  provePublicEndpoint?: (input: { url: string; nonce: string }) => Promise<{ passed?: unknown }>;
}) {
  if (input.command.type === "qualify_connection") {
    throw new Error("Qualification commands use the qualification runner.");
  }
  try {
    const payload = parseConnectorCommandPayload(input.command) as JsonRecord;
    const profile = connectorKubernetesProfileSchema.parse(payload.profile);
    const secrets = decryptSecrets(input.command, input.identity);
    const context: LifecycleContext = {
      ...input,
      payload,
      profile,
      secrets,
      namespace: namespaceFor(profile, input.command.environmentId!),
    };
    await input.onProgress?.("observing", `Observing ${input.command.type}.`);
    const executed = await dispatch(context);
    return connectorResultSchema.parse({
      contract: RESULT_VERSION,
      commandId: input.command.id,
      connectionId: input.command.connectionId,
      commandType: input.command.type,
      status: "succeeded",
      observedRevision: input.command.desiredRevision,
      resources: executed.resources,
      evidence: [
        {
          level: "implementation",
          connectorCommandId: input.command.id,
          phase: executed.phase,
          detail: executed.detail,
        },
      ],
      output: {
        ...executed.output,
        resourceObservations: executed.observations,
      },
    });
  } catch (error) {
    const failure = input.signal?.aborted
      ? new KubernetesLifecycleError(
          "PROVIDER_UNAVAILABLE",
          "Connector command lease was lost.",
          true,
        )
      : normalizeLifecycleError(error);
    return connectorResultSchema.parse({
      contract: RESULT_VERSION,
      commandId: input.command.id,
      connectionId: input.command.connectionId,
      commandType: input.command.type,
      status: "failed",
      observedRevision: input.command.desiredRevision,
      resources: [],
      evidence: [
        {
          level: "implementation",
          connectorCommandId: input.command.id,
          ...(failure.apiError?.auditId
            ? { kubernetesAuditId: failure.apiError.auditId }
            : {}),
          ...(failure.apiError?.status
            ? { httpStatus: failure.apiError.status }
            : {}),
          phase: failure.apiError?.phase ?? input.command.type,
          detail: failure.message,
        },
      ],
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    });
  }
}

type LifecycleContext = {
  command: ConnectorCommand;
  kubernetes: KubernetesClient;
  identity: ConnectorIdentity;
  connectorNamespace: string;
  signal?: AbortSignal;
  onProgress?: (state: string, message: string) => Promise<void>;
  provePublicEndpoint?: (input: { url: string; nonce: string }) => Promise<{ passed?: unknown }>;
  payload: JsonRecord;
  profile: ConnectorKubernetesProfile;
  secrets: Record<string, string>;
  namespace: string;
};

type Execution = {
  phase: string;
  detail: string;
  resources: ResourceRef[];
  observations: Observation[];
  output: JsonRecord;
};

async function dispatch(context: LifecycleContext): Promise<Execution> {
  switch (context.command.type) {
    case "ensure_environment_scope":
      return ensureEnvironmentScope(context);
    case "ensure_environment_gateway":
      return ensureEnvironmentGateway(context);
    case "ensure_workspace_storage":
      return ensureWorkspaceStorage(context, false);
    case "ensure_workspace_compute":
      return ensureWorkspaceCompute(context, false);
    case "get_workspace_compute":
      return getWorkspaceCompute(context);
    case "start_workspace_compute":
      return scaleWorkspaceCompute(context, 1);
    case "stop_workspace_compute":
      return scaleWorkspaceCompute(context, 0);
    case "update_workspace_image":
      return updateWorkspaceImage(context);
    case "create_workspace_snapshot":
      return createWorkspaceSnapshot(context);
    case "is_workspace_snapshot_usable":
      return inspectWorkspaceSnapshot(context);
    case "create_replacement_workspace_storage":
      return ensureWorkspaceStorage(context, true);
    case "create_replacement_workspace_compute":
      return ensureWorkspaceCompute(context, true);
    case "list_environment_resources":
      return listEnvironmentResources(context);
    case "delete_workspace_compute":
      return deleteWorkspaceCompute(context);
    case "delete_workspace_storage":
      return deleteWorkspaceStorage(context);
    case "delete_environment_scope":
      return deleteEnvironmentScope(context);
    case "wait_for_workspace_state":
      return waitForWorkspaceState(context);
    case "wait_for_workspace_health":
      return waitForWorkspaceHealth(context);
    default:
      return unsupported(context.command.type);
  }
}

async function ensureEnvironmentScope(context: LifecycleContext): Promise<Execution> {
  const labels = namespaceLabels(context);
  const namespacePath = `/api/v1/namespaces/${context.namespace}`;
  const namespaceManifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: context.namespace,
      labels,
      annotations: ownedAnnotations(context),
    },
  };
  const current = await context.kubernetes.get(namespacePath, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  let namespaceDisposition: Observation["disposition"];
  if (current) {
    assertOwned(current, context, "Namespace", context.namespace);
    if (containsDesiredState(current, namespaceManifest)) {
      namespaceDisposition = "unchanged";
    } else {
      await context.kubernetes.apply(
        namespacePath,
        namespaceManifest,
        FIELD_MANAGER,
        { signal: context.signal },
      );
      namespaceDisposition = "updated";
    }
  } else {
    await context.kubernetes.apply(
      namespacePath,
      namespaceManifest,
      FIELD_MANAGER,
      { signal: context.signal },
    );
    namespaceDisposition = "created";
  }
  await ensureManagerBinding(context);
  if (context.profile.pullSecretRef) await copyPullSecret(context);
  const resources = environmentBaselineManifests(context);
  for (const resource of resources) await applyOwned(context, resource);
  const observed = await requireObject(
    context.kubernetes.get(namespacePath, { signal: context.signal }),
    "Namespace response",
  );
  const ref = resourceRef("environment_scope", context.namespace, observed);
  return success(
    "environment.scope.ready",
    `Environment namespace ${context.namespace} is ready.`,
    [ref],
    [observation(ref, namespaceDisposition, "Namespace", observed)],
    { state: "ready", placement: placement(context) },
  );
}

async function ensureEnvironmentGateway(context: LifecycleContext): Promise<Execution> {
  requireScope(context);
  const serviceToken = requireSecret(context, "serviceToken");
  const deploymentName = "gateway";
  const serviceName = "gateway";
  const hostname = `${shortHash(context.command.environmentId!)}.${context.profile.baseDomain}`;
  const serviceTokenHash = requireString(context.payload, "serviceTokenHash");
  const manifests = [
    serviceAccount(context, "gateway"),
    secret(context, "gateway-config", {
      KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: requireString(context.payload, "ticketPublicKey"),
      KESTREL_CONTROL_PLANE_URL: requireString(context.payload, "controlPlaneUrl"),
    }),
    secret(context, "gateway-token", {
      KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN: serviceToken,
    }),
    gatewayService(context, serviceName),
    gatewayDeployment(context, deploymentName, serviceTokenHash),
    edgeManifest(context, hostname, serviceName),
  ];
  const observations: Observation[] = [];
  for (const manifest of manifests) {
    observations.push(await applyOwned(context, manifest));
  }
  await waitDeployment(context, deploymentName, 1);
  await waitEdgeReady(context);
  if (!context.provePublicEndpoint) {
    throw new KubernetesLifecycleError(
      "PROVIDER_UNAVAILABLE",
      "Gateway public-endpoint proof is unavailable.",
      true,
    );
  }
  const challenge = createHash("sha256")
    .update(`gateway-health:${context.command.id}`)
    .digest("hex")
    .slice(0, 48);
  const proof = await context.provePublicEndpoint({
    url: `https://${hostname}/health?nonce=${challenge}`,
    nonce: challenge,
  });
  if (proof.passed !== true) {
    throw new KubernetesLifecycleError(
      "RESOURCE_UNHEALTHY",
      `Gateway HTTPS challenge failed for ${hostname}.`,
      false,
    );
  }
  const deployment = await getDeployment(context, deploymentName);
  const routeName = "gateway";
  const gatewayRef = resourceRef("gateway", deploymentName, deployment);
  const route = await requireObject(
    context.kubernetes.get(edgePath(context, routeName), { signal: context.signal }),
    "Kubernetes edge route response",
  );
  assertEdgeHostname(context, route, hostname);
  const edgeRef = resourceRef("edge_route", routeName, route);
  const gatewayApply = observations.find((item) => item.kind === "Deployment");
  const edgeApply = observations.find((item) =>
    item.kind === "HTTPRoute" || item.kind === "Ingress",
  );
  return success(
    "gateway.ready",
    `Gateway resources for ${hostname} are ready.`,
    [gatewayRef, edgeRef],
    [
      {
        ...(gatewayApply ?? observation(gatewayRef, "unchanged", "Deployment", deployment)),
        resource: gatewayRef,
        state: "started",
      },
      {
        ...(edgeApply ?? observation(
          edgeRef,
          "unchanged",
          context.profile.edge.mode === "gateway_api" ? "HTTPRoute" : "Ingress",
          route,
        )),
        resource: edgeRef,
        state: "ready",
      },
    ],
    {
      state: "started",
      routerUrl: `https://${hostname}`,
      placement: placement(context),
      serviceTokenHash,
      conditions: conditions(deployment),
    },
  );
}

async function ensureWorkspaceStorage(
  context: LifecycleContext,
  replacement: boolean,
): Promise<Execution> {
  requireScope(context);
  const workspaceId = requireWorkspaceId(context);
  const replacementId = replacement
    ? requireString(context.payload, "replacementId")
    : undefined;
  const name = storageName(workspaceId, replacementId);
  const source = replacement
    ? requireResource(context.payload.snapshot, "snapshot")
    : optionalResource(context.payload.snapshot);
  if (source) {
    const sourceSnapshot = await context.kubernetes.get(
      snapshotPath(context, source.externalId),
      { allowNotFound: true, signal: context.signal },
    ) as JsonRecord | null;
    if (!sourceSnapshot) {
      throw conflict(`VolumeSnapshot ${source.externalId} is absent.`);
    }
    assertOwned(sourceSnapshot, context, "VolumeSnapshot", source.externalId);
    if (recordValue(sourceSnapshot, "status.readyToUse") !== true) {
      throw new KubernetesLifecycleError(
        "RESOURCE_UNHEALTHY",
        `VolumeSnapshot ${source.externalId} is not ready to use.`,
        false,
      );
    }
  }
  const body = pvc(context, name, source?.externalId);
  const observedBefore = await context.kubernetes.get(pvcPath(context, name), {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (observedBefore) assertOwned(observedBefore, context, "PersistentVolumeClaim", name);
  const applied = await applyOwned(context, body);
  const observed = await waitPvcBound(context, name);
  assertExactRwo(observed, name);
  const ref = resourceRef("workspace_storage", name, observed);
  return success(
    replacement ? "workspace.storage.replacement.ready" : "workspace.storage.ready",
    `Workspace PVC ${name} is Bound with ReadWriteOnce.`,
    [ref],
    [{ ...applied, resource: ref, ...(replacementId ? { replacementId } : {}) }],
    {
      state: "ready",
      sizeGb: WORKSPACE_STORAGE_GB,
      placement: placement(context),
      storageSecurity: context.profile.encryptionAttestations.persistentVolumes,
    },
  );
}

async function ensureWorkspaceCompute(
  context: LifecycleContext,
  replacement: boolean,
): Promise<Execution> {
  requireScope(context);
  const workspaceId = requireWorkspaceId(context);
  const replacementId = replacement
    ? requireString(context.payload, "replacementId")
    : undefined;
  const desired = requireRecord(context.payload.desired, "desired runtime");
  const storage = requireResource(context.payload.storage, "workspace_storage");
  await assertSingleWriter(context, storage.externalId, computeName(workspaceId, replacementId));
  const name = computeName(workspaceId, replacementId);
  const serviceToken = context.secrets.serviceToken;
  const serviceTokenHash = optionalString(desired.serviceTokenHash);
  if (serviceTokenHash && !serviceToken) {
    throw new KubernetesLifecycleError(
      "PROVIDER_REJECTED",
      "Workspace service-token hash was supplied without encrypted token material.",
      false,
    );
  }
  if (serviceToken && !serviceTokenHash) {
    throw new KubernetesLifecycleError(
      "PROVIDER_REJECTED",
      "Encrypted workspace service-token material requires its hash.",
      false,
    );
  }
  const manifests = [
    serviceAccount(context, name),
    secret(context, `${name}-config`, runtimeConfig(context, desired)),
    ...(serviceToken ? [secret(context, `${name}-token`, { KESTREL_WORKSPACE_SERVICE_TOKEN: serviceToken })] : []),
    workspaceService(context, name),
    workspaceDeployment(context, name, storage.externalId, desired),
  ];
  const observations: Observation[] = [];
  for (const manifest of manifests) observations.push(await applyOwned(context, manifest));
  await waitDeployment(context, name, 1);
  const deployment = await getDeployment(context, name);
  assertDeploymentImage(deployment, requireString(desired, "runtimeImage"));
  const ref = resourceRef("workspace_compute", name, deployment);
  return success(
    replacement ? "workspace.compute.replacement.ready" : "workspace.compute.ready",
    `Workspace compute ${name} is ready.`,
    [ref],
    [{
      ...observations.at(-1)!,
      resource: ref,
      workspaceId,
      ...(replacementId ? { replacementId } : {}),
      relatedResources: [storage],
    }],
    computeOutput(context, deployment, desired, serviceTokenHash),
  );
}

async function getWorkspaceCompute(context: LifecycleContext): Promise<Execution> {
  const compute = requireResource(context.payload.compute, "workspace_compute");
  const deployment = await context.kubernetes.get(deploymentPath(context, compute.externalId), {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (!deployment) {
    return success("workspace.compute.absent", "Workspace compute is absent.", [], [], {
      state: "destroyed",
    });
  }
  assertOwned(deployment, context, "Deployment", compute.externalId);
  const ref = resourceRef("workspace_compute", compute.externalId, deployment);
  return success(
    "workspace.compute.observed",
    `Workspace compute ${compute.externalId} was observed.`,
    [ref],
    [observation(ref, "unchanged", "Deployment", deployment)],
    computeOutput(context, deployment),
  );
}

async function scaleWorkspaceCompute(
  context: LifecycleContext,
  replicas: 0 | 1,
): Promise<Execution> {
  const compute = requireResource(context.payload.compute, "workspace_compute");
  const current = await getDeployment(context, compute.externalId);
  assertOwned(current, context, "Deployment", compute.externalId);
  if (replicas === 1) {
    const claim = deploymentClaim(current);
    if (claim) await assertSingleWriter(context, claim, compute.externalId);
  }
  const observedBefore = Number(recordValue(current, "spec.replicas") ?? 0);
  const applied = observedBefore === replicas
    ? current
    : await requireObject(
        context.kubernetes.strategicMergePatch(
          deploymentPath(context, compute.externalId),
          { spec: { replicas } },
          { signal: context.signal },
        ),
        "Deployment scale response",
      );
  if (replicas === 0) await waitForNoPods(context, compute.externalId);
  else await waitDeployment(context, compute.externalId, 1);
  const observed = await getDeployment(context, compute.externalId);
  const ref = resourceRef("workspace_compute", compute.externalId, observed);
  return success(
    replicas === 0 ? "workspace.compute.stopped" : "workspace.compute.started",
    `Workspace compute ${compute.externalId} is ${replicas === 0 ? "stopped" : "started"}.`,
    [ref],
    [observation(
      ref,
      observedBefore === replicas ? "unchanged" : "updated",
      "Deployment",
      applied,
    )],
    computeOutput(context, observed),
  );
}

async function updateWorkspaceImage(context: LifecycleContext): Promise<Execution> {
  const compute = requireResource(context.payload.compute, "workspace_compute");
  const image = requireString(context.payload, "runtimeImage");
  const current = await getDeployment(context, compute.externalId);
  const claim = deploymentClaim(current);
  if (!claim) throw invalidResponse("Workspace Deployment has no PVC claim.");
  await scaleDeploymentToZero(context, compute.externalId);
  await assertSingleWriter(context, claim, compute.externalId);
  await applyRuntimeEnvironmentPatch(context, compute.externalId);
  const container = firstContainer(current);
  const containerName = requireString(container, "name");
  const applied = await requireObject(
    context.kubernetes.strategicMergePatch(
      deploymentPath(context, compute.externalId),
      {
        metadata: { annotations: ownedAnnotations(context) },
        spec: {
          replicas: 1,
          template: {
            metadata: { annotations: ownedAnnotations(context) },
            spec: { containers: [{ name: containerName, image }] },
          },
        },
      },
      { signal: context.signal },
    ),
    "Deployment image update response",
  );
  await waitDeployment(context, compute.externalId, 1);
  const observed = await getDeployment(context, compute.externalId);
  assertDeploymentImage(observed, image);
  const ref = resourceRef("workspace_compute", compute.externalId, observed);
  return success(
    "workspace.image.updated",
    `Workspace compute ${compute.externalId} uses the requested immutable image.`,
    [ref],
    [observation(ref, "updated", "Deployment", applied)],
    computeOutput(context, observed),
  );
}

async function applyRuntimeEnvironmentPatch(
  context: LifecycleContext,
  computeNameValue: string,
) {
  if (context.payload.environmentPatch === undefined) return;
  const patch = requireRecord(
    context.payload.environmentPatch,
    "runtime environment patch",
  );
  const name = `${computeNameValue}-config`;
  const path = secretPath(context, name);
  const current = await context.kubernetes.get(path, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (!current) throw conflict(`Workspace configuration Secret ${name} is absent.`);
  assertOwned(current, context, "Secret", name);
  const body = applyBodyFromObserved(current, context);
  const data = requireRecord(body.data, "workspace configuration Secret data");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete data[key];
    else if (typeof value === "string") {
      data[key] = Buffer.from(value).toString("base64");
    } else {
      throw invalidResponse(`Environment patch value ${key} is invalid.`);
    }
  }
  await applyOwned(context, body);
}

async function createWorkspaceSnapshot(context: LifecycleContext): Promise<Execution> {
  const storage = requireResource(context.payload.storage, "workspace_storage");
  const sourceStorage = await context.kubernetes.get(
    pvcPath(context, storage.externalId),
    { allowNotFound: true, signal: context.signal },
  ) as JsonRecord | null;
  if (!sourceStorage) throw conflict(`Workspace PVC ${storage.externalId} is absent.`);
  assertOwned(sourceStorage, context, "PersistentVolumeClaim", storage.externalId);
  assertExactRwo(sourceStorage, storage.externalId);
  const name = `snap-${shortHash(context.command.idempotencyKey)}`;
  const manifest = {
    apiVersion: "snapshot.storage.k8s.io/v1",
    kind: "VolumeSnapshot",
    metadata: ownedMetadata(context, name),
    spec: {
      volumeSnapshotClassName: context.profile.volumeSnapshotClassName,
      source: { persistentVolumeClaimName: storage.externalId },
    },
  };
  const applied = await applyOwned(context, manifest);
  const observed = await waitSnapshot(context, name);
  const ref = resourceRef("snapshot", name, observed);
  return success(
    "workspace.snapshot.ready",
    `VolumeSnapshot ${name} is ready to use.`,
    [ref],
    [{ ...applied, resource: ref, relatedResources: [storage] }],
    { state: "ready", usable: true },
  );
}

async function inspectWorkspaceSnapshot(context: LifecycleContext): Promise<Execution> {
  const snapshot = requireResource(context.payload.snapshot, "snapshot");
  const observed = await context.kubernetes.get(snapshotPath(context, snapshot.externalId), {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (observed) {
    assertOwned(observed, context, "VolumeSnapshot", snapshot.externalId);
  }
  const usable = recordValue(observed, "status.readyToUse") === true;
  const resources = observed ? [resourceRef("snapshot", snapshot.externalId, observed)] : [];
  return success(
    "workspace.snapshot.observed",
    `VolumeSnapshot ${snapshot.externalId} is ${usable ? "usable" : "not usable"}.`,
    resources,
    observed ? [observation(resources[0]!, "unchanged", "VolumeSnapshot", observed)] : [],
    { state: usable ? "ready" : "pending", usable },
  );
}

async function listEnvironmentResources(context: LifecycleContext): Promise<Execution> {
  const namespace = await context.kubernetes.get(
    `/api/v1/namespaces/${context.namespace}`,
    { allowNotFound: true, signal: context.signal },
  ) as JsonRecord | null;
  if (!namespace) {
    return success(
      "environment.inventory.absent",
      `Environment namespace ${context.namespace} is absent.`,
      [],
      [],
      { state: "absent" },
    );
  }
  const selectors = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);
  const endpoints = [
    ["PersistentVolumeClaim", `/api/v1/namespaces/${context.namespace}/persistentvolumeclaims?labelSelector=${selectors}`],
    ["Deployment", `/apis/apps/v1/namespaces/${context.namespace}/deployments?labelSelector=${selectors}`],
    ["VolumeSnapshot", `/apis/snapshot.storage.k8s.io/v1/namespaces/${context.namespace}/volumesnapshots?labelSelector=${selectors}`],
    [context.profile.edge.mode === "gateway_api" ? "HTTPRoute" : "Ingress", `${edgeCollectionPath(context)}?labelSelector=${selectors}`],
  ] as const;
  const observations: Observation[] = [];
  for (const [kind, path] of endpoints) {
    const list = await requireObject(
      context.kubernetes.get(path, { signal: context.signal }),
      `${kind} list response`,
    );
    const items = list.items;
    if (!Array.isArray(items)) throw invalidResponse(`${kind} list has no items array.`);
    for (const item of items) {
      const object = requireRecord(item, `${kind} item`);
      assertOwned(object, context, kind, metadataName(object));
      const role = roleFromObject(object);
      if (!role) continue;
      const ref = resourceRef(role, metadataName(object), object);
      observations.push({
        ...observation(ref, "unchanged", kind, object),
        ...(label(object, "kestrel.dev/workspace-id")
          ? { workspaceId: label(object, "kestrel.dev/workspace-id") }
          : {}),
        ...(label(object, "kestrel.dev/replacement-id")
          ? { replacementId: label(object, "kestrel.dev/replacement-id") }
          : {}),
      });
    }
  }
  return success(
    "environment.inventory.read",
    `Observed ${observations.length} Kestrel resources in ${context.namespace}.`,
    observations.map((item) => item.resource),
    observations,
    { state: "observed" },
  );
}

async function deleteWorkspaceCompute(context: LifecycleContext): Promise<Execution> {
  const compute = requireResource(context.payload.compute, "workspace_compute");
  const deployment = await context.kubernetes.get(deploymentPath(context, compute.externalId), {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (deployment) {
    assertOwned(deployment, context, "Deployment", compute.externalId);
    await context.kubernetes.delete(deploymentPath(context, compute.externalId), {
      allowNotFound: true,
      signal: context.signal,
    });
    await context.kubernetes.waitFor(
      deploymentPath(context, compute.externalId),
      (value) => value === null,
      waitOptions(context, 120),
    );
  }
  await waitForNoPods(context, compute.externalId);
  for (const [kind, path] of [
    ["Service", servicePath(context, compute.externalId)],
    ["Secret", secretPath(context, `${compute.externalId}-config`)],
    ["Secret", secretPath(context, `${compute.externalId}-token`)],
    ["ServiceAccount", serviceAccountPath(context, compute.externalId)],
  ] as const) await deleteOwnedIfPresent(context, kind, path);
  return success(
    "workspace.compute.deleted",
    `Workspace compute ${compute.externalId} is absent.`,
    [],
    [{ resource: compute, disposition: "deleted", kind: "Deployment", namespace: context.namespace }],
    { state: "destroyed" },
  );
}

async function deleteWorkspaceStorage(context: LifecycleContext): Promise<Execution> {
  const storage = requireResource(context.payload.storage, "workspace_storage");
  await assertNoPvcConsumers(context, storage.externalId);
  const path = pvcPath(context, storage.externalId);
  const current = await context.kubernetes.get(path, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (current) {
    assertOwned(current, context, "PersistentVolumeClaim", storage.externalId);
    await context.kubernetes.delete(path, { allowNotFound: true, signal: context.signal });
    await context.kubernetes.waitFor(path, (value) => value === null, waitOptions(context, 180));
  }
  return success(
    "workspace.storage.deleted",
    `Workspace PVC ${storage.externalId} is absent.`,
    [],
    [{ resource: storage, disposition: "deleted", kind: "PersistentVolumeClaim", namespace: context.namespace }],
    { state: "destroyed" },
  );
}

async function deleteEnvironmentScope(context: LifecycleContext): Promise<Execution> {
  requireScope(context);
  const inventory = await listEnvironmentResources(context);
  const blockers = inventory.observations.filter((item) =>
    item.resource.role === "workspace_compute" || item.resource.role === "workspace_storage",
  );
  if (blockers.length > 0) {
    throw new KubernetesLifecycleError(
      "RESOURCE_CONFLICT",
      `Environment namespace still contains ${blockers.length} managed workspace resources.`,
      false,
    );
  }
  await deleteOwnedIfPresent(context, "Deployment", deploymentPath(context, "gateway"));
  await deleteOwnedIfPresent(context, "Service", servicePath(context, "gateway"));
  await deleteOwnedIfPresent(context, context.profile.edge.mode === "gateway_api" ? "HTTPRoute" : "Ingress", edgePath(context, "gateway"));
  await assertNoCustomerNamespaceResources(context);
  const namespacePath = `/api/v1/namespaces/${context.namespace}`;
  const current = await context.kubernetes.get(namespacePath, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (current) {
    assertOwned(current, context, "Namespace", context.namespace);
    await context.kubernetes.delete(namespacePath, { allowNotFound: true, signal: context.signal });
    await context.kubernetes.waitFor(namespacePath, (value) => value === null, waitOptions(context, 300));
  }
  return success(
    "environment.scope.deleted",
    `Environment namespace ${context.namespace} is absent.`,
    [],
    [{
      resource: { provider: "kubernetes", role: "environment_scope", externalId: context.namespace },
      disposition: "deleted",
      kind: "Namespace",
    }],
    { state: "destroyed" },
  );
}

async function assertNoCustomerNamespaceResources(context: LifecycleContext) {
  const collections = await discoverDeletableNamespacedResources(
    context.kubernetes,
    context.signal,
  );
  const conflicts: string[] = [];
  for (const collection of collections) {
    for (const resource of await listItems(
      context,
      collection.collectionPath(context.namespace),
      collection.kind,
    )) {
      const name = metadataName(resource);
      const generatedDefault =
        (collection.resource === "serviceaccounts" && name === "default") ||
        (collection.resource === "configmaps" && name === "kube-root-ca.crt");
      if (!generatedDefault && !isOwned(resource, context)) {
        conflicts.push(`${collection.kind}/${name}`);
      }
    }
  }
  if (conflicts.length > 0) {
    throw conflict(
      `Environment namespace contains customer-owned resources: ${conflicts.slice(0, 10).join(", ")}.`,
    );
  }
}

async function waitForWorkspaceState(context: LifecycleContext): Promise<Execution> {
  const state = requireString(context.payload, "state");
  const compute = requireResource(context.payload.compute, "workspace_compute");
  if (state === "destroyed") {
    await context.kubernetes.waitFor(
      deploymentPath(context, compute.externalId),
      (value) => value === null,
      waitOptions(context, optionalNumber(context.payload.timeoutSeconds) ?? 300),
    );
  } else if (state === "stopped") {
    await waitForNoPods(context, compute.externalId);
  } else {
    await waitDeployment(context, compute.externalId, 1, optionalNumber(context.payload.timeoutSeconds));
  }
  return getWorkspaceCompute(context);
}

async function waitForWorkspaceHealth(context: LifecycleContext): Promise<Execution> {
  const compute = requireResource(context.payload.compute, "workspace_compute");
  await waitDeployment(context, compute.externalId, 1, optionalNumber(context.payload.timeoutSeconds));
  const deployment = await getDeployment(context, compute.externalId);
  const ref = resourceRef("workspace_compute", compute.externalId, deployment);
  return success(
    "workspace.health.ready",
    `Workspace compute ${compute.externalId} is ready.`,
    [ref],
    [observation(ref, "unchanged", "Deployment", deployment)],
    computeOutput(context, deployment),
  );
}

function environmentBaselineManifests(context: LifecycleContext): JsonRecord[] {
  const limit = requireNumber(context.payload, "workspaceLimit");
  return [
    serviceAccount(context, "runtime"),
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: ownedMetadata(context, "kestrel"),
      spec: {
        hard: {
          pods: String(limit + 2),
          "requests.cpu": String(limit * 2 + 1),
          "limits.cpu": String(limit * 2 + 1),
          "requests.memory": `${limit * 4 + 1}Gi`,
          "limits.memory": `${limit * 4 + 1}Gi`,
          persistentvolumeclaims: String(limit + 1),
          "requests.storage": `${(limit + 1) * WORKSPACE_STORAGE_GB}Gi`,
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: ownedMetadata(context, "kestrel"),
      spec: {
        limits: [{
          type: "Container",
          defaultRequest: { cpu: "250m", memory: "256Mi" },
          default: { cpu: "2", memory: "4Gi" },
        }],
      },
    },
    networkPolicy(context, "default-deny-ingress", {}, [], ["Ingress"]),
    networkPolicy(
      context,
      "allow-edge-to-gateway",
      { "kestrel.dev/resource-role": "gateway" },
      [{
        from: [{
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": context.profile.controllerNamespace } },
          podSelector: { matchLabels: context.profile.controllerPodSelector },
        }],
        ports: [{ protocol: "TCP", port: GATEWAY_PORT }],
      }],
      ["Ingress"],
    ),
    networkPolicy(
      context,
      "allow-gateway-to-workspaces",
      { "kestrel.dev/resource-role": "workspace-compute" },
      [{
        from: [{ podSelector: { matchLabels: { "kestrel.dev/resource-role": "gateway" } } }],
        ports: [{ protocol: "TCP", port: WORKSPACE_PORT }],
      }],
      ["Ingress"],
    ),
  ];
}

function networkPolicy(
  context: LifecycleContext,
  name: string,
  podSelector: Record<string, string>,
  ingress: unknown[],
  policyTypes: string[],
) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: ownedMetadata(context, name),
    spec: { podSelector: { matchLabels: podSelector }, ingress, policyTypes },
  };
}

function serviceAccount(context: LifecycleContext, name: string) {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: ownedMetadata(context, name),
    automountServiceAccountToken: false,
  };
}

function secret(context: LifecycleContext, name: string, values: Record<string, string>) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: ownedMetadata(context, name),
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    ),
  };
}

function gatewayService(context: LifecycleContext, name: string) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: ownedMetadata(context, name),
    spec: {
      selector: selectorLabels(context, "gateway"),
      ports: [{ name: "http", port: GATEWAY_PORT, targetPort: "http" }],
    },
  };
}

function workspaceService(context: LifecycleContext, name: string) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: ownedMetadata(context, name),
    spec: {
      selector: selectorLabels(context, "workspace-compute", name),
      ports: [{ name: "http", port: WORKSPACE_PORT, targetPort: "http" }],
    },
  };
}

function gatewayDeployment(
  context: LifecycleContext,
  name: string,
  serviceTokenHash: string,
) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: ownedMetadata(context, name),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: selectorLabels(context, "gateway") },
      template: {
        metadata: {
          labels: { ...ownedLabels(context), ...selectorLabels(context, "gateway") },
          annotations: ownedAnnotations(context),
        },
        spec: podSpec(context, "gateway", [{
          name: "gateway",
          image: requireString(context.payload, "runtimeImage"),
          imagePullPolicy: "IfNotPresent",
          env: [
            { name: "KESTREL_ENVIRONMENT_ID", value: context.command.environmentId },
            { name: "KESTREL_ENVIRONMENT_GATEWAY_ID", value: "gateway" },
            { name: "KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN_HASH", value: serviceTokenHash },
          ],
          envFrom: [
            { secretRef: { name: "gateway-config" } },
            { secretRef: { name: "gateway-token" } },
          ],
          ports: [{ name: "http", containerPort: GATEWAY_PORT }],
          readinessProbe: { httpGet: { path: "/health", port: "http" } },
          resources: {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
          securityContext: containerSecurity(),
        }]),
      },
    },
  };
}

function workspaceDeployment(
  context: LifecycleContext,
  name: string,
  claimName: string,
  desired: JsonRecord,
) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: ownedMetadata(context, name),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: selectorLabels(context, "workspace-compute", name) },
      template: {
        metadata: {
          labels: { ...ownedLabels(context), ...selectorLabels(context, "workspace-compute", name) },
          annotations: ownedAnnotations(context),
        },
        spec: {
          ...podSpec(context, name, [{
            name: "workspace",
            image: requireString(desired, "runtimeImage"),
            imagePullPolicy: "IfNotPresent",
            envFrom: [
              { secretRef: { name: `${name}-config` } },
              ...(context.secrets.serviceToken
                ? [{ secretRef: { name: `${name}-token` } }]
                : []),
            ],
            ports: [{ name: "http", containerPort: WORKSPACE_PORT }],
            readinessProbe: { httpGet: { path: "/health", port: "http" } },
            resources: {
              requests: { cpu: "2", memory: "4Gi" },
              limits: { cpu: "2", memory: "4Gi" },
            },
            securityContext: containerSecurity(),
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
          }]),
          volumes: [{ name: "workspace", persistentVolumeClaim: { claimName } }],
        },
      },
    },
  };
}

function podSpec(context: LifecycleContext, serviceAccountName: string, containers: JsonRecord[]) {
  return {
    serviceAccountName,
    automountServiceAccountToken: false,
    ...(context.profile.pullSecretRef
      ? { imagePullSecrets: [{ name: context.profile.pullSecretRef }] }
      : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    },
    terminationGracePeriodSeconds: 120,
    containers,
  };
}

function containerSecurity() {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
}

function pvc(context: LifecycleContext, name: string, snapshotName?: string) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: ownedMetadata(context, name),
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: context.profile.storageClassName,
      ...(snapshotName
        ? { dataSource: { apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: snapshotName } }
        : {}),
      resources: { requests: { storage: `${WORKSPACE_STORAGE_GB}Gi` } },
    },
  };
}

function edgeManifest(context: LifecycleContext, hostname: string, serviceName: string) {
  if (context.profile.edge.mode === "gateway_api") {
    return {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: ownedMetadata(context, "gateway"),
      spec: {
        parentRefs: [{
          name: context.profile.edge.parentName,
          namespace: context.profile.edge.parentNamespace,
          ...(context.profile.edge.sectionName ? { sectionName: context.profile.edge.sectionName } : {}),
        }],
        hostnames: [hostname],
        rules: [{ backendRefs: [{ name: serviceName, port: GATEWAY_PORT }] }],
      },
    };
  }
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: ownedMetadata(context, "gateway"),
    spec: {
      ingressClassName: context.profile.edge.ingressClassName,
      tls: [{ hosts: [hostname] }],
      rules: [{
        host: hostname,
        http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: serviceName, port: { number: GATEWAY_PORT } } } }] },
      }],
    },
  };
}

function applyBodyFromObserved(
  observed: JsonRecord,
  context: LifecycleContext,
): JsonRecord {
  const body = structuredClone(observed);
  delete body.status;
  const metadata = requireRecord(body.metadata, "resource metadata");
  for (const key of [
    "creationTimestamp",
    "deletionGracePeriodSeconds",
    "deletionTimestamp",
    "generation",
    "managedFields",
    "resourceVersion",
    "selfLink",
    "uid",
  ]) delete metadata[key];
  metadata.labels = {
    ...recordOrEmpty(metadata.labels),
    ...ownedLabels(context),
  };
  metadata.annotations = {
    ...recordOrEmpty(metadata.annotations),
    ...ownedAnnotations(context),
  };
  return body;
}

function containsDesiredState(observed: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, index) => containsDesiredState(observed[index], item));
  }
  if (desired && typeof desired === "object") {
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
      return false;
    }
    return Object.entries(desired).every(([key, value]) =>
      containsDesiredState((observed as JsonRecord)[key], value),
    );
  }
  return Object.is(observed, desired);
}

async function applyOwned(context: LifecycleContext, manifest: JsonRecord): Promise<Observation> {
  context.signal?.throwIfAborted();
  const kind = requireString(manifest, "kind");
  const metadata = requireRecord(manifest.metadata, `${kind} metadata`);
  const name = requireString(metadata, "name");
  const path = objectPath(context, kind, name);
  const current = await context.kubernetes.get(path, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (current) {
    assertOwned(current, context, kind, name);
    if (containsDesiredState(current, manifest)) {
      const ref = resourceRef(roleForKindAndName(kind, name), name, current);
      return observation(ref, "unchanged", kind, current);
    }
  }
  const applied = await requireObject(
    context.kubernetes.apply(path, manifest, FIELD_MANAGER, { signal: context.signal }),
    `${kind} apply response`,
  );
  const ref = resourceRef(roleForKindAndName(kind, name), name, applied);
  return observation(ref, current ? "updated" : "created", kind, applied);
}

async function ensureManagerBinding(context: LifecycleContext) {
  const name = "kestrel-environment-manager";
  const path = `/apis/rbac.authorization.k8s.io/v1/namespaces/${context.namespace}/rolebindings/${name}`;
  const existing = await context.kubernetes.get(path, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (existing) {
    assertOwned(existing, context, "RoleBinding", name);
    const roleRef = requireRecord(existing.roleRef, "RoleBinding roleRef");
    const subjects = existing.subjects;
    if (
      roleRef.kind !== "ClusterRole" ||
      roleRef.name !== name ||
      !Array.isArray(subjects) ||
      subjects.length !== 1 ||
      recordValue(subjects[0], "kind") !== "ServiceAccount" ||
      recordValue(subjects[0], "name") !== "kestrel-connector" ||
      recordValue(subjects[0], "namespace") !== context.connectorNamespace
    ) throw conflict(`RoleBinding ${name} is not the fixed connector binding.`);
    return;
  }
  await context.kubernetes.create(
    `/apis/rbac.authorization.k8s.io/v1/namespaces/${context.namespace}/rolebindings`,
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name, namespace: context.namespace, labels: ownedLabels(context), annotations: ownedAnnotations(context) },
      subjects: [{ kind: "ServiceAccount", name: "kestrel-connector", namespace: context.connectorNamespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name },
    },
    { signal: context.signal },
  );
}

async function copyPullSecret(context: LifecycleContext) {
  const name = context.profile.pullSecretRef!;
  const source = await requireObject(
    context.kubernetes.get(
      `/api/v1/namespaces/${context.connectorNamespace}/secrets/${name}`,
      { signal: context.signal },
    ),
    "Source pull Secret",
  );
  const type = requireString(source, "type");
  const data = requireRecord(source.data, "source pull Secret data");
  await applyOwned(context, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: ownedMetadata(context, name),
    type,
    data,
  });
}

async function assertSingleWriter(
  context: LifecycleContext,
  claimName: string,
  desiredDeploymentName: string,
) {
  const deployments = await listItems(
    context,
    `/apis/apps/v1/namespaces/${context.namespace}/deployments`,
    "Deployment",
  );
  const consumers = deployments.filter((deployment) => deploymentClaim(deployment) === claimName);
  for (const deployment of consumers) {
    const name = metadataName(deployment);
    if (!isOwned(deployment, context)) {
      throw conflict(`Customer-owned Deployment ${name} references workspace PVC ${claimName}.`);
    }
    if (name !== desiredDeploymentName) {
      throw conflict(`Managed Deployment ${name} already writes workspace PVC ${claimName}.`);
    }
  }
  const pods = await listItems(
    context,
    `/api/v1/namespaces/${context.namespace}/pods`,
    "Pod",
  );
  for (const pod of pods.filter((candidate) => podClaim(candidate) === claimName)) {
    const owner = label(pod, "app.kubernetes.io/managed-by");
    const compute = label(pod, "kestrel.dev/compute-name");
    if (owner !== MANAGED_BY) {
      throw conflict(`Customer-owned Pod ${metadataName(pod)} references workspace PVC ${claimName}.`);
    }
    if (compute !== desiredDeploymentName) {
      throw conflict(`Managed Pod ${metadataName(pod)} overlaps workspace PVC ${claimName}.`);
    }
  }
}

async function assertNoPvcConsumers(context: LifecycleContext, claimName: string) {
  const [deployments, pods] = await Promise.all([
    listItems(context, `/apis/apps/v1/namespaces/${context.namespace}/deployments`, "Deployment"),
    listItems(context, `/api/v1/namespaces/${context.namespace}/pods`, "Pod"),
  ]);
  if (deployments.some((item) => deploymentClaim(item) === claimName) || pods.some((item) => podClaim(item) === claimName)) {
    throw conflict(`Workspace PVC ${claimName} still has compute consumers.`);
  }
}

async function scaleDeploymentToZero(context: LifecycleContext, name: string) {
  const current = await getDeployment(context, name);
  assertOwned(current, context, "Deployment", name);
  if (Number(recordValue(current, "spec.replicas") ?? 0) !== 0) {
    await requireObject(
      context.kubernetes.strategicMergePatch(
        deploymentPath(context, name),
        { spec: { replicas: 0 } },
        { signal: context.signal },
      ),
      "Deployment scale response",
    );
  }
  await waitForNoPods(context, name);
}

async function waitForNoPods(context: LifecycleContext, computeNameValue: string) {
  const selector = encodeURIComponent(`kestrel.dev/compute-name=${computeNameValue}`);
  await context.kubernetes.waitFor(
    `/api/v1/namespaces/${context.namespace}/pods?labelSelector=${selector}`,
    (value) => {
      const items = recordValue(value, "items");
      if (!Array.isArray(items)) throw invalidResponse("Pod list has no items array.");
      return items.length === 0;
    },
    waitOptions(context, 120),
  );
}

async function waitDeployment(
  context: LifecycleContext,
  name: string,
  replicas: number,
  timeoutSeconds = 180,
) {
  await context.kubernetes.waitFor(
    deploymentPath(context, name),
    (value) => {
      if (!value) return false;
      const failure = conditions(requireRecord(value, "Deployment")).find(
        (condition) => condition.type === "ReplicaFailure" && condition.status === "True",
      );
      if (failure) throw new KubernetesLifecycleError(
        "RESOURCE_UNHEALTHY",
        `Deployment ${name} reported ${failure.reason ?? "ReplicaFailure"}.`,
        false,
      );
      return Number(recordValue(value, "status.readyReplicas") ?? 0) >= replicas;
    },
    waitOptions(context, timeoutSeconds),
  );
}

async function waitPvcBound(context: LifecycleContext, name: string) {
  return requireObject(
    await context.kubernetes.waitFor(
      pvcPath(context, name),
      (value) => recordValue(value, "status.phase") === "Bound",
      waitOptions(context, 180),
    ),
    "PVC wait response",
  );
}

async function waitSnapshot(context: LifecycleContext, name: string) {
  return requireObject(
    await context.kubernetes.waitFor(
      snapshotPath(context, name),
      (value) => {
        const error = recordValue(value, "status.error.message");
        if (typeof error === "string" && error) {
          throw new KubernetesLifecycleError("RESOURCE_UNHEALTHY", "VolumeSnapshot controller reported failure.", false);
        }
        return recordValue(value, "status.readyToUse") === true;
      },
      waitOptions(context, 300),
    ),
    "VolumeSnapshot wait response",
  );
}

async function waitEdgeReady(context: LifecycleContext) {
  await context.kubernetes.waitFor(
    edgePath(context, "gateway"),
    (value) => {
      const observed = value ? requireRecord(value, "edge route") : null;
      if (!observed) return false;
      if (context.profile.edge.mode === "ingress") {
        const endpoints = recordValue(observed, "status.loadBalancer.ingress");
        return Array.isArray(endpoints) && endpoints.some((endpoint) =>
          Boolean(
            optionalString(recordValue(endpoint, "hostname")) ||
            optionalString(recordValue(endpoint, "ip")),
          ),
        );
      }
      const current = conditions(observed);
      const rejected = current.find((item) =>
        item.status === "False" &&
        (item.type === "Accepted" || item.type === "ResolvedRefs"),
      );
      if (rejected) throw new KubernetesLifecycleError(
        "PROVIDER_REJECTED",
        `Edge route was rejected: ${rejected.reason ?? rejected.type}.`,
        false,
      );
      return ["Accepted", "ResolvedRefs"].every((type) =>
        current.some((item) => item.type === type && item.status === "True"),
      );
    },
    waitOptions(context, 180),
  );
}

async function listItems(context: LifecycleContext, path: string, labelName: string) {
  const value = await requireObject(
    context.kubernetes.get(path, { signal: context.signal }),
    `${labelName} list response`,
  );
  if (!Array.isArray(value.items)) throw invalidResponse(`${labelName} list has no items array.`);
  return value.items.map((item) => requireRecord(item, `${labelName} item`));
}

async function deleteOwnedIfPresent(
  context: LifecycleContext,
  kind: string,
  path: string,
) {
  const current = await context.kubernetes.get(path, {
    allowNotFound: true,
    signal: context.signal,
  }) as JsonRecord | null;
  if (!current) return;
  assertOwned(current, context, kind, metadataName(current));
  await context.kubernetes.delete(path, { allowNotFound: true, signal: context.signal });
}

function runtimeConfig(context: LifecycleContext, desired: JsonRecord) {
  const source = requireRecord(desired.source, "workspace source");
  const sourceType = requireString(source, "type");
  const sourceResourceId = optionalString(source.resourceId);
  const sourceRepository = optionalString(source.repository);
  const sourceDefaultBranch = optionalString(source.defaultBranch);
  return {
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: requireString(desired, "ticketPublicKey"),
    KESTREL_CONTROL_PLANE_URL: requireString(desired, "controlPlaneUrl"),
    KESTREL_ORGANIZATION_ID: context.command.organizationId,
    KESTREL_ENVIRONMENT_ID: context.command.environmentId!,
    KESTREL_WORKSPACE_ID: requireWorkspaceId(context),
    KESTREL_ENVIRONMENT_GATEWAY_URL: `http://gateway.${context.namespace}.svc.cluster.local:${GATEWAY_PORT}`,
    KESTREL_WORKSPACE_SOURCE_TYPE: sourceType,
    ...(sourceResourceId ? { KESTREL_WORKSPACE_SOURCE_RESOURCE_ID: sourceResourceId } : {}),
    ...(sourceRepository ? { KESTREL_WORKSPACE_SOURCE_REPOSITORY: sourceRepository } : {}),
    ...(sourceDefaultBranch ? { KESTREL_WORKSPACE_SOURCE_DEFAULT_BRANCH: sourceDefaultBranch } : {}),
    KESTREL_IDLE_TIMEOUT_MINUTES: String(requireNumber(desired, "idleTimeoutMinutes")),
  };
}

function computeOutput(
  context: LifecycleContext,
  deployment: JsonRecord,
  desired?: JsonRecord,
  serviceTokenHash?: string,
) {
  const image = optionalString(recordValue(deployment, "spec.template.spec.containers.0.image"));
  const replicas = Number(recordValue(deployment, "spec.replicas") ?? 0);
  return {
    state: replicas === 0 ? "stopped" : Number(recordValue(deployment, "status.readyReplicas") ?? 0) > 0 ? "started" : "starting",
    placement: placement(context),
    image: image ?? null,
    resolvedImageDigest: image ?? null,
    cpuKind: "standard",
    cpus: 2,
    memoryMb: 4096,
    workspaceId: context.command.workspaceId ?? null,
    ...(serviceTokenHash ? { serviceTokenHash } : {}),
    conditions: conditions(deployment),
    ...(desired ? {} : {}),
  };
}

function placement(context: LifecycleContext) {
  const supplied = context.payload.placement;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) return supplied;
  return {
    connectionId: context.command.connectionId,
    requested: null,
    observed: null,
  };
}

function success(
  phase: string,
  detail: string,
  resources: ResourceRef[],
  observations: Observation[],
  output: JsonRecord,
): Execution {
  return { phase, detail, resources, observations, output };
}

function observation(
  resource: ResourceRef,
  disposition: Observation["disposition"],
  kind: string,
  object: JsonRecord,
): Observation {
  const uid = optionalString(recordValue(object, "metadata.uid"));
  const generation = recordValue(object, "metadata.generation");
  return {
    resource,
    disposition,
    ...(uid ? { providerUid: uid } : {}),
    ...(generation === undefined ? {} : { observedGeneration: String(generation) }),
    kind,
    ...(optionalString(recordValue(object, "metadata.namespace"))
      ? { namespace: String(recordValue(object, "metadata.namespace")) }
      : {}),
    conditions: conditions(object),
  };
}

function resourceRef(
  role: ResourceRef["role"],
  externalId: string,
  object?: JsonRecord,
): ResourceRef {
  const generation = object ? recordValue(object, "metadata.generation") : undefined;
  return {
    provider: "kubernetes",
    role,
    externalId,
    ...(generation === undefined ? {} : { observedGeneration: String(generation) }),
  };
}

function roleForKindAndName(kind: string, name: string): ResourceRef["role"] {
  if (kind === "Namespace") return "environment_scope";
  if (kind === "PersistentVolumeClaim") return "workspace_storage";
  if (kind === "VolumeSnapshot") return "snapshot";
  if (kind === "HTTPRoute" || kind === "Ingress") return "edge_route";
  if (kind === "Deployment" && name === "gateway") return "gateway";
  return "workspace_compute";
}

function roleFromObject(object: JsonRecord): ResourceRef["role"] | null {
  const role = label(object, "kestrel.dev/resource-role");
  const normalized = role?.replace(/-/gu, "_");
  return normalized && [
    "environment_scope", "gateway", "workspace_compute", "workspace_storage", "snapshot", "edge_route",
  ].includes(normalized) ? normalized as ResourceRef["role"] : null;
}

function namespaceFor(profile: ConnectorKubernetesProfile, environmentId: string) {
  return assertKubernetesName(`${profile.namespacePrefix}-env-${shortHash(environmentId)}`);
}

function storageName(workspaceId: string, replacementId?: string) {
  return assertKubernetesName(`ws-${shortHash(workspaceId)}-pvc${replacementId ? `-${shortHash(replacementId)}` : ""}`);
}

function computeName(workspaceId: string, replacementId?: string) {
  return assertKubernetesName(`ws-${shortHash(workspaceId)}${replacementId ? `-${shortHash(replacementId)}` : ""}`);
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function namespaceLabels(context: LifecycleContext) {
  return {
    ...ownedLabels(context),
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  };
}

function ownedLabels(context: LifecycleContext) {
  return {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "app.kubernetes.io/part-of": "kestrel-environment",
    "kestrel.dev/organization-id-hash": shortHash(context.command.organizationId),
    "kestrel.dev/environment-id": context.command.environmentId!,
    ...(context.command.workspaceId ? { "kestrel.dev/workspace-id": context.command.workspaceId } : {}),
    "kestrel.dev/desired-revision": shortHash(context.command.desiredRevision),
  };
}

function selectorLabels(
  context: LifecycleContext,
  role: "gateway" | "workspace-compute",
  computeNameValue?: string,
) {
  return {
    "kestrel.dev/environment-id": context.command.environmentId!,
    "kestrel.dev/resource-role": role,
    ...(context.command.workspaceId ? { "kestrel.dev/workspace-id": context.command.workspaceId } : {}),
    ...(computeNameValue ? { "kestrel.dev/compute-name": computeNameValue } : {}),
  };
}

function ownedAnnotations(context: LifecycleContext) {
  return {
    "kestrel.dev/desired-revision-sha256": context.command.desiredRevision,
    "kestrel.dev/connection-id": context.command.connectionId,
  };
}

function ownedMetadata(context: LifecycleContext, name: string) {
  return {
    name,
    namespace: context.namespace,
    labels: {
      ...ownedLabels(context),
      "kestrel.dev/resource-role": metadataRole(name),
      ...(optionalString(context.payload.replacementId)
        ? { "kestrel.dev/replacement-id": optionalString(context.payload.replacementId)! }
        : {}),
    },
    annotations: ownedAnnotations(context),
  };
}

function metadataRole(name: string) {
  if (name === "gateway" || name.startsWith("gateway-")) return "gateway";
  if (name.includes("pvc")) return "workspace-storage";
  if (name.startsWith("snap-")) return "snapshot";
  return "workspace-compute";
}

function assertOwned(object: JsonRecord, context: LifecycleContext, kind: string, name: string) {
  if (!isOwned(object, context)) {
    throw conflict(`${kind} ${name} exists without matching Kestrel ownership.`);
  }
}

function isOwned(object: JsonRecord, context: LifecycleContext) {
  return (
    label(object, "app.kubernetes.io/managed-by") === MANAGED_BY &&
    label(object, "kestrel.dev/organization-id-hash") ===
      shortHash(context.command.organizationId) &&
    label(object, "kestrel.dev/environment-id") === context.command.environmentId &&
    annotation(object, "kestrel.dev/connection-id") ===
      context.command.connectionId &&
    (!context.command.workspaceId ||
      label(object, "kestrel.dev/workspace-id") === context.command.workspaceId)
  );
}

function requireScope(context: LifecycleContext) {
  const scope = requireResource(context.payload.scope, "environment_scope");
  if (scope.externalId !== context.namespace) {
    throw conflict("Environment scope does not match its deterministic namespace.");
  }
}

function requireWorkspaceId(context: LifecycleContext) {
  if (!context.command.workspaceId) throw invalidResponse("Workspace identity is missing.");
  return context.command.workspaceId;
}

function requireResource(value: unknown, role: ResourceRef["role"]): ResourceRef {
  const resource = requireRecord(value, `${role} resource reference`);
  if (resource.provider !== "kubernetes" || resource.role !== role) {
    throw conflict(`Expected a Kubernetes ${role} resource reference.`);
  }
  return {
    provider: "kubernetes",
    role,
    externalId: requireString(resource, "externalId"),
    ...(optionalString(resource.observedGeneration)
      ? { observedGeneration: optionalString(resource.observedGeneration)! }
      : {}),
  };
}

function optionalResource(value: unknown) {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "resource reference");
  return requireResource(record, requireString(record, "role") as ResourceRef["role"]);
}

function decryptSecrets(command: ConnectorCommand, identity: ConnectorIdentity) {
  if (!command.encryptedSecrets) return {};
  const envelope = parseConnectorCommandSecrets(command.encryptedSecrets);
  const value = decryptConnectorCommandSecrets<Record<string, string>>({
    envelope,
    recipientPrivateKey: identity.encryptionPrivateKey,
    commandId: command.id,
  });
  return Object.fromEntries(
    Object.entries(value).map(([key, secretValue]) => [key, requireNonemptySecret(secretValue, key)]),
  );
}

function requireSecret(context: LifecycleContext, key: string) {
  const value = context.secrets[key];
  if (!value) throw new KubernetesLifecycleError("PROVIDER_REJECTED", `Encrypted ${key} is required.`, false);
  return value;
}

function requireNonemptySecret(value: unknown, key: string) {
  if (typeof value !== "string" || !value) throw new Error(`Encrypted ${key} is invalid.`);
  return value;
}

function objectPath(context: LifecycleContext, kind: string, name: string) {
  const encoded = encodeURIComponent(name);
  switch (kind) {
    case "ServiceAccount": return serviceAccountPath(context, encoded);
    case "Secret": return secretPath(context, encoded);
    case "Service": return servicePath(context, encoded);
    case "ResourceQuota": return `/api/v1/namespaces/${context.namespace}/resourcequotas/${encoded}`;
    case "LimitRange": return `/api/v1/namespaces/${context.namespace}/limitranges/${encoded}`;
    case "PersistentVolumeClaim": return pvcPath(context, encoded);
    case "Deployment": return deploymentPath(context, encoded);
    case "NetworkPolicy": return `/apis/networking.k8s.io/v1/namespaces/${context.namespace}/networkpolicies/${encoded}`;
    case "VolumeSnapshot": return snapshotPath(context, encoded);
    case "HTTPRoute": return `/apis/gateway.networking.k8s.io/v1/namespaces/${context.namespace}/httproutes/${encoded}`;
    case "Ingress": return `/apis/networking.k8s.io/v1/namespaces/${context.namespace}/ingresses/${encoded}`;
    default: throw new Error(`Unsupported managed Kubernetes kind ${kind}.`);
  }
}

function deploymentPath(context: LifecycleContext, name: string) {
  return `/apis/apps/v1/namespaces/${context.namespace}/deployments/${encodeURIComponent(name)}`;
}
function servicePath(context: LifecycleContext, name: string) {
  return `/api/v1/namespaces/${context.namespace}/services/${encodeURIComponent(name)}`;
}
function secretPath(context: LifecycleContext, name: string) {
  return `/api/v1/namespaces/${context.namespace}/secrets/${encodeURIComponent(name)}`;
}
function serviceAccountPath(context: LifecycleContext, name: string) {
  return `/api/v1/namespaces/${context.namespace}/serviceaccounts/${encodeURIComponent(name)}`;
}
function pvcPath(context: LifecycleContext, name: string) {
  return `/api/v1/namespaces/${context.namespace}/persistentvolumeclaims/${encodeURIComponent(name)}`;
}
function snapshotPath(context: LifecycleContext, name: string) {
  return `/apis/snapshot.storage.k8s.io/v1/namespaces/${context.namespace}/volumesnapshots/${encodeURIComponent(name)}`;
}
function edgePath(context: LifecycleContext, name: string) {
  return `${edgeCollectionPath(context)}/${encodeURIComponent(name)}`;
}
function edgeCollectionPath(context: LifecycleContext) {
  return context.profile.edge.mode === "gateway_api"
    ? `/apis/gateway.networking.k8s.io/v1/namespaces/${context.namespace}/httproutes`
    : `/apis/networking.k8s.io/v1/namespaces/${context.namespace}/ingresses`;
}

async function getDeployment(context: LifecycleContext, name: string) {
  return requireObject(
    context.kubernetes.get(deploymentPath(context, name), { signal: context.signal }),
    `Deployment ${name}`,
  );
}

function deploymentClaim(deployment: JsonRecord) {
  const volumes = recordValue(deployment, "spec.template.spec.volumes");
  if (!Array.isArray(volumes)) return null;
  for (const volume of volumes) {
    const claim = recordValue(volume, "persistentVolumeClaim.claimName");
    if (typeof claim === "string" && claim) return claim;
  }
  return null;
}

function podClaim(pod: JsonRecord) {
  const volumes = recordValue(pod, "spec.volumes");
  if (!Array.isArray(volumes)) return null;
  for (const volume of volumes) {
    const claim = recordValue(volume, "persistentVolumeClaim.claimName");
    if (typeof claim === "string" && claim) return claim;
  }
  return null;
}

function assertExactRwo(pvcValue: JsonRecord, name: string) {
  const modes = recordValue(pvcValue, "spec.accessModes");
  if (!Array.isArray(modes) || modes.length !== 1 || modes[0] !== "ReadWriteOnce") {
    throw conflict(`PVC ${name} must report exactly ReadWriteOnce.`);
  }
}

function assertDeploymentImage(deployment: JsonRecord, expected: string) {
  if (recordValue(deployment, "spec.template.spec.containers.0.image") !== expected) {
    throw invalidResponse("Deployment did not retain the requested immutable image digest.");
  }
}

function assertEdgeHostname(
  context: LifecycleContext,
  route: JsonRecord,
  expected: string,
) {
  if (context.profile.edge.mode === "gateway_api") {
    const hostnames = recordValue(route, "spec.hostnames");
    if (!Array.isArray(hostnames) || hostnames.length !== 1 || hostnames[0] !== expected) {
      throw invalidResponse("HTTPRoute did not retain the exact Environment hostname.");
    }
    return;
  }
  const ruleHost = recordValue(route, "spec.rules.0.host");
  const tlsHosts = recordValue(route, "spec.tls.0.hosts");
  if (
    ruleHost !== expected ||
    !Array.isArray(tlsHosts) ||
    tlsHosts.length !== 1 ||
    tlsHosts[0] !== expected
  ) {
    throw invalidResponse("Ingress did not retain the exact Environment hostname.");
  }
}

function firstContainer(deployment: JsonRecord) {
  const containers = recordValue(deployment, "spec.template.spec.containers");
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw invalidResponse("Workspace Deployment must contain exactly one container.");
  }
  return requireRecord(containers[0], "workspace container");
}

function conditions(value: JsonRecord) {
  let raw = recordValue(value, "status.conditions");
  if (!Array.isArray(raw)) {
    const parents = recordValue(value, "status.parents");
    raw = Array.isArray(parents)
      ? parents.flatMap((parent) => {
          const parentConditions = recordValue(parent, "conditions");
          return Array.isArray(parentConditions) ? parentConditions : [];
        })
      : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const condition = item as JsonRecord;
    const type = optionalString(condition.type);
    const status = optionalString(condition.status);
    if (!(type && status)) return [];
    return [{
      type,
      status,
      ...(optionalString(condition.reason) ? { reason: optionalString(condition.reason)! } : {}),
      ...(optionalString(condition.message) ? { message: optionalString(condition.message)!.slice(0, 500) } : {}),
    }];
  });
}

function metadataName(value: JsonRecord) {
  return requireString(requireRecord(value.metadata, "metadata"), "name");
}

function label(value: JsonRecord, key: string) {
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const labels = (metadata as JsonRecord).labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
  return optionalString((labels as JsonRecord)[key]);
}

function annotation(value: JsonRecord, key: string) {
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const annotations = (metadata as JsonRecord).annotations;
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) return undefined;
  return optionalString((annotations as JsonRecord)[key]);
}

function recordValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function requireRecord(value: unknown, labelValue: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${labelValue} is invalid.`);
  }
  return value as JsonRecord;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

async function requireObject(value: unknown | Promise<unknown>, labelValue: string) {
  return requireRecord(await value, labelValue);
}

function requireString(record: JsonRecord, key: string) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(`${key} is invalid.`);
  return value.trim();
}

function requireNumber(record: JsonRecord, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse(`${key} is invalid.`);
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function waitOptions(context: LifecycleContext, timeoutSeconds: number) {
  return {
    timeoutMs: timeoutSeconds * 1000,
    signal: context.signal,
  };
}

function conflict(message: string) {
  return new KubernetesLifecycleError("RESOURCE_CONFLICT", message, false);
}

function invalidResponse(message: string) {
  return new KubernetesLifecycleError("RESPONSE_INVALID", message, false);
}

function unsupported(type: ConnectorCommandType): never {
  throw new KubernetesLifecycleError("CAPABILITY_UNSUPPORTED", `Unsupported lifecycle command ${String(type)}.`, false);
}

function normalizeLifecycleError(error: unknown) {
  if (error instanceof KubernetesLifecycleError) return error;
  if (error instanceof KubernetesApiError) {
    if (error.status >= 200 && error.status < 300) {
      return new KubernetesLifecycleError("RESPONSE_INVALID", error.message, false, error);
    }
    if (error.status === 403 || error.status === 401) {
      return new KubernetesLifecycleError("PROVIDER_REJECTED", error.message, false, error);
    }
    if (error.status === 409) {
      return new KubernetesLifecycleError("RESOURCE_CONFLICT", error.message, false, error);
    }
    if (error.status === 429 || error.status >= 500 || error.status === 0) {
      return new KubernetesLifecycleError("PROVIDER_UNAVAILABLE", error.message, true, error);
    }
    return new KubernetesLifecycleError("PROVIDER_REJECTED", error.message, false, error);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new KubernetesLifecycleError("PROVIDER_UNAVAILABLE", "Connector command lease was lost.", true);
  }
  if (error instanceof KubernetesWaitTimeoutError) {
    return new KubernetesLifecycleError("OPERATION_TIMEOUT", error.message, true);
  }
  if (error instanceof KubernetesDiscoveryError) {
    return new KubernetesLifecycleError("RESPONSE_INVALID", error.message, false);
  }
  return new KubernetesLifecycleError(
    "PROVIDER_REJECTED",
    (error instanceof Error ? error.message : "Kubernetes lifecycle command failed.")
      .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
      .slice(0, 500),
    false,
  );
}

export const kubernetesLifecycleInternals = {
  namespaceFor,
  storageName,
  computeName,
  shortHash,
};
