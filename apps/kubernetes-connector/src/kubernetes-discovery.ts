import type { KubernetesClient } from "./kubernetes-client.js";

type JsonRecord = Record<string, unknown>;

export type NamespacedKubernetesResource = {
  group: string;
  version: string;
  groupVersion: string;
  resource: string;
  kind: string;
  collectionPath(namespace: string): string;
};

export class KubernetesDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KubernetesDiscoveryError";
  }
}

export async function discoverDeletableNamespacedResources(
  kubernetes: KubernetesClient,
  signal?: AbortSignal,
) {
  const groupVersions = ["v1", ...await preferredGroupVersions(kubernetes, signal)];
  const discovered: NamespacedKubernetesResource[] = [];
  for (const groupVersion of groupVersions) {
    const path = discoveryPath(groupVersion);
    const response = record(await kubernetes.get(path, { signal }), path);
    const resources = response.resources;
    if (!Array.isArray(resources)) {
      throw new KubernetesDiscoveryError(`${path} omitted API resources.`);
    }
    const [group, version] = splitGroupVersion(groupVersion);
    for (const value of resources) {
      const resource = record(value, `${path} resource`);
      const name = string(resource.name, `${path} resource name`);
      const kind = string(resource.kind, `${path} resource kind`);
      const verbs = resource.verbs;
      if (
        resource.namespaced !== true ||
        name.includes("/") ||
        (name === "events" && (groupVersion === "v1" || group === "events.k8s.io")) ||
        !Array.isArray(verbs) ||
        !verbs.includes("list") ||
        !(verbs.includes("delete") || verbs.includes("deletecollection"))
      ) continue;
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(name)) {
        throw new KubernetesDiscoveryError(`${path} returned an invalid resource name.`);
      }
      discovered.push({
        group,
        version,
        groupVersion,
        resource: name,
        kind,
        collectionPath(namespace) {
          const prefix = group
            ? `/apis/${encodeURIComponent(group)}/${encodeURIComponent(version)}`
            : "/api/v1";
          return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        },
      });
    }
  }
  return discovered.sort((left, right) =>
    `${left.groupVersion}/${left.resource}`.localeCompare(`${right.groupVersion}/${right.resource}`),
  );
}

async function preferredGroupVersions(
  kubernetes: KubernetesClient,
  signal?: AbortSignal,
) {
  const response = record(await kubernetes.get("/apis", { signal }), "/apis");
  if (!Array.isArray(response.groups)) {
    throw new KubernetesDiscoveryError("/apis omitted API groups.");
  }
  return response.groups.map((value) => {
    const group = record(value, "/apis group");
    const preferred = record(group.preferredVersion, "/apis preferredVersion");
    const groupVersion = string(
      preferred.groupVersion,
      "/apis preferredVersion.groupVersion",
    );
    splitGroupVersion(groupVersion);
    return groupVersion;
  });
}

function discoveryPath(groupVersion: string) {
  if (groupVersion === "v1") return "/api/v1";
  const [group, version] = splitGroupVersion(groupVersion);
  return `/apis/${encodeURIComponent(group)}/${encodeURIComponent(version)}`;
}

function splitGroupVersion(groupVersion: string): [string, string] {
  if (groupVersion === "v1") return ["", "v1"];
  const segments = groupVersion.split("/");
  if (
    segments.length !== 2 ||
    !/^[a-z0-9][a-z0-9.-]*$/u.test(segments[0] ?? "") ||
    !/^v[0-9][a-z0-9]*$/u.test(segments[1] ?? "")
  ) {
    throw new KubernetesDiscoveryError("Kubernetes returned an invalid preferred group version.");
  }
  return [segments[0]!, segments[1]!];
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KubernetesDiscoveryError(`${label} is invalid.`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new KubernetesDiscoveryError(`${label} is invalid.`);
  }
  return value.trim();
}
