import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorIdentity } from "../src/identity.js";
import {
  KubernetesClient,
  KubernetesApiError,
  KubernetesWaitTimeoutError,
} from "../src/kubernetes-client.js";
import {
  executeLifecycleCommand,
  kubernetesLifecycleInternals,
} from "../src/lifecycle.js";
import type { ConnectorCommand, ConnectorCommandType } from "../src/contracts.js";
import { FakeKubernetesApi } from "./fake-kubernetes.js";

const digest = `registry.example/kestrel@sha256:${"a".repeat(64)}`;
const profile = {
  contract: "kubernetes-byoc-profile-v1",
  selectedCertificationProfile: "gke-gateway-v1",
  namespacePrefix: "kestrel",
  baseDomain: "byoc.example.test",
  storageClassName: "standard-rwo",
  volumeSnapshotClassName: "snapshots",
  controllerNamespace: "gateway-system",
  controllerPodSelector: { app: "gateway-controller" },
  pullSecretRef: null,
  encryptionAttestations: {
    persistentVolumes: {
      encryption: "provider_attested",
      evidenceRef: "attestation:pv",
    },
  },
  edge: {
    mode: "gateway_api",
    parentNamespace: "gateway-system",
    parentName: "shared-gateway",
  },
  platform: {
    distribution: "gke",
    computeProfile: "standard",
    networkPolicyProvider: "gke_dataplane_v2",
    storageCsiDriver: "pd.csi.storage.gke.io",
    snapshotCsiDriver: "pd.csi.storage.gke.io",
    edgeController: "gke_gateway",
  },
} as const;
const identity = {} as ConnectorIdentity;
const scope = {
  provider: "kubernetes" as const,
  role: "environment_scope" as const,
  externalId: kubernetesLifecycleInternals.namespaceFor(profile, "environment-1"),
};
const placement = {
  connectionId: "connection-1",
  requested: null,
  observed: null,
};

test("scope and storage manifests lock ownership, Restricted policy, quota, NetworkPolicy, and RWO", async () => {
  const fake = new FakeKubernetesApi();
  const scopeResult = await execute(fake, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });
  assert.equal(scopeResult.status, "succeeded");

  const storageResult = await execute(fake, "ensure_workspace_storage", {
    scope,
    placement,
    sizeGb: 20,
  }, "workspace-1");
  assert.equal(storageResult.status, "succeeded");

  const bodies = fake.requests.flatMap((request) => request.body ? [request.body] : []);
  const namespace = bodies.find((body) => body.kind === "Namespace")!;
  assert.equal((namespace.metadata as Record<string, unknown>).labels && ((namespace.metadata as { labels: Record<string, string> }).labels["pod-security.kubernetes.io/enforce"]), "restricted");
  assert.ok(bodies.some((body) => body.kind === "ResourceQuota"));
  assert.equal(bodies.filter((body) => body.kind === "NetworkPolicy").length, 3);
  const pvc = bodies.find((body) => body.kind === "PersistentVolumeClaim")!;
  assert.deepEqual((pvc.spec as Record<string, unknown>).accessModes, ["ReadWriteOnce"]);
  assert.deepEqual((pvc.spec as { resources: { requests: { storage: string } } }).resources.requests.storage, "20Gi");
  assert.ok(bodies.every((body) => JSON.stringify(body).includes("ReadWriteOncePod") === false));
  assert.ok(fake.requests.filter((request) => request.method === "PATCH").every((request) => request.path.includes("force=true") === false));
});

test("scope reconciliation repairs weakened Pod Security labels without force", async () => {
  const fake = new FakeKubernetesApi();
  await execute(fake, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });
  const namespacePath = `/api/v1/namespaces/${scope.externalId}`;
  const namespace = fake.resources.get(namespacePath)!;
  (namespace.metadata as { labels: Record<string, string> }).labels[
    "pod-security.kubernetes.io/enforce"
  ] = "privileged";
  fake.set(namespacePath, namespace);

  const result = await execute(fake, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });

  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(
    ((fake.resources.get(namespacePath)!.metadata as { labels: Record<string, string> }).labels)[
      "pod-security.kubernetes.io/enforce"
    ],
    "restricted",
  );
  assert.ok(fake.requests.some((request) =>
    request.method === "PATCH" && request.path === namespacePath
  ));
});

