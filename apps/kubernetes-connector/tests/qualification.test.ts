import assert from "node:assert/strict";
import test from "node:test";
import { runQualification } from "../src/qualification.js";

const verbs = ["get", "list", "create", "patch", "delete", "bind"];
const discovery: Record<string, string[]> = {
  "/api/v1": ["namespaces", "services", "secrets", "configmaps", "serviceaccounts", "resourcequotas", "limitranges", "persistentvolumeclaims", "pods", "nodes"],
  "/apis/apps/v1": ["deployments", "replicasets", "statefulsets", "daemonsets"],
  "/apis/batch/v1": ["jobs", "cronjobs"],
  "/apis/rbac.authorization.k8s.io/v1": ["roles", "rolebindings"],
  "/apis/networking.k8s.io/v1": ["networkpolicies", "ingresses"],
  "/apis/storage.k8s.io/v1": ["storageclasses"],
  "/apis/snapshot.storage.k8s.io/v1": ["volumesnapshots", "volumesnapshotclasses"],
  "/apis/gateway.networking.k8s.io/v1": ["httproutes", "gateways"],
};

function fixture(input: {
  missingResource?: string;
  publicProbe?: boolean;
  pvcAccessModes?: Partial<Record<"probe" | "restore-probe", unknown>>;
  lingeringProbePod?: boolean;
  denyListResource?: string;
  onApply?: (path: string, body: Record<string, unknown>) => void;
  onEvent?: (
    event: "apply" | "delete" | "deployment_absent" | "pods_absent" | "pvc_observed",
    path: string,
  ) => void;
} = {}) {
  const namespaces = new Set<string>();
  const deployments = new Set<string>();
  const pvcs = new Map<string, Record<string, unknown>>();
  let probePodPresent = false;
  const kubernetes = {
    async get(path: string, options?: { allowNotFound?: boolean }) {
      if (path === "/version") return { gitVersion: "v1.33.0-gke.100" };
      if (path === "/apis") {
        return {
          groups: Object.keys(discovery)
            .filter((discoveryPath) => discoveryPath.startsWith("/apis/"))
            .map((discoveryPath) => {
              const groupVersion = discoveryPath.slice("/apis/".length);
              return { preferredVersion: { groupVersion } };
            }),
        };
      }
      if (discovery[path]) {
        return {
          resources: discovery[path]
            .filter((resource) => resource !== input.missingResource)
            .map((name) => ({
              name,
              kind: name.replace(/(^|[-.])([a-z])/gu, (_match, _separator, letter: string) => letter.toUpperCase()),
              namespaced: ![
                "namespaces",
                "nodes",
                "storageclasses",
                "volumesnapshotclasses",
              ].includes(name),
              verbs,
            })),
        };
      }
      if (path.includes("/storageclasses/")) return { provisioner: "pd.csi.storage.gke.io" };
      if (path.includes("/volumesnapshotclasses/")) return { driver: "pd.csi.storage.gke.io" };
      if (path.includes("/gateways/")) return { metadata: { name: "shared-gateway" } };
      if (path.includes("/namespaces/gke-managed-system/pods?")) return { items: [{ metadata: { name: "controller" } }] };
      const pvcName = path.match(/\/persistentvolumeclaims\/(probe|restore-probe)$/u)?.[1] as "probe" | "restore-probe" | undefined;
      if (pvcName) {
        const applied = pvcs.get(path) ?? {};
        const appliedSpec = applied.spec as Record<string, unknown> | undefined;
        const hasOverride = Object.prototype.hasOwnProperty.call(
          input.pvcAccessModes ?? {},
          pvcName,
        );
        input.onEvent?.("pvc_observed", path);
        return {
          ...applied,
          spec: {
            ...appliedSpec,
            accessModes: hasOverride
              ? input.pvcAccessModes?.[pvcName]
              : appliedSpec?.accessModes,
          },
        };
      }
      const namespace = path.match(/^\/api\/v1\/namespaces\/([^/?]+)$/u)?.[1];
      if (namespace) return namespaces.has(namespace) ? { metadata: { name: namespace } } : options?.allowNotFound ? null : null;
      if (path.includes("/rolebindings/") && options?.allowNotFound) return null;
      return {};
    },
    async create(path: string, body: { kind?: string; metadata?: { name?: string } }) {
      if (path.endsWith("selfsubjectaccessreviews")) {
        const attributes = (body as {
          spec?: { resourceAttributes?: { resource?: unknown; verb?: unknown } };
        }).spec?.resourceAttributes;
        return {
          status: {
            allowed: !(
              attributes?.verb === "list" &&
              attributes.resource === input.denyListResource
            ),
          },
        };
      }
      if (body.kind === "Namespace" && body.metadata?.name) namespaces.add(body.metadata.name);
      return body;
    },
    async apply(path: string, body: Record<string, unknown>) {
      if (body.kind === "PersistentVolumeClaim") pvcs.set(path, body);
      if (body.kind === "Deployment") {
        deployments.add(path);
        if (path.endsWith("/deployments/probe")) probePodPresent = true;
      }
      input.onApply?.(path, body);
      input.onEvent?.("apply", path);
      return {};
    },
    async delete(path: string) {
      deployments.delete(path);
      if (
        path.endsWith("/deployments/probe") &&
        input.lingeringProbePod !== true
      ) {
        probePodPresent = false;
      }
      input.onEvent?.("delete", path);
      const namespace = path.match(/^\/api\/v1\/namespaces\/([^/?]+)$/u)?.[1];
      if (namespace) namespaces.delete(namespace);
      return {};
    },
    async waitFor(path: string, predicate: (value: unknown | null) => boolean) {
      let value: unknown | null;
      if (path.includes("volumesnapshots")) {
        value = { status: { readyToUse: true } };
      } else if (path.includes("quota-probe")) {
        value = { status: { conditions: [{ type: "ReplicaFailure", status: "True" }] } };
      } else if (path.includes("/pods?labelSelector=app%3Dprobe")) {
        value = { items: probePodPresent ? [{ metadata: { name: "probe-pod" } }] : [] };
        if (!probePodPresent) input.onEvent?.("pods_absent", path);
      } else if (path.startsWith("/api/v1/namespaces/")) {
        value = null;
      } else if (path.includes("/deployments/") && !deployments.has(path)) {
        input.onEvent?.("deployment_absent", path);
        value = null;
      } else {
        value = { status: { readyReplicas: 1 } };
      }
      if (!predicate(value)) {
        throw new Error(`Kubernetes wait timed out for ${path}.`);
      }
      return value;
    },
  };
  const controlPlane = {
    async provePublicEndpoint() { return { passed: input.publicProbe !== false }; },
  };
  return { kubernetes, controlPlane };
}

