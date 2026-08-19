import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvironmentProviderCompatibilityError,
  REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
} from "./contracts";
import {
  KubernetesByocDiscoveryClient,
  KubernetesByocProviderError,
  kubernetesByocResourceRequirementsForProfile,
} from "./kubernetes-byoc";
import type { KubernetesByocProfileV1 } from "./kubernetes-byoc-profile";

const KUBERNETES_BYOC_TEST_CONNECTION = {
  namespace: "kestrel-environment",
} as const;

const KUBERNETES_BYOC_TEST_PROFILE = {
  contract: "kubernetes-byoc-profile-v1",
  selectedCertificationProfile: "eks-ingress-v1",
  namespacePrefix: "kestrel",
  baseDomain: "environments.example.test",
  storageClassName: "kestrel-storage",
  volumeSnapshotClassName: "kestrel-snapshots",
  controllerNamespace: "kube-system",
  controllerPodSelector: { "app.kubernetes.io/name": "aws-load-balancer-controller" },
  pullSecretRef: null,
  encryptionAttestations: {
    persistentVolumes: {
      encryption: "provider_attested",
      evidenceRef: "attestation:persistent-volumes",
    },
    kubernetesSecrets: {
      encryption: "provider_attested",
      evidenceRef: "attestation:kubernetes-secrets",
    },
  },
  edge: { mode: "ingress", ingressClassName: "kestrel-ingress" },
  platform: {
    distribution: "eks",
    computeProfile: "managed_nodes",
    networkPolicyProvider: "vpc_cni_network_policy",
    storageCsiDriver: "ebs.csi.aws.com",
    snapshotCsiDriver: "ebs.csi.aws.com",
    edgeController: "aws_load_balancer_controller",
  },
} as const satisfies KubernetesByocProfileV1;

type RecordedRequest = {
  path: string;
  authorization: string | null;
  method: string;
};

test("Kubernetes BYOC discovery admits the exact authorized and configured provider contract", async () => {
  const requests: RecordedRequest[] = [];
  const client = createClient({
    fetchImpl: createDiscoveryFetch({ requests }),
  });

  const compatibility = await client.assertCompatible();

  assert.equal(compatibility.version, "v1.34.1");
  assert.deepEqual(
    compatibility.descriptor.capabilities,
    REQUIRED_ENVIRONMENT_PROVIDER_CAPABILITIES,
  );
  assert.equal(compatibility.descriptor.evidence, "cluster_preflight");
  assert.deepEqual(compatibility.missingRequirements, []);
  assert.deepEqual(compatibility.missingPrerequisites, []);
  assert.deepEqual(compatibility.support, {
    state: "qualified",
    profileId: "eks-ingress-v1",
    reason: "certification_evidence_required",
  });
  assert.equal(
    requests.filter(
      (request) =>
        request.path ===
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
    ).length,
    kubernetesByocResourceRequirementsForProfile(
      KUBERNETES_BYOC_TEST_PROFILE,
    ).reduce(
      (total, requirement) => total + requirement.verbs.length,
      0,
    ),
  );
  assert.ok(
    requests.every(
      (request) => request.authorization === "Bearer cluster-token",
    ),
  );
});