test("workspace compute uses an immutable digest, Recreate, Restricted settings, and no service-account token", async () => {
  const fake = new FakeKubernetesApi();
  const storageName = kubernetesLifecycleInternals.storageName("workspace-1");
  const result = await execute(fake, "ensure_workspace_compute", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: storageName },
    placement,
    desired: {
      runtimeImage: digest,
      ticketPublicKey: "x".repeat(32),
      controlPlaneUrl: "https://control.example.test",
      serviceTokenHash: "A".repeat(43),
      source: {
        type: "github",
        resourceId: "repository-resource-1",
        repository: "https://example.test/org/repository.git",
        defaultBranch: "main",
      },
      idleTimeoutMinutes: 15,
    },
  }, "workspace-1", { secrets: { serviceToken: "workspace-token" } });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  const deployment = fake.requests.flatMap((request) => request.body ? [request.body] : []).find((body) => body.kind === "Deployment")!;
  const spec = deployment.spec as Record<string, unknown>;
  assert.deepEqual(spec.strategy, { type: "Recreate" });
  const pod = (spec.template as { spec: Record<string, unknown> }).spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual((pod.securityContext as { seccompProfile: unknown }).seccompProfile, { type: "RuntimeDefault" });
  const container = (pod.containers as Array<Record<string, unknown>>)[0]!;
  assert.equal(container.image, digest);
  assert.deepEqual((container.securityContext as { capabilities: unknown }).capabilities, { drop: ["ALL"] });
  const secrets = fake.requests
    .flatMap((request) => request.body ? [request.body] : [])
    .filter((body) => body.kind === "Secret");
  const decoded = (body: Record<string, unknown>) => Object.fromEntries(
    Object.entries(body.data as Record<string, string>)
      .map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")]),
  );
  const config = decoded(secrets.find((body) =>
    (body.metadata as { name: string }).name.endsWith("-config")
  )!);
  assert.deepEqual(config, {
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: "x".repeat(32),
    KESTREL_CONTROL_PLANE_URL: "https://control.example.test",
    KESTREL_ORGANIZATION_ID: "organization-1",
    KESTREL_ENVIRONMENT_ID: "environment-1",
    KESTREL_WORKSPACE_ID: "workspace-1",
    KESTREL_ENVIRONMENT_GATEWAY_URL: `http://gateway.${scope.externalId}.svc.cluster.local:43116`,
    KESTREL_WORKSPACE_SOURCE_TYPE: "github",
    KESTREL_WORKSPACE_SOURCE_RESOURCE_ID: "repository-resource-1",
    KESTREL_WORKSPACE_SOURCE_REPOSITORY: "https://example.test/org/repository.git",
    KESTREL_WORKSPACE_SOURCE_DEFAULT_BRANCH: "main",
    KESTREL_IDLE_TIMEOUT_MINUTES: "15",
  });
  const tokenSecret = decoded(secrets.find((body) =>
    (body.metadata as { name: string }).name.endsWith("-token")
  )!);
  assert.deepEqual(tokenSecret, { KESTREL_WORKSPACE_SERVICE_TOKEN: "workspace-token" });
  assert.equal(JSON.stringify(secrets).includes("KESTREL_ENVIRONMENT_SERVICE_TOKEN"), false);
  assert.equal(JSON.stringify(secrets).includes("SOURCE_JSON"), false);
});

test("another managed writer and a customer-owned PVC consumer fail deterministically", async () => {
  for (const managed of [true, false]) {
    const fake = new FakeKubernetesApi();
    const storageName = kubernetesLifecycleInternals.storageName("workspace-1");
    fake.set(`${scopePath()}/deployments/other`, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "other",
        labels: managed ? {
          "app.kubernetes.io/managed-by": "kestrel-connector",
          "kestrel.dev/organization-id-hash": kubernetesLifecycleInternals.shortHash("organization-1"),
          "kestrel.dev/environment-id": "environment-1",
        } : {},
        annotations: managed ? {
          "kestrel.dev/connection-id": "connection-1",
        } : {},
      },
      spec: {
        replicas: managed ? 0 : 1,
        template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: storageName } }] } },
      },
    });
    const result = await execute(fake, "ensure_workspace_compute", {
      scope,
      storage: { provider: "kubernetes", role: "workspace_storage", externalId: storageName },
      placement,
      desired: {
        runtimeImage: digest,
        ticketPublicKey: "x".repeat(32),
        controlPlaneUrl: "https://control.example.test",
        source: { type: "blank" },
        idleTimeoutMinutes: 15,
      },
    }, "workspace-1");
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "RESOURCE_CONFLICT");
  }
});

