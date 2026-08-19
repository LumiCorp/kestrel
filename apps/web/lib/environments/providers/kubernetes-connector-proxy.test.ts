import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptConnectorCommandSecrets,
  generateConnectorCredentialEncryptionKeyPair,
  parseConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import {
  KubernetesConnectorInfrastructureProviderV2,
  type KubernetesConnectorProxyDependencies,
} from "./kubernetes-connector-proxy";
import type { InfrastructureConnectorCommandV1 } from "./connector-contracts";

const profile = {
  contract: "kubernetes-byoc-profile-v1",
  selectedCertificationProfile: "gke-gateway-v1",
  namespacePrefix: "kestrel",
  baseDomain: "byoc.example.test",
  storageClassName: "standard-rwo",
  volumeSnapshotClassName: "snapshots",
  controllerNamespace: "gateway-system",
  controllerPodSelector: { app: "gateway" },
  pullSecretRef: null,
  encryptionAttestations: {
    persistentVolumes: { encryption: "provider_attested", evidenceRef: "attestation:pv" },
    kubernetesSecrets: { encryption: "provider_attested", evidenceRef: "attestation:secrets" },
  },
  edge: { mode: "gateway_api", parentNamespace: "gateway-system", parentName: "shared" },
  platform: {
    distribution: "gke",
    computeProfile: "standard",
    networkPolicyProvider: "gke_dataplane_v2",
    storageCsiDriver: "pd.csi.storage.gke.io",
    snapshotCsiDriver: "pd.csi.storage.gke.io",
    edgeController: "gke_gateway",
  },
} as const;

test("proxy deterministically reattaches, encrypts command-bound secrets, and persists observations", async () => {
  const keys = generateConnectorCredentialEncryptionKeyPair();
  const commands: InfrastructureConnectorCommandV1[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const dependencies = {
    async enqueue(input: { command: InfrastructureConnectorCommandV1 }) {
      commands.push(input.command);
      return {} as never;
    },
    async read(input: { commandId: string }) {
      const command = commands.find((item) => item.id === input.commandId)!;
      return {
        status: "completed",
        result: {
          contract: "infrastructure-connector-result-v1" as const,
          commandId: command.id,
          connectionId: command.connectionId,
          commandType: command.type,
          status: "succeeded" as const,
          observedRevision: command.desiredRevision,
          resources: [
            { provider: "kubernetes" as const, role: "gateway" as const, externalId: "gateway" },
            { provider: "kubernetes" as const, role: "edge_route" as const, externalId: "gateway" },
          ],
          evidence: [{ level: "implementation" as const, phase: "gateway.ready" }],
          output: {
            state: "started",
            routerUrl: "https://052abf5dd623.byoc.example.test",
            placement: { connectionId: "connection-1", requested: null, observed: null },
            serviceTokenHash: "x".repeat(43),
            resourceObservations: [{
              resource: { provider: "kubernetes" as const, role: "gateway" as const, externalId: "gateway" },
              disposition: "created" as const,
              providerUid: "uid-gateway",
              observedGeneration: "1",
              kind: "Deployment",
            }],
          },
        },
      } as never;
    },
    async upsert(input: Record<string, unknown>) { writes.push(input); return {} as never; },
    async list() { return [] as never; },
    async tombstone() { return null as never; },
    async sleep() {},
  } as unknown as KubernetesConnectorProxyDependencies;
  const provider = new KubernetesConnectorInfrastructureProviderV2({
    operationId: "operation-1",
    organizationId: "organization-1",
    environmentId: "environment-1",
    connectionId: "connection-1",
    connectorEncryptionPublicKey: keys.publicKey,
    configuration: {
      contract: "kubernetes-connection-config-v1",
      displayName: "GKE",
      isDefault: true,
      profile,
      runtimeTemplateAllowlist: ["kestrel-standard-v1"],
      qualificationProbeImage: `registry.example/probe@sha256:${"a".repeat(64)}`,
      attestationEvidenceNote: "Customer attestation",
    },
    workspaceLimit: 4,
    runtimeTemplate: "kestrel-standard-v1",
  }, dependencies);

  const invoke = () => provider.ensureEnvironmentGateway({
    identity: { organizationId: "organization-1", environmentId: "environment-1" },
    scope: { provider: "kubernetes", role: "environment_scope", externalId: "kestrel-abc" },
    placement: { connectionId: "connection-1", requested: null, observed: null },
    runtimeImage: `registry.example/router@sha256:${"b".repeat(64)}`,
    ticketPublicKey: "p".repeat(32),
    controlPlaneUrl: "https://control.example.test",
    serviceToken: "super-secret-service-token",
  });
  await invoke();
  await invoke();

  assert.equal(commands[0]!.id, commands[1]!.id);
  assert.equal(commands[0]!.idempotencyKey, commands[1]!.idempotencyKey);
  assert.equal(JSON.stringify(commands[0]).includes("super-secret-service-token"), false);
  const decrypted = decryptConnectorCommandSecrets<{ serviceToken: string }>({
    envelope: parseConnectorCommandSecrets(commands[0]!.encryptedSecrets!),
    recipientPrivateKey: keys.privateKey,
    commandId: commands[0]!.id,
  });
  assert.equal(decrypted.serviceToken, "super-secret-service-token");
  assert.throws(() => decryptConnectorCommandSecrets({
    envelope: parseConnectorCommandSecrets(commands[0]!.encryptedSecrets!),
    recipientPrivateKey: keys.privateKey,
    commandId: "another-command",
  }));
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.providerUid, "uid-gateway");
});
