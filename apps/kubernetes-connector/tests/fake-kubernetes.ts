type JsonRecord = Record<string, unknown>;

export class FakeKubernetesApi {
  readonly requests: Array<{ method: string; path: string; body?: JsonRecord }> = [];
  readonly resources = new Map<string, JsonRecord>();
  private generation = 0;
  private readonly discovery = new Map<string, JsonRecord>([
    ["/api/v1", resourceList([
      ["services", "Service"],
      ["serviceaccounts", "ServiceAccount"],
      ["secrets", "Secret"],
      ["configmaps", "ConfigMap"],
      ["resourcequotas", "ResourceQuota"],
      ["limitranges", "LimitRange"],
      ["persistentvolumeclaims", "PersistentVolumeClaim"],
      ["pods", "Pod"],
    ])],
    ["/apis/apps/v1", resourceList([
      ["deployments", "Deployment"],
      ["replicasets", "ReplicaSet"],
      ["statefulsets", "StatefulSet"],
      ["daemonsets", "DaemonSet"],
    ])],
    ["/apis/batch/v1", resourceList([["jobs", "Job"], ["cronjobs", "CronJob"]])],
    ["/apis/rbac.authorization.k8s.io/v1", resourceList([["roles", "Role"], ["rolebindings", "RoleBinding"]])],
    ["/apis/networking.k8s.io/v1", resourceList([["networkpolicies", "NetworkPolicy"], ["ingresses", "Ingress"]])],
    ["/apis/discovery.k8s.io/v1", resourceList([["endpointslices", "EndpointSlice"]])],
    ["/apis/snapshot.storage.k8s.io/v1", resourceList([["volumesnapshots", "VolumeSnapshot"]])],
    ["/apis/gateway.networking.k8s.io/v1", resourceList([["httproutes", "HTTPRoute"]])],
  ]);

  async get(path: string, options: { allowNotFound?: boolean } = {}) {
    this.requests.push({ method: "GET", path });
    if (path === "/apis") {
      return {
        groups: [...this.discovery.keys()]
          .filter((discoveryPath) => discoveryPath.startsWith("/apis/"))
          .map((discoveryPath) => ({
            preferredVersion: { groupVersion: discoveryPath.slice("/apis/".length) },
          })),
      };
    }
    const discovery = this.discovery.get(withoutQuery(path));
    if (discovery) return structuredClone(discovery);
    const collection = collectionForList(path);
    if (collection) {
      const selector = new URL(path, "https://kubernetes.test").searchParams.get(
        "labelSelector",
      );
      const items = [...this.resources.entries()]
        .filter(([key]) => key.startsWith(collection))
        .map(([, value]) => structuredClone(value))
        .filter((value) => selectorMatches(value, selector));
      return { apiVersion: "v1", kind: "List", items };
    }
    const value = this.resources.get(withoutQuery(path));
    if (value) return structuredClone(value);
    return options.allowNotFound ? null : null;
  }

  async create(path: string, body: JsonRecord) {
    this.requests.push({ method: "POST", path, body: structuredClone(body) });
    const target = resourcePath(path, body);
    return this.store(target, body);
  }

  async apply(path: string, body: JsonRecord) {
    this.requests.push({ method: "PATCH", path, body: structuredClone(body) });
    const target = withoutQuery(path);
    const current = this.resources.get(target);
    return this.store(target, current ? merge(current, body) : body);
  }

  async strategicMergePatch(path: string, body: JsonRecord) {
    this.requests.push({ method: "PATCH", path, body: structuredClone(body) });
    const target = withoutQuery(path);
    const current = this.resources.get(target);
    if (!current) throw new Error(`Cannot patch absent fake resource ${target}.`);
    return this.store(target, strategicMerge(current, body));
  }

  async delete(path: string) {
    this.requests.push({ method: "DELETE", path });
    this.resources.delete(withoutQuery(path));
    return {};
  }

  async waitFor(
    path: string,
    predicate: (value: unknown | null) => boolean,
  ) {
    const value = await this.get(path, { allowNotFound: true });
    if (!predicate(value)) throw new Error(`Fake Kubernetes condition did not advance for ${path}.`);
    return value;
  }