test("image updates prove zero Pod overlap before applying the next immutable digest", async () => {
  const fake = new FakeKubernetesApi();
  const compute = kubernetesLifecycleInternals.computeName("workspace-1");
  const storage = kubernetesLifecycleInternals.storageName("workspace-1");
  const deploymentPath = `${scopePath()}/deployments/${compute}`;
  fake.set(deploymentPath, ownedDeployment({ compute, storage, image: digest }));
  const configPath = `/api/v1/namespaces/${scope.externalId}/secrets/${compute}-config`;
  fake.set(configPath, {
    ...ownedObject("Secret", `${compute}-config`, "workspace-1"),
    data: {
      KESTREL_CONTROL_PLANE_URL: Buffer.from("https://old.example.test").toString("base64"),
    },
  });
  const nextDigest = `registry.example/kestrel@sha256:${"d".repeat(64)}`;

  const result = await execute(fake, "update_workspace_image", {
    scope,
    compute: { provider: "kubernetes", role: "workspace_compute", externalId: compute },
    runtimeImage: nextDigest,
    environmentPatch: {
      KESTREL_CONTROL_PLANE_URL: "https://control.example.test",
    },
  }, "workspace-1");

  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  const scaleDown = fake.requests.findIndex((request) =>
    request.method === "PATCH" &&
    request.path === deploymentPath &&
    (request.body?.spec as { replicas?: number } | undefined)?.replicas === 0,
  );
  const podsAbsent = fake.requests.findIndex((request, index) =>
    index > scaleDown && request.method === "GET" && request.path.includes("/pods?labelSelector="),
  );
  const scaleUp = fake.requests.findIndex((request, index) =>
    index > podsAbsent &&
    request.method === "PATCH" &&
    request.path === deploymentPath &&
    ((request.body?.spec as {
      template?: { spec?: { containers?: Array<{ image?: string }> } };
    } | undefined)?.template?.spec?.containers?.[0]?.image === nextDigest),
  );
  assert.ok(scaleDown >= 0 && podsAbsent > scaleDown && scaleUp > podsAbsent);
  assert.equal(
    Buffer.from(
      (fake.resources.get(configPath)!.data as Record<string, string>)
        .KESTREL_CONTROL_PLANE_URL!,
      "base64",
    ).toString("utf8"),
    "https://control.example.test",
  );
});

test("unchanged replay performs no apply and owned drift repairs only the changed object", async () => {
  const fake = new FakeKubernetesApi();
  const payload = { workspaceLimit: 4, runtimeTemplate: "kestrel-standard-v1" };
  const first = await execute(fake, "ensure_environment_scope", payload);
  assert.equal(first.status, "succeeded");
  const firstApplyCount = fake.requests.filter((request) => request.method === "PATCH").length;

  const replay = await execute(fake, "ensure_environment_scope", payload);
  assert.equal(replay.status, "succeeded");
  assert.equal(replay.output?.resourceObservations?.[0]?.disposition, "unchanged");
  assert.equal(
    fake.requests.filter((request) => request.method === "PATCH").length,
    firstApplyCount,
  );

  const quotaPath = `/api/v1/namespaces/${scope.externalId}/resourcequotas/kestrel`;
  const drifted = structuredClone(fake.resources.get(quotaPath)!);
  ((drifted.spec as { hard: Record<string, string> }).hard).pods = "999";
  fake.set(quotaPath, drifted);
  const repaired = await execute(fake, "ensure_environment_scope", payload);
  assert.equal(repaired.status, "succeeded");
  const repairRequests = fake.requests.slice().filter((request) =>
    request.method === "PATCH" && request.path === quotaPath,
  );
  assert.equal(repairRequests.length, 2);
  assert.equal(
    ((fake.resources.get(quotaPath)!.spec as { hard: Record<string, string> }).hard).pods,
    "6",
  );
});

