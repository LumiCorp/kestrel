import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrivateBackend,
  createGatewayRouteGeneration,
  requireQualifiedRouterUrl,
} from "./routing-authority";

const compute = {
  id: "compute-resource-1",
  externalId: "workspace-1",
  desiredRevision: "sha256:image",
};

test("provider builders emit exact active private DNS identities", () => {
  assert.deepEqual(buildPrivateBackend({
    provider: "fly",
    flyAppName: "kestrel-env-1",
    scopeExternalId: "unused",
    compute: { ...compute, externalId: "machine-1" },
  }), {
    kind: "private_dns",
    hostname: "machine-1.vm.kestrel-env-1.internal",
    port: 43_104,
    computeResourceId: "compute-resource-1",
    desiredRevision: "sha256:image",
  });
  assert.deepEqual(buildPrivateBackend({
    provider: "kubernetes",
    flyAppName: null,
    scopeExternalId: "kestrel-env-a",
    compute,
  }), {
    kind: "private_dns",
    hostname: "workspace-1.kestrel-env-a.svc.cluster.local",
    port: 43_104,
    computeResourceId: "compute-resource-1",
    desiredRevision: "sha256:image",
  });
  for (const externalId of ["127.0.0.1", "UPPER", "service/path", "service.example"]) {
    assert.throws(() => buildPrivateBackend({
      provider: "kubernetes",
      flyAppName: null,
      scopeExternalId: "kestrel-env-a",
      compute: { ...compute, externalId },
    }));
  }
});

test("route generations are deterministic and exclude rotating grants", () => {
  const first = createGatewayRouteGeneration({
    gatewayId: "gateway-resource-1",
    workspaces: [
      { id: "workspace-b", backend: buildPrivateBackend({
        provider: "kubernetes", flyAppName: null, scopeExternalId: "namespace", compute: { ...compute, id: "compute-b", externalId: "service-b" },
      }) },
      { id: "workspace-a", backend: buildPrivateBackend({
        provider: "kubernetes", flyAppName: null, scopeExternalId: "namespace", compute: { ...compute, id: "compute-a", externalId: "service-a" },
      }) },
    ],
  });
  const reordered = createGatewayRouteGeneration({
    gatewayId: "gateway-resource-1",
    workspaces: [
      { id: "workspace-a", backend: buildPrivateBackend({
        provider: "kubernetes", flyAppName: null, scopeExternalId: "namespace", compute: { ...compute, id: "compute-a", externalId: "service-a" },
      }) },
      { id: "workspace-b", backend: buildPrivateBackend({
        provider: "kubernetes", flyAppName: null, scopeExternalId: "namespace", compute: { ...compute, id: "compute-b", externalId: "service-b" },
      }) },
    ],
  });
  assert.equal(first, reordered);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

test("Router origins are provider-qualified and contain no URL authority tricks", () => {
  assert.equal(requireQualifiedRouterUrl({
    provider: "fly",
    environmentId: "environment-1",
    flyAppName: "kestrel-env-1",
    routerUrl: "https://kestrel-env-1.fly.dev",
    configuration: {
      contract: "fly-connection-configuration-v1",
      organizationSlug: null,
    },
  }), "https://kestrel-env-1.fly.dev");
  for (const routerUrl of [
    "http://kestrel-env-1.fly.dev",
    "https://kestrel-env-1.fly.dev:8443",
    "https://user@kestrel-env-1.fly.dev",
    "https://kestrel-env-1.fly.dev/path",
    "https://kestrel-env-1.fly.dev.evil.example",
    "https://127.0.0.1",
  ]) {
    assert.throws(() => requireQualifiedRouterUrl({
      provider: "fly",
      environmentId: "environment-1",
      flyAppName: "kestrel-env-1",
      routerUrl,
      configuration: {
        contract: "fly-connection-configuration-v1",
        organizationSlug: null,
      },
    }));
  }
});
