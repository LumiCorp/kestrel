import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildConnectorRequestSigningInput,
  decryptConnectorCredential,
  encryptConnectorCredential,
  generateConnectorCredentialEncryptionKeyPair,
  signConnectorRequest,
  verifyConnectorRequestSignature,
} from "@lumi/kestrel-environment-auth";
import { connectorConfigSchema } from "../src/config.js";
import {
  QUALIFICATION_REPORT_VERSION,
  qualificationReportSchema,
} from "../src/contracts.js";
import { redactConnectorValue } from "../src/redaction.js";

test("startup rejects mutable images and non-HTTPS control planes", () => {
  const base = {
    kestrelBaseUrl: "https://kestrel.example",
    displayName: "Test cluster",
    namespace: "kestrel-system",
    identitySecretName: "identity",
    leaderLeaseName: "leader",
    replicaId: "replica-1",
    connectorVersion: "0.8.0",
    image: `example/connector@sha256:${"a".repeat(64)}`,
    port: 8080,
    serviceAccountTokenPath: "/token",
    serviceAccountCaPath: "/ca",
    kubernetesHost: "kubernetes.default.svc",
    kubernetesPort: 443,
  };
  assert.equal(connectorConfigSchema.parse(base).image, base.image);
  assert.throws(() => connectorConfigSchema.parse({ ...base, image: "example/connector:latest" }));
  assert.throws(() => connectorConfigSchema.parse({ ...base, kestrelBaseUrl: "http://kestrel.example" }));
});

test("request signatures bind method, path, timestamp, nonce, and body", () => {
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const input = { method: "POST", path: "/api/runtime/test", timestamp: 100, nonce: "nonce-1234567890123456", bodyText: '{"ok":true}' };
  const signature = signConnectorRequest({ ...input, privateKey: keys.privateKey });
  assert.equal(verifyConnectorRequestSignature({ ...input, publicKey: keys.publicKey, signature }), true);
  assert.equal(verifyConnectorRequestSignature({ ...input, path: "/api/runtime/other", publicKey: keys.publicKey, signature }), false);
  assert.match(buildConnectorRequestSigningInput(input), /POST\n\/api\/runtime\/test\n100/u);
});

test("credential envelopes bind ciphertext to the enrollment request", () => {
  const keys = generateConnectorCredentialEncryptionKeyPair();
  const envelope = encryptConnectorCredential({
    value: { credential: "connector-secret" },
    recipientPublicKey: keys.publicKey,
    requestId: "enrollment-request-1",
  });
  assert.deepEqual(
    decryptConnectorCredential<{ credential: string }>({
      envelope,
      recipientPrivateKey: keys.privateKey,
      requestId: "enrollment-request-1",
    }),
    { credential: "connector-secret" },
  );
  assert.throws(() =>
    decryptConnectorCredential({
      envelope,
      recipientPrivateKey: keys.privateKey,
      requestId: "different-enrollment-request",
    }),
  );
});

test("qualification reports require every unique fixed check", () => {
  const checkIds = [
    "discovery.version", "discovery.resources", "authorization.exact_verbs", "prerequisite.storage_class", "prerequisite.snapshot_class", "prerequisite.edge", "active.baseline", "active.image_pull_and_schedule", "active.pvc_persistence", "active.snapshot_restore", "active.edge_route", "active.public_dns_tls", "active.allowed_network_paths", "active.denied_network_paths", "active.quota_rejection", "cleanup.namespace_removed",
  ] as const;
  const report = {
    contract: QUALIFICATION_REPORT_VERSION,
    runId: "run-1",
    connectionId: "connection-1",
    configurationRevision: "a".repeat(64),
    clusterFingerprint: "b".repeat(64),
    startedAt: "2026-08-17T10:00:00.000Z",
    completedAt: "2026-08-17T10:10:00.000Z",
    expiresAt: "2026-08-18T10:10:00.000Z",
    evidenceClass: "isolated_provider" as const,
    observed: { kubernetesVersion: "v1.33.0", distribution: "gke" as const, storageDriver: "pd.csi.storage.gke.io", snapshotDriver: "pd.csi.storage.gke.io", edgeController: "gke_gateway", edgeMode: "gateway_api" as const },
    checks: checkIds.map((id) => ({ id, status: "passed" as const, evidenceClass: id.startsWith("active.") || id.startsWith("cleanup.") ? "isolated_provider" as const : "cluster_preflight" as const, detail: "passed" })),
    cleanup: { status: "passed" as const, namespace: "kestrel-qualification-a", residualResources: [] },
  };
  assert.equal(qualificationReportSchema.parse(report).checks.length, 16);
  assert.throws(() => qualificationReportSchema.parse({ ...report, checks: [...report.checks.slice(0, 15), report.checks[0]] }));
});

test("connector logs redact credentials and Kubernetes Secret data", () => {
  assert.deepEqual(
    redactConnectorValue({ authorization: "Bearer secret", data: { token: "plain" }, safe: "visible" }),
    { authorization: "[redacted]", data: "[redacted]", safe: "visible" },
  );
});