test("stop and start retain the full Deployment while enforcing the zero-Pod checkpoint", async () => {
  const fake = new FakeKubernetesApi();
  const compute = kubernetesLifecycleInternals.computeName("workspace-1");
  const storage = kubernetesLifecycleInternals.storageName("workspace-1");
  const path = `${scopePath()}/deployments/${compute}`;
  fake.set(path, ownedDeployment({ compute, storage, image: digest }));
  const payload = {
    scope,
    compute: { provider: "kubernetes" as const, role: "workspace_compute" as const, externalId: compute },
  };

  const stopped = await execute(fake, "stop_workspace_compute", payload, "workspace-1");
  assert.equal(stopped.status, "succeeded", JSON.stringify(stopped.error));
  const stoppedBody = fake.requests.findLast((request) =>
    request.method === "PATCH" && request.path === path,
  )!.body!;
  assert.equal((stoppedBody.spec as { replicas: number }).replicas, 0);
  assert.equal(
    (fake.resources.get(path)!.spec as { template: { spec: { containers: Array<{ image: string }> } } })
      .template.spec.containers[0]!.image,
    digest,
  );
  const appliesAfterStop = fake.requests.filter((request) => request.method === "PATCH").length;
  const repeatedStop = await execute(fake, "stop_workspace_compute", payload, "workspace-1");
  assert.equal(repeatedStop.status, "succeeded");
  assert.equal(
    fake.requests.filter((request) => request.method === "PATCH").length,
    appliesAfterStop,
  );

  const started = await execute(fake, "start_workspace_compute", payload, "workspace-1");
  assert.equal(started.status, "succeeded", JSON.stringify(started.error));
  const startedBody = fake.requests.findLast((request) =>
    request.method === "PATCH" && request.path === path,
  )!.body!;
  assert.equal((startedBody.spec as { replicas: number }).replicas, 1);
  assert.equal(
    (fake.resources.get(path)!.spec as { template: { spec: { containers: Array<{ image: string }> } } })
      .template.spec.containers[0]!.image,
    digest,
  );
  assert.ok(fake.requests.some((request) => request.path.includes("/pods?labelSelector=")));
});

test("live PVC access modes and snapshot readiness fail closed", async () => {
  class WrongAccessModeApi extends FakeKubernetesApi {
    override async apply(path: string, body: Record<string, unknown>) {
      const applied = await super.apply(path, body);
      if (body.kind === "PersistentVolumeClaim") {
        (applied.spec as { accessModes: string[] }).accessModes = ["ReadWriteOncePod"];
        this.set(path, applied);
      }
      return applied;
    }
  }
  const wrongMode = await execute(new WrongAccessModeApi(), "ensure_workspace_storage", {
    scope,
    placement,
    sizeGb: 20,
  }, "workspace-1");
  assert.equal(wrongMode.error?.code, "RESOURCE_CONFLICT");

  const fake = new FakeKubernetesApi();
  const storage = kubernetesLifecycleInternals.storageName("workspace-1");
  await execute(fake, "ensure_workspace_storage", { scope, placement, sizeGb: 20 }, "workspace-1");
  const snapshotName = "snapshot-pending";
  fake.set(
    `/apis/snapshot.storage.k8s.io/v1/namespaces/${scope.externalId}/volumesnapshots/${snapshotName}`,
    ownedObject("VolumeSnapshot", snapshotName, "workspace-1", { readyToUse: false }),
  );
  const pending = await execute(fake, "is_workspace_snapshot_usable", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: storage },
    snapshot: { provider: "kubernetes", role: "snapshot", externalId: snapshotName },
  }, "workspace-1");
  assert.equal(pending.status, "succeeded");
  assert.equal(pending.output?.usable, false);

  class FailedSnapshotApi extends FakeKubernetesApi {
    override async apply(path: string, body: Record<string, unknown>) {
      const applied = await super.apply(path, body);
      if (body.kind === "VolumeSnapshot") {
        applied.status = { readyToUse: false, error: { message: "driver failed" } };
        this.set(path, applied);
      }
      return applied;
    }
  }
  const failedApi = new FailedSnapshotApi();
  await execute(failedApi, "ensure_workspace_storage", { scope, placement, sizeGb: 20 }, "workspace-1");
  const failed = await execute(failedApi, "create_workspace_snapshot", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: storage },
  }, "workspace-1");
  assert.equal(failed.error?.code, "RESOURCE_UNHEALTHY");
});

