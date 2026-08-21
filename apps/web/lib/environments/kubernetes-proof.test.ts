import assert from "node:assert/strict";
import test from "node:test";
import {
  KUBERNETES_BYOC_PROOF_VERSION,
  kubernetesProofScenarioIds,
  parseKubernetesByocProof,
  redactKubernetesProofIdentifier,
} from "./kubernetes-proof";

const startedAt = "2026-08-19T12:00:00.000Z";
const completedAt = "2026-08-19T12:01:00.000Z";

function validProof(overrides: Record<string, unknown> = {}) {
  return {
    contract: KUBERNETES_BYOC_PROOF_VERSION,
    proofId: "11111111-1111-4111-8111-111111111111",
    recordedAt: completedAt,
    codeRevision: "revision-1",
    profile: "gke",
    evidenceClass: "isolated_provider",
    connectorImageDigest: `sha256:${"a".repeat(64)}`,
    helmChartDigest: `sha256:${"b".repeat(64)}`,
    connectorImageAttestation: { signature: "sigstore:connector", provenance: "slsa:connector" },
    helmChartAttestation: { signature: "sigstore:chart", provenance: "slsa:chart" },
    connectorVersion: "0.8.0",
    commandContract: "infrastructure-connector-command-v1",
    resultContract: "infrastructure-connector-result-v1",
    organizationIdHash: "c".repeat(64),
    connectionIdHash: "d".repeat(64),
    environmentIdHash: "e".repeat(64),
    workspaceIdHash: "f".repeat(64),
    qualificationExpiresAt: "2026-09-01T00:00:00.000Z",
    platform: {
      kubernetesVersion: "1.31.0-gke.1000",
      distribution: "gke",
      edgeMode: "gateway_api",
      edgeController: "gke-gateway",
      cni: "gke-dataplane-v2",
      storageCsi: "pd.csi.storage.gke.io",
      snapshotCsi: "pd.csi.storage.gke.io",
      networkPolicy: "gke-dataplane-v2",
    },
    scenarios: kubernetesProofScenarioIds.map((id) => ({
      id,
      status: "passed",
      evidenceClass: "isolated_provider",
      startedAt,
      completedAt,
      operationIds: [],
      commandIds: [],
      requestIds: [],
      auditIds: [],
      resources: [],
      assertions: [{ name: "scenario", passed: true, detail: "passed" }],
    })),
    cleanup: {
      startedAt,
      completedAt,
      status: "passed",
      deletedKestrelResources: ["namespace:canary"],
      retainedCustomerResources: ["gateway:shared"],
      residualKestrelResources: [],
      unknownResources: [],
      assertions: [{ name: "inventory", passed: true, detail: "clean" }],
    },
    passed: true,
    ...overrides,
  };
}

test("parses a complete GKE proof and redacts identifiers", () => {
  const parsed = parseKubernetesByocProof(validProof(), {
    now: new Date("2026-08-20T00:00:00.000Z"),
  });
  assert.equal(parsed.passed, true);
  assert.equal(redactKubernetesProofIdentifier("organization-1").length, 64);
  assert.notEqual(redactKubernetesProofIdentifier("organization-1"), "organization-1");
});

test("rejects missing, duplicate, or not-run scenarios", () => {
  const scenarios = (validProof().scenarios as Array<Record<string, unknown>>).slice(1);
  assert.throws(() => parseKubernetesByocProof(validProof({ scenarios }), {
    now: new Date("2026-08-20T00:00:00.000Z"),
  }));
  const duplicate = [...(validProof().scenarios as Array<Record<string, unknown>>), ...(validProof().scenarios as Array<Record<string, unknown>>).slice(0, 1)];
  assert.throws(() => parseKubernetesByocProof(validProof({ scenarios: duplicate }), {
    now: new Date("2026-08-20T00:00:00.000Z"),
  }));
  const notRun = (validProof().scenarios as Array<Record<string, unknown>>).map((scenario) =>
    scenario.id === "workspace.persistence" ? { ...scenario, status: "not_run" } : scenario,
  );
  assert.throws(() => parseKubernetesByocProof(validProof({ scenarios: notRun, passed: false }), {
    now: new Date("2026-08-20T00:00:00.000Z"),
  }));
});

test("rejects expired qualification, mutable artifacts, residual inventory, and profile mismatch", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  assert.throws(() => parseKubernetesByocProof(validProof({ qualificationExpiresAt: "2026-08-19T00:00:00.000Z" }), { now }));
  assert.throws(() => parseKubernetesByocProof(validProof({ connectorImageDigest: "registry.example/connector:latest" }), { now }));
  assert.throws(() => parseKubernetesByocProof(validProof({ cleanup: {
    ...validProof().cleanup,
    status: "failed",
    residualKestrelResources: ["deployment:workspace"],
  }, passed: false }), { now }));
  assert.throws(() => parseKubernetesByocProof(validProof({ platform: {
    ...validProof().platform,
    edgeMode: "ingress",
  } }), { now }));
});

test("rejects evidence-class escalation", () => {
  const scenarios = (validProof().scenarios as Array<Record<string, unknown>>).map((scenario) =>
    scenario.id === "workspace.persistence" ? { ...scenario, evidenceClass: "pilot" } : scenario,
  );
  assert.throws(() => parseKubernetesByocProof(validProof({ scenarios }), {
    now: new Date("2026-08-20T00:00:00.000Z"),
  }));
});