test("Kubernetes BYOC discovery supports the certified GKE Gateway API profile without Ingress fallback", async () => {
  const profile = {
    ...KUBERNETES_BYOC_TEST_PROFILE,
    selectedCertificationProfile: "gke-gateway-v1",
    edge: {
      mode: "gateway_api",
      parentNamespace: "kestrel-edge",
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
  } as const satisfies KubernetesByocProfileV1;
  const requests: RecordedRequest[] = [];
  const compatibility = await createClient({
    profile,
    fetchImpl: createDiscoveryFetch({ profile, requests }),
  }).assertCompatible();

  assert.equal(compatibility.support.state, "qualified");
  assert.ok(
    requests.some((request) =>
      request.path.includes("/gateway.networking.k8s.io/v1/"),
    ),
  );
  assert.ok(
    requests.every((request) => !request.path.includes("/ingressclasses/")),
  );
});

test("Kubernetes BYOC discovery fails closed when snapshot APIs are absent", async () => {
  const client = createClient({
    fetchImpl: createDiscoveryFetch({
      missingGroup: "snapshot.storage.k8s.io/v1",
    }),
  });

  const compatibility = await client.inspectCompatibility();
  assert.deepEqual(
    compatibility.missingRequirements.map((requirement) => ({
      groupVersion: requirement.groupVersion,
      resource: requirement.resource,
      missingVerbs: requirement.missingVerbs,
      deniedVerbs: requirement.deniedVerbs,
    })),
    [
      {
        groupVersion: "snapshot.storage.k8s.io/v1",
        resource: "volumesnapshots",
        missingVerbs: ["get", "list", "create", "patch", "delete"],
        deniedVerbs: [],
      },
      {
        groupVersion: "snapshot.storage.k8s.io/v1",
        resource: "volumesnapshotclasses",
        missingVerbs: ["get", "list"],
        deniedVerbs: [],
      },
    ],
  );
  assert.ok(
    !compatibility.descriptor.capabilities.includes("volume_snapshots"),
  );
  await assert.rejects(
    () => client.assertCompatible(),
    (error) => {
      assert.ok(error instanceof EnvironmentProviderCompatibilityError);
      assert.ok(error.missingCapabilities.includes("volume_snapshots"));
      return true;
    },
  );
});

test("Kubernetes BYOC discovery rejects bearer tokens without an exact required permission", async () => {
  const client = createClient({
    fetchImpl: createDiscoveryFetch({
      deniedOperation: {
        group: "apps",
        resource: "deployments",
        verb: "create",
        namespace: KUBERNETES_BYOC_TEST_CONNECTION.namespace,
      },
    }),
  });

  const compatibility = await client.inspectCompatibility();
  const deployments = compatibility.missingRequirements.find(
    (requirement) => requirement.resource === "deployments",
  );
  assert.deepEqual(deployments?.missingVerbs, []);
  assert.deepEqual(deployments?.deniedVerbs, ["create"]);
  assert.ok(
    !compatibility.descriptor.capabilities.includes("workspace_compute"),
  );
  await assert.rejects(
    () => client.assertCompatible(),
    EnvironmentProviderCompatibilityError,
  );
});

test("Kubernetes BYOC discovery requires each configured infrastructure class", async () => {
  const fixtures = [
    {
      kind: "IngressClass" as const,
      capability: "public_gateway" as const,
      name: KUBERNETES_BYOC_TEST_PROFILE.edge.ingressClassName,
    },
    {
      kind: "StorageClass" as const,
      capability: "persistent_workspace_storage" as const,
      name: KUBERNETES_BYOC_TEST_PROFILE.storageClassName,
    },
    {
      kind: "VolumeSnapshotClass" as const,
      capability: "volume_snapshots" as const,
      name: KUBERNETES_BYOC_TEST_PROFILE.volumeSnapshotClassName,
    },
  ];
  for (const fixture of fixtures) {
    const client = createClient({
      fetchImpl: createDiscoveryFetch({ missingClass: fixture.kind }),
    });

    const compatibility = await client.inspectCompatibility();

    assert.deepEqual(compatibility.missingPrerequisites, [
      {
        capability: fixture.capability,
        kind: fixture.kind,
        name: fixture.name,
        reason: "not_found",
      },
    ]);
    assert.ok(
      !compatibility.descriptor.capabilities.includes(fixture.capability),
    );
  }
});

test("Kubernetes BYOC discovery requires snapshot and storage classes to use the same CSI driver", async () => {
  const client = createClient({
    fetchImpl: createDiscoveryFetch({ snapshotDriver: "other.csi.test" }),
  });

  const compatibility = await client.inspectCompatibility();

  assert.deepEqual(compatibility.missingPrerequisites, [
    {
      capability: "volume_snapshots",
      kind: "VolumeSnapshotClass",
      name: KUBERNETES_BYOC_TEST_PROFILE.volumeSnapshotClassName,
      reason: "driver_mismatch",
    },
  ]);
  assert.ok(
    !compatibility.descriptor.capabilities.includes("volume_snapshots"),
  );
});

test("Kubernetes BYOC discovery does not treat unknown encryption as readiness evidence", async () => {
  const profile = {
    ...KUBERNETES_BYOC_TEST_PROFILE,
    selectedCertificationProfile: null,
    encryptionAttestations: {
      ...KUBERNETES_BYOC_TEST_PROFILE.encryptionAttestations,
      persistentVolumes: { encryption: "unknown", evidenceRef: null },
    },
  } as const satisfies KubernetesByocProfileV1;
  const client = createClient({
    profile,
    fetchImpl: createDiscoveryFetch({ profile }),
  });

  const compatibility = await client.inspectCompatibility();
  assert.ok(
    compatibility.missingPrerequisites.some(
      (requirement) => requirement.kind === "EncryptionAttestation",
    ),
  );
  assert.ok(
    !compatibility.descriptor.capabilities.includes(
      "persistent_workspace_storage",
    ),
  );
  await assert.rejects(
    () => client.assertCompatible(),
    EnvironmentProviderCompatibilityError,
  );
});

test("Kubernetes BYOC discovery preserves an API server path prefix", async () => {
  const requests: RecordedRequest[] = [];
  const pathPrefix = "/k8s/clusters/team-a";
  const client = createClient({
    serverUrl: `https://cluster.example.test${pathPrefix}`,
    fetchImpl: createDiscoveryFetch({ requests, pathPrefix }),
  });

  await client.assertCompatible();

  assert.ok(
    requests.every((request) => request.path.startsWith(`${pathPrefix}/`)),
  );
});

test("Kubernetes BYOC discovery rejects API group substitution", async () => {
  const client = createClient({
    fetchImpl: createDiscoveryFetch({
      groupVersionOverride: {
        requested: "apps/v1",
        returned: "apps/v1beta1",
      },
    }),
  });

  await assert.rejects(
    () => client.inspectCompatibility(),
    (error) => {
      assert.ok(error instanceof KubernetesByocProviderError);
      assert.equal(error.code, "KUBERNETES_RESPONSE_INVALID");
      assert.match(error.message, /apps\/v1beta1.*apps\/v1/u);
      return true;
    },
  );
});

test("Kubernetes BYOC connection input requires a credential-free HTTPS URL", () => {
  assert.throws(
    () =>
      createClient({
        serverUrl: "http://cluster.example.test",
      }),
    (error) =>
      error instanceof KubernetesByocProviderError &&
      error.code === "KUBERNETES_PROVIDER_NOT_CONFIGURED",
  );
  assert.throws(
    () =>
      createClient({
        serverUrl: "https://user:password@cluster.example.test",
      }),
    (error) =>
      error instanceof KubernetesByocProviderError &&
      error.code === "KUBERNETES_PROVIDER_NOT_CONFIGURED",
  );
});

function createClient(input: {
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  profile?: KubernetesByocProfileV1;
}) {
  const profile = input.profile ?? KUBERNETES_BYOC_TEST_PROFILE;
  return new KubernetesByocDiscoveryClient({
    profile,
    ...KUBERNETES_BYOC_TEST_CONNECTION,
    testAuthority: {
      serverUrl: input.serverUrl ?? "https://cluster.example.test",
      bearerToken: "cluster-token",
      fetchImpl: input.fetchImpl ?? createDiscoveryFetch({ profile }),
    },
  });
}

function createDiscoveryFetch(
  options: {
    requests?: RecordedRequest[];
    pathPrefix?: string;
    missingGroup?: string;
    missingClass?: "IngressClass" | "StorageClass" | "VolumeSnapshotClass";
    snapshotDriver?: string;
    deniedOperation?: {
      group: string;
      resource: string;
      verb: string;
      namespace?: string;
    };
    groupVersionOverride?: { requested: string; returned: string };
    profile?: KubernetesByocProfileV1;
  } = {},
): typeof fetch {
  const profile = options.profile ?? KUBERNETES_BYOC_TEST_PROFILE;
  const groupPaths = new Map([
    ["/api/v1", "v1"],
    ["/apis/apps/v1", "apps/v1"],
    ["/apis/networking.k8s.io/v1", "networking.k8s.io/v1"],
    ["/apis/storage.k8s.io/v1", "storage.k8s.io/v1"],
    ["/apis/rbac.authorization.k8s.io/v1", "rbac.authorization.k8s.io/v1"],
    ["/apis/snapshot.storage.k8s.io/v1", "snapshot.storage.k8s.io/v1"],
    ["/apis/gateway.networking.k8s.io/v1", "gateway.networking.k8s.io/v1"],
  ]);
  return (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    options.requests?.push({
      path: url.pathname,
      authorization: headers.get("authorization"),
      method: init?.method ?? "GET",
    });
    const path = options.pathPrefix
      ? url.pathname.slice(options.pathPrefix.length)
      : url.pathname;
    if (path === "/version") {
      return Response.json({ gitVersion: "v1.34.1" });
    }
    if (path === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") {
      const body = JSON.parse(String(init?.body)) as {
        spec: {
          resourceAttributes: {
            group: string;
            resource: string;
            verb: string;
            namespace?: string;
          };
        };
      };
      const attributes = body.spec.resourceAttributes;
      const denied =
        options.deniedOperation !== undefined &&
        attributes.group === options.deniedOperation.group &&
        attributes.resource === options.deniedOperation.resource &&
        attributes.verb === options.deniedOperation.verb &&
        attributes.namespace === options.deniedOperation.namespace;
      return Response.json({ status: { allowed: !denied } });
    }
    if (
      profile.edge.mode === "ingress" &&
      path ===
        `/apis/networking.k8s.io/v1/ingressclasses/${profile.edge.ingressClassName}`
    ) {
      return options.missingClass === "IngressClass"
        ? new Response(null, { status: 404 })
        : Response.json({
            metadata: {
              name: profile.edge.ingressClassName,
            },
            spec: { controller: "example.test/ingress-controller" },
          });
    }
    if (
      profile.edge.mode === "gateway_api" &&
      path ===
        `/apis/gateway.networking.k8s.io/v1/namespaces/${profile.edge.parentNamespace}/gateways/${profile.edge.parentName}`
    ) {
      return options.missingClass === "IngressClass"
        ? new Response(null, { status: 404 })
        : Response.json({
            metadata: {
              namespace: profile.edge.parentNamespace,
              name: profile.edge.parentName,
            },
          });
    }
    if (
      path ===
      `/apis/storage.k8s.io/v1/storageclasses/${profile.storageClassName}`
    ) {
      return options.missingClass === "StorageClass"
        ? new Response(null, { status: 404 })
        : Response.json({
            metadata: {
              name: profile.storageClassName,
            },
            provisioner: profile.platform.storageCsiDriver,
          });
    }
    if (
      path ===
      `/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses/${profile.volumeSnapshotClassName}`
    ) {
      return options.missingClass === "VolumeSnapshotClass"
        ? new Response(null, { status: 404 })
        : Response.json({
            metadata: {
              name: profile.volumeSnapshotClassName,
            },
            driver:
              options.snapshotDriver ?? profile.platform.snapshotCsiDriver,
          });
    }
    const requestedGroupVersion = groupPaths.get(path);
    if (!requestedGroupVersion) return new Response(null, { status: 404 });
    if (requestedGroupVersion === options.missingGroup) {
      return new Response(null, { status: 404 });
    }
    const groupVersion =
      options.groupVersionOverride?.requested === requestedGroupVersion
        ? options.groupVersionOverride.returned
        : requestedGroupVersion;
    const resources = kubernetesByocResourceRequirementsForProfile(
      profile,
    ).filter(
      (requirement) => requirement.groupVersion === requestedGroupVersion,
    ).map((requirement) => ({
      name: requirement.resource,
      verbs: [...requirement.verbs],
    }));
    return Response.json({ groupVersion, resources });
  }) as typeof fetch;
}