test("snapshot restore creates a separate RWO replacement PVC with deterministic identity", async () => {
  const fake = new FakeKubernetesApi();
  const sourceStorage = kubernetesLifecycleInternals.storageName("workspace-1");
  const storageResult = await execute(fake, "ensure_workspace_storage", {
    scope,
    placement,
    sizeGb: 20,
  }, "workspace-1");
  assert.equal(storageResult.status, "succeeded");
  const snapshotResult = await execute(fake, "create_workspace_snapshot", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: sourceStorage },
  }, "workspace-1");
  const snapshot = snapshotResult.resources[0]!;
  const replacement = await execute(fake, "create_replacement_workspace_storage", {
    scope,
    placement,
    replacementId: "replacement-1",
    sourceStorage: { provider: "kubernetes", role: "workspace_storage", externalId: sourceStorage },
    snapshot,
  }, "workspace-1");
  assert.equal(replacement.status, "succeeded");
  const replacementPvc = fake.requests.flatMap((request) => request.body ? [request.body] : []).filter((body) => body.kind === "PersistentVolumeClaim").at(-1)!;
  assert.deepEqual((replacementPvc.spec as Record<string, unknown>).accessModes, ["ReadWriteOnce"]);
  assert.deepEqual(
    (replacementPvc.spec as { dataSource: unknown }).dataSource,
    { apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: snapshot.externalId },
  );
  assert.notEqual(replacement.resources[0]?.externalId, sourceStorage);
});

test("Gateway API and Ingress routes use the exact hostname and require external challenge proof", async () => {
  for (const edge of [
    profile.edge,
    { mode: "ingress" as const, ingressClassName: "nginx" },
  ]) {
    const fake = new FakeKubernetesApi();
    const probes: Array<{ url: string; nonce: string }> = [];
    const result = await execute(fake, "ensure_environment_gateway", {
      scope,
      placement,
      runtimeImage: digest,
      ticketPublicKey: "x".repeat(32),
      controlPlaneUrl: "https://control.example.test",
      serviceTokenHash: "h".repeat(43),
    }, undefined, {
      profile: { ...profile, edge },
      provePublicEndpoint: async (input) => {
        probes.push(input);
        return { passed: true };
      },
      secrets: { serviceToken: "gateway-secret" },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(probes.length, 1);
    assert.match(probes[0]!.url, /^https:\/\/[a-f0-9]{12}\.byoc\.example\.test\/health\?nonce=/u);
    const route = fake.requests.flatMap((request) => request.body ? [request.body] : []).find((body) => body.kind === (edge.mode === "gateway_api" ? "HTTPRoute" : "Ingress"));
    assert.ok(route);
  }

  const failed = await execute(new FakeKubernetesApi(), "ensure_environment_gateway", {
    scope,
    placement,
    runtimeImage: digest,
    ticketPublicKey: "x".repeat(32),
    controlPlaneUrl: "https://control.example.test",
    serviceTokenHash: "h".repeat(43),
  }, undefined, {
    provePublicEndpoint: async () => ({ passed: false }),
    secrets: { serviceToken: "gateway-secret" },
  });
  assert.equal(failed.error?.code, "RESOURCE_UNHEALTHY");
});

test("rejected edge conditions stop before public proof", async () => {
  class RejectedRouteApi extends FakeKubernetesApi {
    override async apply(path: string, body: Record<string, unknown>) {
      const applied = await super.apply(path, body);
      if (body.kind === "HTTPRoute") {
        applied.status = {
          parents: [{ conditions: [
            { type: "Accepted", status: "True" },
            { type: "ResolvedRefs", status: "False", reason: "BackendNotFound" },
          ] }],
        };
        this.set(path, applied);
      }
      return applied;
    }
  }
  let proofs = 0;
  const result = await execute(new RejectedRouteApi(), "ensure_environment_gateway", {
    scope,
    placement,
    runtimeImage: digest,
    ticketPublicKey: "x".repeat(32),
    controlPlaneUrl: "https://control.example.test",
    serviceTokenHash: "h".repeat(43),
  }, undefined, {
    provePublicEndpoint: async () => {
      proofs += 1;
      return { passed: true };
    },
    secrets: { serviceToken: "gateway-secret" },
  });
  assert.equal(result.error?.code, "PROVIDER_REJECTED");
  assert.equal(proofs, 0);
});

test("inventory returns authoritative resources once and deletion preserves customer objects", async () => {
  const fake = new FakeKubernetesApi();
  const storage = kubernetesLifecycleInternals.storageName("workspace-1");
  await execute(fake, "ensure_workspace_storage", { scope, placement, sizeGb: 20 }, "workspace-1");
  await execute(fake, "ensure_workspace_compute", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: storage },
    placement,
    desired: {
      runtimeImage: digest,
      ticketPublicKey: "x".repeat(32),
      controlPlaneUrl: "https://control.example.test",
      source: { type: "blank" },
      idleTimeoutMinutes: 15,
    },
  }, "workspace-1");
  const inventory = await execute(fake, "list_environment_resources", { scope });
  assert.equal(inventory.status, "succeeded", JSON.stringify(inventory.error));
  assert.deepEqual(
    inventory.resources.map((resource) => resource.role).sort(),
    ["workspace_compute", "workspace_storage"],
  );

  const deletionApi = new FakeKubernetesApi();
  await execute(deletionApi, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });
  const customerSecretPath = `/api/v1/namespaces/${scope.externalId}/secrets/customer-secret`;
  deletionApi.set(customerSecretPath, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "customer-secret", namespace: scope.externalId },
  });
  const blocked = await execute(deletionApi, "delete_environment_scope", { scope });
  assert.equal(blocked.error?.code, "RESOURCE_CONFLICT");
  assert.ok(deletionApi.resources.has(customerSecretPath));
  assert.equal(
    deletionApi.requests.some((request) =>
      request.method === "DELETE" && request.path === `/api/v1/namespaces/${scope.externalId}`,
    ),
    false,
  );

  const missing = new FakeKubernetesApi();
  const compute = kubernetesLifecycleInternals.computeName("workspace-1");
  const deletedCompute = await execute(missing, "delete_workspace_compute", {
    scope,
    compute: { provider: "kubernetes", role: "workspace_compute", externalId: compute },
  }, "workspace-1");
  const deletedStorage = await execute(missing, "delete_workspace_storage", {
    scope,
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: storage },
  }, "workspace-1");
  assert.equal(deletedCompute.status, "succeeded");
  assert.equal(deletedStorage.status, "succeeded");
});

