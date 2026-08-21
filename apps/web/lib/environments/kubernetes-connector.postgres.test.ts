import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { generateConnectorCredentialEncryptionKeyPair } from "@lumi/kestrel-environment-auth";
import {
  KUBERNETES_QUALIFICATION_CHECK_IDS,
  kubernetesConnectionInfrastructureRevision,
} from "./kubernetes-connector-contracts";

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

  const environmentId = `environment-${suffix}`;
  await sql`
    INSERT INTO "environments" (
      "id", "organization_id", "name", "slug", "provider", "region",
      "provider_connection_id", "provider_placement", "workspace_limit",
      "status", "runtime_template", "idle_timeout_minutes"
    ) VALUES (
      ${environmentId}, ${organizationId}, 'Bound Environment', ${`bound-${suffix}`},
      'kubernetes', NULL, ${approved.connection.id},
      ${sql.json({ connectionId: approved.connection.id, requested: null, observed: null })},
      4, 'requested', 'kestrel-standard-v1', 15
    )
  `;
  const presentationUpdate = await connector.configureKubernetesConnection({
    organizationId,
    connectionId: approved.connection.id,
    actorUserId: userId,
    value: { ...configuration, displayName: "Renamed cluster", isDefault: false },
  });
  assert.equal(presentationUpdate.infrastructureChanged, false);
  assert.equal(presentationUpdate.defaultChanged, true);
  await assert.rejects(
    connector.configureKubernetesConnection({
      organizationId,
      connectionId: approved.connection.id,
      actorUserId: userId,
      value: {
        ...configuration,
        displayName: "Renamed cluster",
        isDefault: false,
        profile: {
          ...configuration.profile,
          storageClassName: "different-storage-class",
        },
      },
    }),
    /cannot change while the connection owns an active Environment/u,
  );

  await assert.rejects(
    connector.requireKubernetesConnectionForEnvironmentCreation({
      organizationId,
      connectionId: approved.connection.id,
      runtimeTemplate: "kestrel-standard-v1",
    }),
    /not ready/u,
  );

  const now = new Date();
  const report = {
    contract: "kubernetes-qualification-report-v1",
    runId: run.runId,
    connectionId: approved.connection.id,
    configurationRevision:
      kubernetesConnectionInfrastructureRevision(configuration),
    clusterFingerprint: "b".repeat(64),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    evidenceClass: "isolated_provider",
    observed: {
      kubernetesVersion: "v1.32.0",
      distribution: "other",
      storageDriver: "csi.example.test",
      snapshotDriver: "csi.example.test",
      edgeController: "nginx",
      edgeMode: "ingress",
    },
    checks: KUBERNETES_QUALIFICATION_CHECK_IDS.map((id) => ({
      id,
      status: "passed",
      evidenceClass: id.startsWith("active.")
        ? "isolated_provider"
        : "cluster_preflight",
      detail: `${id} passed.`,
    })),
    cleanup: {
      status: "passed",
      namespace: "kestrel-qualification-test",
      residualResources: [],
    },
  };
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE infrastructure_connector_qualification_runs
      SET status = 'passed', result = ${transaction.json(report)},
        completed_at = now(), updated_at = now()
      WHERE id = ${run.runId}
    `;
    await transaction`
      UPDATE environment_provider_connections
      SET status = 'ready', support_status = 'qualified',
        qualification_evidence = ${transaction.json([report])},
        qualified_at = now(), last_qualified_at = now(), updated_at = now()
      WHERE id = ${approved.connection.id}
    `;
  });
  const admitted =
    await connector.requireKubernetesConnectionForEnvironmentCreation({
      organizationId,
      connectionId: approved.connection.id,
      runtimeTemplate: "kestrel-standard-v1",
    });
  assert.equal(admitted.connection.id, approved.connection.id);
  await assert.rejects(
    connector.requireKubernetesConnectionForEnvironmentCreation({
      organizationId,
      connectionId: approved.connection.id,
      runtimeTemplate: "unapproved-template",
    }),
    /not allowed/u,
  );
  await assert.rejects(
    connector.requireKubernetesConnectionForEnvironmentCreation({
      organizationId: `other-${organizationId}`,
      connectionId: approved.connection.id,
      runtimeTemplate: "kestrel-standard-v1",
    }),
    /unavailable/u,
  );

  await sql`
    UPDATE infrastructure_connector_connections
    SET last_seen_at = now(), updated_at = now()
    WHERE provider_connection_id = ${approved.connection.id}
  `;
  await assert.rejects(
    connector.revokeKubernetesConnection({
      organizationId,
      connectionId: approved.connection.id,
      actorUserId: userId,
    }),
    /Delete every Environment/u,
  );
  await sql`DELETE FROM environments WHERE id = ${environmentId}`;
  await assert.rejects(
    connector.revokeKubernetesConnection({
      organizationId,
      connectionId: approved.connection.id,
      actorUserId: userId,
    }),
    /active command/u,
  );
  const inventoryResult = {
    contract: "infrastructure-connector-result-v1",
    commandId: run.commandId,
    connectionId: approved.connection.id,
    commandType: "list_environment_resources",
    status: "succeeded",
    observedRevision: run.configRevision,
    resources: [],
    evidence: [],
    output: { resourceObservations: [] },
  };
  await sql`
    UPDATE infrastructure_connector_commands
    SET command_type = 'list_environment_resources', status = 'completed',
      result = ${sql.json(inventoryResult)}, completed_at = now(),
      created_at = now(), updated_at = now()
    WHERE id = ${run.commandId}
  `;
  assert.deepEqual(
    await connector.revokeKubernetesConnection({
      organizationId,
      connectionId: approved.connection.id,
      actorUserId: userId,
    }),
    { revoked: true, displayName: "Renamed cluster" },
  );
  await assert.rejects(
    connector.requireKubernetesConnectionForEnvironmentCreation({
      organizationId,
      connectionId: approved.connection.id,
      runtimeTemplate: "kestrel-standard-v1",
    }),
    /not ready/u,
  );
});