  set(path: string, value: JsonRecord) {
    this.resources.set(withoutQuery(path), structuredClone(value));
  }

  addDiscoveryResource(groupVersion: string, resource: string, kind: string) {
    const path = `/apis/${groupVersion}`;
    const current = this.discovery.get(path) ?? resourceList([]);
    const resources = current.resources as JsonRecord[];
    resources.push(apiResource(resource, kind));
    this.discovery.set(path, current);
  }

  private store(path: string, input: JsonRecord) {
    this.generation += 1;
    const body = structuredClone(input);
    const metadata = body.metadata as JsonRecord;
    metadata.uid ??= `uid-${this.generation}`;
    metadata.generation = this.generation;
    if (body.kind === "PersistentVolumeClaim") body.status = { phase: "Bound" };
    if (body.kind === "Deployment") {
      const replicas = Number((body.spec as JsonRecord).replicas ?? 1);
      body.status = { readyReplicas: replicas };
    }
    if (body.kind === "VolumeSnapshot") body.status = { readyToUse: true };
    if (body.kind === "HTTPRoute") {
      body.status = {
        parents: [{
          conditions: [
            { type: "Accepted", status: "True" },
            { type: "ResolvedRefs", status: "True" },
          ],
        }],
      };
    }
    if (body.kind === "Ingress") {
      body.status = { loadBalancer: { ingress: [{ hostname: "edge.example.test" }] } };
    }
    this.resources.set(path, body);
    return structuredClone(body);
  }
}

function withoutQuery(path: string) {
  return path.split("?", 1)[0]!;
}

function collectionForList(path: string) {
  const base = withoutQuery(path);
  if (/\/namespaces\/[^/]+\/[^/]+$/u.test(base)) {
    return `${base}/`;
  }
  return null;
}

function resourceList(resources: Array<[string, string]>): JsonRecord {
  return {
    resources: resources.map(([resource, kind]) => apiResource(resource, kind)),
  };
}

function apiResource(resource: string, kind: string): JsonRecord {
  return {
    name: resource,
    kind,
    namespaced: true,
    verbs: ["get", "list", "delete", "deletecollection"],
  };
}

function selectorMatches(value: JsonRecord, selector: string | null) {
  if (!selector) return true;
  const labels = (value.metadata as JsonRecord | undefined)?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return false;
  return selector.split(",").every((clause) => {
    const separator = clause.indexOf("=");
    if (separator < 1) return false;
    const key = clause.slice(0, separator);
    const expected = clause.slice(separator + 1);
    return (labels as JsonRecord)[key] === expected;
  });
}

function resourcePath(collection: string, body: JsonRecord) {
  const metadata = body.metadata as JsonRecord;
  return `${withoutQuery(collection)}/${String(metadata.name)}`;
}

function merge(left: JsonRecord, right: JsonRecord): JsonRecord {
  const merged: JsonRecord = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])
    ) merged[key] = merge(merged[key] as JsonRecord, value as JsonRecord);
    else merged[key] = structuredClone(value);
  }
  return merged;
}

function strategicMerge(left: JsonRecord, right: JsonRecord): JsonRecord {
  const merged: JsonRecord = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    if (Array.isArray(value) && Array.isArray(existing) && value.every(hasName)) {
      const patches = new Map(value.map((item) => [String(item.name), item]));
      merged[key] = existing.map((item) => {
        if (!hasName(item)) return structuredClone(item);
        const patch = patches.get(String(item.name));
        return patch
          ? strategicMerge(item, patch)
          : structuredClone(item);
      });
      for (const item of value) {
        if (!existing.some((candidate) => hasName(candidate) && candidate.name === item.name)) {
          (merged[key] as unknown[]).push(structuredClone(item));
        }
      }
    } else if (
      value && typeof value === "object" && !Array.isArray(value) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
    ) {
      merged[key] = strategicMerge(existing as JsonRecord, value as JsonRecord);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function hasName(value: unknown): value is JsonRecord & { name: string } {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as JsonRecord).name === "string",
  );
}