test("namespace deletion discovers and preserves customer custom resources", async () => {
  const fake = new FakeKubernetesApi();
  await execute(fake, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });
  fake.addDiscoveryResource("widgets.example.test/v1", "widgets", "Widget");
  const widgetPath = `/apis/widgets.example.test/v1/namespaces/${scope.externalId}/widgets/customer-widget`;
  fake.set(widgetPath, {
    apiVersion: "widgets.example.test/v1",
    kind: "Widget",
    metadata: { name: "customer-widget", namespace: scope.externalId },
  });

  const result = await execute(fake, "delete_environment_scope", { scope });

  assert.equal(result.error?.code, "RESOURCE_CONFLICT");
  assert.match(result.error?.message ?? "", /Widget\/customer-widget/u);
  assert.ok(fake.resources.has(widgetPath));
  assert.equal(
    fake.requests.some((request) =>
      request.method === "DELETE" && request.path === `/api/v1/namespaces/${scope.externalId}`
    ),
    false,
  );
});

test("namespace deletion removes a fully owned Environment after complete discovery", async () => {
  const fake = new FakeKubernetesApi();
  await execute(fake, "ensure_environment_scope", {
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  });

  const result = await execute(fake, "delete_environment_scope", { scope });

  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(
    fake.resources.has(`/api/v1/namespaces/${scope.externalId}`),
    false,
  );
});

test("Kubernetes waits pass lease cancellation into the in-flight API request", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const client = Object.create(KubernetesClient.prototype) as KubernetesClient;
  client.get = async (_path, options) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
        once: true,
      });
    });
  };
  const waiting = client.waitFor("/api/v1/namespaces/test", () => false, {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort(new Error("lease lost"));

  await assert.rejects(waiting, /lease lost/u);
  assert.equal(observedSignal, controller.signal);
});

test("Kubernetes status, malformed response, timeout, and lease loss map deterministically", async () => {
  const cases = [
    [new KubernetesApiError(403, "GET pvc", "audit-1", "forbidden"), "PROVIDER_REJECTED", false],
    [new KubernetesApiError(409, "PATCH pvc", "audit-conflict", "conflict"), "RESOURCE_CONFLICT", false],
    [new KubernetesApiError(429, "GET pvc", "audit-2", "throttled", 3), "PROVIDER_UNAVAILABLE", true],
    [new KubernetesApiError(503, "GET pvc", "audit-3", "unavailable"), "PROVIDER_UNAVAILABLE", true],
    [new KubernetesApiError(200, "GET pvc", "audit-4", "invalid JSON"), "RESPONSE_INVALID", false],
    [new KubernetesWaitTimeoutError("PVC"), "OPERATION_TIMEOUT", true],
  ] as const;
  for (const [failure, code, retryable] of cases) {
    const fake = new FakeKubernetesApi();
    fake.get = async () => { throw failure; };
    const result = await execute(fake, "ensure_workspace_storage", {
      scope,
      placement,
      sizeGb: 20,
    }, "workspace-1");
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, retryable);
  }

  const fake = new FakeKubernetesApi();
  const aborted = new AbortController();
  aborted.abort(new Error("lease rejected"));
  const result = await execute(fake, "ensure_workspace_storage", {
    scope,
    placement,
    sizeGb: 20,
  }, "workspace-1", { signal: aborted.signal });
  assert.equal(result.error?.code, "PROVIDER_UNAVAILABLE");
  assert.equal(result.error?.retryable, true);
  assert.equal(fake.requests.some((request) => request.method === "PATCH"), false);
});

