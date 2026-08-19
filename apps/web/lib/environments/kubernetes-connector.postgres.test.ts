import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { generateConnectorCredentialEncryptionKeyPair } from "@lumi/kestrel-environment-auth";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("connector enrollment binds once and qualification owns a durable command", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, connector] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./kubernetes-connector"),
  ]);
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const organizationId = `org-connector-${suffix}`;
  const userId = `user-connector-${suffix}`;
  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });
  await sql`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${userId}, 'Connector Admin', ${`${suffix}@example.test`}, true, now(), now())`;
  await sql`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${organizationId}, 'Connector Org', ${`connector-${suffix}`}, now())`;

  const signing = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const encryption = generateConnectorCredentialEncryptionKeyPair();
  const enrollment = await connector.createKubernetesConnectorEnrollment({
    connectorName: "Test cluster",
    connectorVersion: "0.8.0",
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    commandVersions: ["infrastructure-connector-command-v1"],
    resultVersions: ["infrastructure-connector-result-v1"],
    clusterMetadata: { identityId: crypto.randomUUID() },
  });
  const [unbound] = await sql<Array<{ organizationId: string | null }>>`
    SELECT "organization_id" AS "organizationId" FROM "infrastructure_connector_enrollment_requests" WHERE "id" = ${enrollment.requestId}
  `;
  assert.equal(unbound?.organizationId, null);
  await assert.rejects(
    connector.approveKubernetesConnectorEnrollment({ requestId: enrollment.requestId, organizationId, actorUserId: userId, approval: { fingerprint: "0".repeat(64) } }),
    /fingerprint/u,
  );
  const approved = await connector.approveKubernetesConnectorEnrollment({
    requestId: enrollment.requestId,
    organizationId,
    actorUserId: userId,
    approval: { fingerprint: enrollment.fingerprint },
  });
  const consumed = await connector.consumeKubernetesConnectorEnrollment({ requestId: enrollment.requestId, requestSecret: enrollment.requestSecret });
  const replayed = await connector.consumeKubernetesConnectorEnrollment({ requestId: enrollment.requestId, requestSecret: enrollment.requestSecret });
  assert.deepEqual(replayed, consumed);

  const configuration = {
    contract: "kubernetes-connection-config-v1",
    displayName: "Test cluster",
    isDefault: true,
    profile: {
      contract: "kubernetes-byoc-profile-v1",
      selectedCertificationProfile: null,
      namespacePrefix: "kestrel",
      baseDomain: "byoc.example.test",
      storageClassName: "standard-rwo",
      volumeSnapshotClassName: "snapshots",
      controllerNamespace: "ingress-system",
      controllerPodSelector: { app: "ingress-controller" },
      pullSecretRef: null,
      encryptionAttestations: {
        persistentVolumes: { encryption: "provider_attested", evidenceRef: "attestation:pv" },
        kubernetesSecrets: { encryption: "provider_attested", evidenceRef: "attestation:secrets" },
      },
      edge: { mode: "ingress", ingressClassName: "nginx" },
      platform: { distribution: "other", computeProfile: "managed", networkPolicyProvider: "calico", storageCsiDriver: "csi.example.test", snapshotCsiDriver: "csi.example.test", edgeController: "nginx" },
    },
    runtimeTemplateAllowlist: ["kestrel-standard-v1"],
    qualificationProbeImage: `example/probe@sha256:${"a".repeat(64)}`,
    attestationEvidenceNote: "Customer administrator confirmed provider encryption settings.",
  };
  await connector.configureKubernetesConnection({ organizationId, connectionId: approved.connection.id, actorUserId: userId, value: configuration });
  const run = await connector.enqueueKubernetesQualification({ organizationId, connectionId: approved.connection.id, actorUserId: userId });
  const [command] = await sql<Array<{ operationId: string | null; qualificationRunId: string | null }>>`
    SELECT "operation_id" AS "operationId", "qualification_run_id" AS "qualificationRunId" FROM "infrastructure_connector_commands" WHERE "id" = ${run.commandId}
  `;
  assert.equal(command?.operationId, null);
  assert.equal(command?.qualificationRunId, run.runId);
});