const profile = {
  contract: "kubernetes-byoc-profile-v1",
  selectedCertificationProfile: "gke-gateway-v1",
  namespacePrefix: "kestrel",
  baseDomain: "byoc.example.test",
  storageClassName: "standard-rwo",
  volumeSnapshotClassName: "pd-snapshots",
  controllerNamespace: "gke-managed-system",
  controllerPodSelector: { app: "gateway-controller" },
  pullSecretRef: null,
  encryptionAttestations: {},
  edge: { mode: "gateway_api", parentNamespace: "kestrel-edge", parentName: "shared-gateway" },
  platform: { distribution: "gke", computeProfile: "standard", networkPolicyProvider: "gke_dataplane_v2", storageCsiDriver: "pd.csi.storage.gke.io", snapshotCsiDriver: "pd.csi.storage.gke.io", edgeController: "gke_gateway" },
};

async function qualify(overrides: Parameters<typeof fixture>[0] = {}) {
  const runId = crypto.randomUUID();
  const { kubernetes, controlPlane } = fixture(overrides);
  return runQualification({
    commandPayload: {
      runId,
      configurationRevision: "a".repeat(64),
      profile,
      probeImage: `example/probe@sha256:${"b".repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    connectionId: crypto.randomUUID(),
    kubernetes: kubernetes as never,
    controlPlane: controlPlane as never,
    identity: { connectionId: crypto.randomUUID() } as never,
    connectorNamespace: "kestrel-system",
  });
}

test("qualification proves every ordered capability and cleans both namespaces", async () => {
  const applied: Array<{ path: string; body: Record<string, unknown> }> = [];
  const events: Array<{
    event: "apply" | "delete" | "deployment_absent" | "pods_absent" | "pvc_observed";
    path: string;
  }> = [];
  const report = await qualify({
    onApply: (path, body) => applied.push({ path, body }),
    onEvent: (event, path) => events.push({ event, path }),
  });
  assert.equal(report.observed.distribution, "gke");
  assert.equal(report.checks.every((check) => check.status === "passed"), true);
  assert.equal(report.cleanup.status, "passed");
  assert.match(
    report.checks.find((check) => check.id === "active.pvc_persistence")?.detail ?? "",
    /ReadWriteOnce/u,
  );
  assert.match(
    report.checks.find((check) => check.id === "active.snapshot_restore")?.detail ?? "",
    /ReadWriteOnce/u,
  );
  const quota = applied.find(({ path }) => path.includes("/resourcequotas/"));
  assert.deepEqual(
    (quota?.body.spec as { hard?: unknown } | undefined)?.hard,
    {
      pods: "4",
      "requests.cpu": "2",
      "requests.memory": "2Gi",
      "limits.cpu": "4",
      "limits.memory": "4Gi",
    },
  );
  assert.equal(
    applied.some(
      ({ path, body }) =>
        path.includes("-peer/serviceaccounts/probe") &&
        body.kind === "ServiceAccount" &&
        body.automountServiceAccountToken === false,
    ),
    true,
  );
  const pvcs = applied.filter(({ body }) => body.kind === "PersistentVolumeClaim");
  assert.equal(pvcs.length, 3);
  for (const pvc of pvcs) {
    assert.deepEqual(
      (pvc.body.spec as { accessModes?: unknown } | undefined)?.accessModes,
      ["ReadWriteOnce"],
    );
  }
  assert.equal(JSON.stringify(applied).includes("ReadWriteOncePod"), false);
  assert.deepEqual(
    events
      .filter(({ event }) => event === "pvc_observed")
      .map(({ path }) => path.split("/").at(-1)),
    ["probe", "restore-probe"],
  );
  const probeDeploymentPath = events.find(
    ({ event, path }) =>
      event === "delete" && path.endsWith("/deployments/probe"),
  )?.path;
  assert.ok(probeDeploymentPath);
  assert.deepEqual(
    events
      .filter(
        ({ event, path }) =>
          path === probeDeploymentPath || event === "pods_absent",
      )
      .map(({ event }) => event),
    ["apply", "delete", "deployment_absent", "pods_absent", "apply"],
  );
});

for (const [label, accessModes] of [
  ["ReadWriteOncePod", ["ReadWriteOncePod"]],
  ["mixed modes", ["ReadWriteOnce", "ReadOnlyMany"]],
  ["missing modes", undefined],
  ["malformed modes", "ReadWriteOnce"],
] as const) {
  test(`qualification rejects an original PVC with ${label}`, async () => {
    const report = await qualify({ pvcAccessModes: { probe: accessModes } });
    assert.equal(
      report.checks.find((check) => check.id === "active.pvc_persistence")?.status,
      "failed",
    );
    assert.equal(
      report.checks.find((check) => check.id === "active.snapshot_restore")?.status,
      "not_run",
    );
    assert.equal(report.cleanup.status, "passed");
  });
}

test("qualification rejects a restored PVC with the wrong access mode", async () => {
  const report = await qualify({
    pvcAccessModes: { "restore-probe": ["ReadWriteMany"] },
  });
  assert.equal(
    report.checks.find((check) => check.id === "active.pvc_persistence")?.status,
    "passed",
  );
  assert.equal(
    report.checks.find((check) => check.id === "active.snapshot_restore")?.status,
    "failed",
  );
  assert.equal(report.cleanup.status, "passed");
});

test("qualification never recreates compute while a probe Pod remains", async () => {
  const applied: Array<{ path: string; body: Record<string, unknown> }> = [];
  const report = await qualify({
    lingeringProbePod: true,
    onApply: (path, body) => applied.push({ path, body }),
  });
  assert.equal(
    report.checks.find((check) => check.id === "active.pvc_persistence")?.status,
    "failed",
  );
  assert.equal(
    report.checks.find((check) => check.id === "active.snapshot_restore")?.status,
    "not_run",
  );
  assert.equal(
    applied.filter(({ path }) => path.endsWith("/deployments/probe")).length,
    1,
  );
  assert.equal(report.cleanup.status, "passed");
});

test("missing API discovery blocks mutation and still records cleanup", async () => {
  const report = await qualify({ missingResource: "services" });
  assert.equal(report.checks.find((check) => check.id === "discovery.resources")?.status, "failed");
  assert.equal(report.checks.find((check) => check.id === "active.baseline")?.status, "not_run");
  assert.equal(report.cleanup.status, "passed");
});

test("qualification rejects missing read access for discovered customer resource kinds", async () => {
  const report = await qualify({ denyListResource: "replicasets" });
  assert.equal(
    report.checks.find((check) => check.id === "active.baseline")?.status,
    "failed",
  );
  assert.equal(
    report.checks.find((check) => check.id === "active.image_pull_and_schedule")?.status,
    "not_run",
  );
});

test("public DNS or TLS failure prevents dependent network and quota claims", async () => {
  const report = await qualify({ publicProbe: false });
  assert.equal(report.checks.find((check) => check.id === "active.public_dns_tls")?.status, "failed");
  assert.equal(report.checks.find((check) => check.id === "active.allowed_network_paths")?.status, "not_run");
  assert.equal(report.cleanup.status, "passed");
});