async function execute(
  fake: FakeKubernetesApi,
  type: ConnectorCommandType,
  specificPayload: Record<string, unknown>,
  workspaceId?: string,
  options: {
    profile?: typeof profile | (Omit<typeof profile, "edge"> & { edge: { mode: "ingress"; ingressClassName: string } });
    provePublicEndpoint?: (input: { url: string; nonce: string }) => Promise<{ passed?: unknown }>;
    secrets?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  let encryptedSecrets: string | undefined;
  let commandIdentity = identity;
  if (options.secrets) {
    const {
      encryptConnectorCommandSecrets,
      generateConnectorCredentialEncryptionKeyPair,
      serializeConnectorCommandSecrets,
    } = await import("@lumi/kestrel-environment-auth");
    const keys = generateConnectorCredentialEncryptionKeyPair();
    commandIdentity = { encryptionPrivateKey: keys.privateKey } as ConnectorIdentity;
    encryptedSecrets = serializeConnectorCommandSecrets(
      encryptConnectorCommandSecrets({
        value: options.secrets,
        recipientPublicKey: keys.publicKey,
        commandId: `command-${type}`,
      }),
    );
  }
  const command: ConnectorCommand = {
    contract: "infrastructure-connector-command-v1",
    id: `command-${type}`,
    idempotencyKey: `key-${type}`,
    connectionId: "connection-1",
    organizationId: "organization-1",
    environmentId: "environment-1",
    ...(workspaceId ? { workspaceId } : {}),
    desiredRevision: "b".repeat(64),
    type,
    payload: {
      configurationRevision: "c".repeat(64),
      profile: options.profile ?? profile,
      ...specificPayload,
    },
    ...(encryptedSecrets ? { encryptedSecrets } : {}),
  };
  return executeLifecycleCommand({
    command,
    kubernetes: fake as unknown as KubernetesClient,
    identity: commandIdentity,
    connectorNamespace: "kestrel-system",
    provePublicEndpoint: options.provePublicEndpoint,
    signal: options.signal,
  });
}

function scopePath() {
  return `/apis/apps/v1/namespaces/${scope.externalId}`;
}

function ownedDeployment(input: { compute: string; storage: string; image: string }) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: input.compute,
      labels: {
        "app.kubernetes.io/managed-by": "kestrel-connector",
        "kestrel.dev/organization-id-hash": kubernetesLifecycleInternals.shortHash("organization-1"),
        "kestrel.dev/environment-id": "environment-1",
        "kestrel.dev/workspace-id": "workspace-1",
      },
      annotations: {
        "kestrel.dev/connection-id": "connection-1",
        "kestrel.dev/desired-revision-sha256": "b".repeat(64),
      },
    },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [{ name: "workspace", image: input.image }],
          volumes: [{ persistentVolumeClaim: { claimName: input.storage } }],
        },
      },
    },
    status: { readyReplicas: 1 },
  };
}

function ownedObject(
  kind: string,
  name: string,
  workspaceId: string | undefined,
  status?: Record<string, unknown>,
) {
  return {
    apiVersion: "v1",
    kind,
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/managed-by": "kestrel-connector",
        "kestrel.dev/organization-id-hash": kubernetesLifecycleInternals.shortHash("organization-1"),
        "kestrel.dev/environment-id": "environment-1",
        ...(workspaceId ? { "kestrel.dev/workspace-id": workspaceId } : {}),
      },
      annotations: {
        "kestrel.dev/connection-id": "connection-1",
        "kestrel.dev/desired-revision-sha256": "b".repeat(64),
      },
    },
    ...(status ? { status } : {}),
  };
}
