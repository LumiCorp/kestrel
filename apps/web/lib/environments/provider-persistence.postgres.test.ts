import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import {
  encryptConnectorCommandSecrets,
  generateConnectorCredentialEncryptionKeyPair,
  serializeConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import {
  INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
  INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
} from "./providers/connector-contracts";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

const kubernetesProfile = (suffix: string) => ({
  contract: "kubernetes-byoc-profile-v1" as const,
  selectedCertificationProfile: null,
  namespacePrefix: `kestrel-${suffix.slice(0, 8)}`,
  baseDomain: "byoc.example.com",
  storageClassName: "standard-rwo",
  volumeSnapshotClassName: "standard-snapshots",
  controllerNamespace: "gateway-system",
  controllerPodSelector: { app: "gateway-controller" },
  pullSecretRef: null,
  encryptionAttestations: {
    persistentVolumes: { encryption: "unknown" as const, evidenceRef: null },
    kubernetesSecrets: { encryption: "unknown" as const, evidenceRef: null },
  },
  edge: {
    mode: "ingress" as const,
    ingressClassName: "nginx",
  },
  platform: {
    distribution: "other" as const,
    computeProfile: "customer-managed",
    networkPolicyProvider: "calico",
    storageCsiDriver: "csi.example.com",
    snapshotCsiDriver: "csi.example.com",
    edgeController: "nginx-ingress",
  },
});

test(
  "provider persistence backfills Fly, isolates Kubernetes, and serializes connector commands",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    const [
      { resetDbRuntimeForTests },
      providerPersistence,
      connectorStore,
      providerRegistry,
      { knowledgeDb },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./provider-persistence"),
      import("./connector-store"),
      import("./provider-registry"),
      import("@/lib/knowledge/db"),
    ]);
    const sql = postgres(databaseUrl, { max: 4 });
    const suffix = crypto.randomUUID();
    const organizationId = `org-byoc-${suffix}`;
    const otherOrganizationId = `org-byoc-other-${suffix}`;
    const userId = `user-${suffix}`;
    const flyUserId = `fly-user-${suffix}`;
    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" IN (${organizationId}, ${otherOrganizationId})`;
      await sql`DELETE FROM "user" WHERE "id" IN (${userId}, ${flyUserId})`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES
        (${organizationId}, 'BYOC Test', ${`byoc-${suffix}`}, now()),
        (${otherOrganizationId}, 'BYOC Other', ${`byoc-other-${suffix}`}, now())
    `;

    const firstConnection =
      await providerPersistence.createEnvironmentProviderConnection({
        organizationId,
        provider: "kubernetes",
        displayName: "Primary cluster",
        configuration: kubernetesProfile(suffix),
      });
    const secondConnection =
      await providerPersistence.createEnvironmentProviderConnection({
        organizationId,
        provider: "kubernetes",
        displayName: "Secondary cluster",
        configuration: {
          ...kubernetesProfile(`b-${suffix}`),
          namespacePrefix: "kestrel-secondary",
        },
        isDefault: true,
      });
    assert.notEqual(firstConnection.id, secondConnection.id);
    const listed =
      await providerPersistence.listEnvironmentProviderConnections({
        organizationId,
        provider: "kubernetes",
      });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.filter((connection) => connection.isDefault).map(({ id }) => id),
      [secondConnection.id],
    );
    const corruptConnectionId = `corrupt-${suffix}`;
    await sql`
      INSERT INTO "environment_provider_connections" (
        "id", "organization_id", "provider", "display_name", "configuration"
      ) VALUES (${corruptConnectionId}, ${organizationId}, 'fly', 'Corrupt', '{}'::jsonb)
    `;
    await assert.rejects(
      providerPersistence.getEnvironmentProviderConnection({
        organizationId,
        connectionId: corruptConnectionId,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "PROVIDER_PERSISTENCE_CORRUPT",
    );
    await sql`DELETE FROM "environment_provider_connections" WHERE "id" = ${corruptConnectionId}`;

    const environmentId = `environment-${suffix}`;
    await sql`
      INSERT INTO "environments" (
        "id", "organization_id", "name", "slug", "provider", "region",
        "provider_connection_id", "provider_placement", "workspace_limit",
        "status", "runtime_template", "idle_timeout_minutes"
      ) VALUES (
        ${environmentId}, ${organizationId}, 'Kubernetes', ${`k8s-${suffix}`},
        'kubernetes', NULL, ${secondConnection.id},
        ${sql.json({
          connectionId: secondConnection.id,
          requested: { topology: "customer-default" },
          observed: null,
        })},
        8, 'requested', 'kestrel-standard-v1', 15
      )
    `;
    await assert.rejects(
      sql`
        INSERT INTO "environments" (
          "id", "organization_id", "name", "slug", "provider", "region",
          "provider_connection_id", "status", "runtime_template", "idle_timeout_minutes"
        ) VALUES (
          ${`invalid-${suffix}`}, ${organizationId}, 'Invalid', ${`invalid-${suffix}`},
          'kubernetes', NULL, ${secondConnection.id}, 'requested', 'kestrel-standard-v1', 15
        )
      `,
    );
    await assert.rejects(
      sql`UPDATE "environments" SET "provider_connection_id" = ${firstConnection.id} WHERE "id" = ${environmentId}`,
      /immutable/u,
    );
    await assert.rejects(
      providerRegistry.resolveEnvironmentProvider({
        organizationId,
        environmentId,
      }),
      /durable operation identity/u,
    );

    const secondEnvironmentId = `environment-second-${suffix}`;
    await sql`
      INSERT INTO "environments" (
        "id", "organization_id", "name", "slug", "provider", "region",
        "provider_connection_id", "provider_placement", "workspace_limit",
        "status", "runtime_template", "idle_timeout_minutes"
      ) VALUES (
        ${secondEnvironmentId}, ${organizationId}, 'Kubernetes Second', ${`k8s-second-${suffix}`},
        'kubernetes', NULL, ${secondConnection.id},
        ${sql.json({ connectionId: secondConnection.id, requested: null, observed: null })},
        8, 'requested', 'kestrel-standard-v1', 15
      )
    `;
    for (const scopedEnvironmentId of [environmentId, secondEnvironmentId]) {
      await providerPersistence.upsertEnvironmentProviderResource({
        organizationId,
        environmentId: scopedEnvironmentId,
        workspaceId: null,
        providerConnectionId: secondConnection.id,
        provider: "kubernetes",
        resourceRole: "gateway",
        externalId: "gateway",
        desiredRevision: "shared-name-proof",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
        },
      });
    }
    const [sharedNames] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "environment_provider_resources"
      WHERE "provider_connection_id" = ${secondConnection.id}
        AND "resource_role" = 'gateway'
        AND "external_id" = 'gateway'
        AND "deleted_at" IS NULL
    `;
    assert.equal(sharedNames?.count, 2);

    const connector =
      await connectorStore.createInfrastructureConnectorConnection({
        organizationId,
        providerConnectionId: secondConnection.id,
        signingPublicKey: "signing-public-key",
        encryptionPublicKey: "encryption-public-key",
        credentialHash: "credential-hash",
        connectorVersion: "1.0.0",
        supportedCommandVersions: [INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION],
        supportedResultVersions: [INFRASTRUCTURE_CONNECTOR_RESULT_VERSION],
      });
    const enrollment =
      await connectorStore.createInfrastructureConnectorEnrollmentRequest({
        organizationId,
        providerConnectionId: secondConnection.id,
        secretHash: "enrollment-secret-hash",
        fingerprint: `fingerprint-${suffix}`,
        signingPublicKey: "enrollment-signing-public-key",
        encryptionPublicKey: "enrollment-encryption-public-key",
        expiresAt: new Date(Date.now() + 60_000),
      });
    assert.equal(enrollment.secretHash, "enrollment-secret-hash");
    await connectorStore.recordInfrastructureConnectorPresence({
      organizationId,
      connectorId: connector.id,
      replicaId: "replica-a",
      presence: {
        connectionId: secondConnection.id,
        connectorVersion: "1.0.0",
        commandVersions: [INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION],
        resultVersions: [INFRASTRUCTURE_CONNECTOR_RESULT_VERSION],
      },
    });
    const rotated =
      await connectorStore.rotateInfrastructureConnectorCredential({
        organizationId,
        connectorId: connector.id,
        expectedCurrentCredentialHash: "credential-hash",
        nextCredentialHash: "credential-hash-next",
        previousCredentialExpiresAt: new Date(Date.now() + 60_000),
      });
    assert.equal(rotated.previousCredentialHash, "credential-hash");
    assert.equal(rotated.currentCredentialHash, "credential-hash-next");
    const nonceExpiry = new Date(Date.now() + 60_000);
    await connectorStore.consumeInfrastructureConnectorNonce({
      organizationId,
      connectorId: connector.id,
      nonce: "nonce-a",
      expiresAt: nonceExpiry,
    });
    await assert.rejects(
      connectorStore.consumeInfrastructureConnectorNonce({
        organizationId,
        connectorId: connector.id,
        nonce: "nonce-a",
        expiresAt: nonceExpiry,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_NONCE_REPLAY",
    );

    const operationId = `operation-${suffix}`;
    await sql`
      INSERT INTO "environment_operations" (
        "id", "organization_id", "environment_id", "type", "status",
        "stage", "idempotency_key"
      ) VALUES (
        ${operationId}, ${organizationId}, ${environmentId},
        'environment.provision', 'running', 'requested', ${`operation:${suffix}`}
      )
    `;
    const command = {
      contract: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      id: `command-${suffix}`,
      idempotencyKey: `command:${suffix}`,
      connectionId: secondConnection.id,
      organizationId,
      environmentId,
      desiredRevision: "revision-1",
      type: "ensure_environment_scope" as const,
      payload: {
        configurationRevision: "c".repeat(64),
        profile: kubernetesProfile(suffix),
        workspaceLimit: 8,
        runtimeTemplate: "kestrel-standard-v1",
      },
    };
    const enqueued = await connectorStore.enqueueInfrastructureConnectorCommand({
      operationId,
      command,
    });
    const replayed = await connectorStore.enqueueInfrastructureConnectorCommand({
      operationId,
      command,
    });
    assert.equal(replayed.id, enqueued.id);
    const [operationCheckpoint] = await sql<
      Array<{ connectorCommandId: string; result: unknown }>
    >`
      SELECT "connector_command_id" AS "connectorCommandId", "result"
      FROM "environment_operations" WHERE "id" = ${operationId}
    `;
    assert.equal(operationCheckpoint?.connectorCommandId, command.id);
    assert.equal(
      (operationCheckpoint?.result as { connectorCommand?: { id?: string } })
        .connectorCommand?.id,
      command.id,
    );

    const claims = await Promise.all([
      connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 30,
      }),
      connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 30,
      }),
    ]);
    const claim = claims.find((value) => value !== null);
    assert.ok(claim);
    assert.equal(claims.filter(Boolean).length, 1);
    await connectorStore.markInfrastructureConnectorCommandRunning({
      organizationId,
      connectorId: connector.id,
      commandId: command.id,
      claimToken: claim.claimToken,
    });
    const event = {
      contract: "infrastructure-connector-event-v1" as const,
      commandId: command.id,
      sequence: 1,
      type: "progress" as const,
      state: "applying",
    };
    assert.deepEqual(
      await connectorStore.appendInfrastructureConnectorCommandEvent({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: claim.claimToken,
        event,
      }),
      { replayed: false },
    );
    assert.deepEqual(
      await connectorStore.appendInfrastructureConnectorCommandEvent({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: claim.claimToken,
        event,
      }),
      { replayed: true },
    );
    await assert.rejects(
      connectorStore.appendInfrastructureConnectorCommandEvent({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: claim.claimToken,
        event: { ...event, sequence: 3 },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_EVENT_GAP",
    );
    await assert.rejects(
      connectorStore.appendInfrastructureConnectorCommandEvent({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: claim.claimToken,
        event: { ...event, state: "different" },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_EVENT_CONFLICT",
    );
    const result = {
      contract: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
      commandId: command.id,
      connectionId: secondConnection.id,
      commandType: command.type,
      status: "succeeded" as const,
      observedRevision: "revision-1",
      resources: [
        {
          provider: "kubernetes" as const,
          role: "environment_scope" as const,
          externalId: "kestrel-environment",
        },
      ],
      evidence: [],
      output: { state: "ready" },
    };
    await assert.rejects(
      connectorStore.completeInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: "wrong-token",
        result,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_RESULT_REJECTED",
    );
    await assert.rejects(
      connectorStore.completeInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        commandId: command.id,
        claimToken: claim.claimToken,
        result: { ...result, observedRevision: "stale-revision" },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_RESULT_REJECTED",
    );
    await connectorStore.completeInfrastructureConnectorCommand({
      organizationId,
      connectorId: connector.id,
      commandId: command.id,
      claimToken: claim.claimToken,
      result,
    });
    assert.equal(
      await connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 30,
      }),
      null,
    );
    const secondCommand = {
      ...command,
      id: `command-second-${suffix}`,
      idempotencyKey: `command:second:${suffix}`,
      desiredRevision: "revision-2",
    };
    const secondEnqueued =
      await connectorStore.enqueueInfrastructureConnectorCommand({
        operationId,
        command: secondCommand,
      });
    const secondReplayed =
      await connectorStore.enqueueInfrastructureConnectorCommand({
        operationId,
        command: secondCommand,
      });
    assert.equal(secondReplayed.id, secondEnqueued.id);
    const [commandSequence] = await sql<
      Array<{ count: number; latestCommandId: string | null }>
    >`
      SELECT
        count(commands.id)::int AS "count",
        max(operations.connector_command_id) AS "latestCommandId"
      FROM "environment_operations" operations
      LEFT JOIN "infrastructure_connector_commands" commands
        ON commands.operation_id = operations.id
      WHERE operations.id = ${operationId}
      GROUP BY operations.id
    `;
    assert.deepEqual(commandSequence, {
      count: 2,
      latestCommandId: secondCommand.id,
    });
    const secondClaim =
      await connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 30,
      });
    assert.ok(secondClaim);
    assert.equal(secondClaim.command.id, secondCommand.id);
    await connectorStore.markInfrastructureConnectorCommandRunning({
      organizationId,
      connectorId: connector.id,
      commandId: secondCommand.id,
      claimToken: secondClaim.claimToken,
    });
    await connectorStore.completeInfrastructureConnectorCommand({
      organizationId,
      connectorId: connector.id,
      commandId: secondCommand.id,
      claimToken: secondClaim.claimToken,
      result: {
        ...result,
        commandId: secondCommand.id,
        observedRevision: secondCommand.desiredRevision,
      },
    });
    assert.deepEqual(
      await connectorStore.listInfrastructureConnectorCommandEvents({
        organizationId: otherOrganizationId,
        commandId: command.id,
      }),
      [],
    );

    const leaseOperationId = `lease-operation-${suffix}`;
    await sql`
      INSERT INTO "environment_operations" (
        "id", "organization_id", "environment_id", "type", "status",
        "stage", "idempotency_key"
      ) VALUES (
        ${leaseOperationId}, ${organizationId}, ${environmentId},
        'environment.update', 'running', 'requested', ${`lease-operation:${suffix}`}
      )
    `;
    const leaseCommand = {
      ...command,
      id: `lease-command-${suffix}`,
      idempotencyKey: `lease-command:${suffix}`,
      type: "list_environment_resources" as const,
      desiredRevision: "revision-2",
      payload: {
        configurationRevision: "c".repeat(64),
        profile: kubernetesProfile(suffix),
        scope: {
          provider: "kubernetes" as const,
          role: "environment_scope" as const,
          externalId: "kestrel-environment",
        },
      },
    };
    await connectorStore.enqueueInfrastructureConnectorCommand({
      operationId: leaseOperationId,
      command: leaseCommand,
    });
    const leaseNow = new Date("2026-08-17T12:00:00.000Z");
    const firstLease =
      await connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 5,
        now: leaseNow,
      });
    assert.ok(firstLease);
    await connectorStore.renewInfrastructureConnectorCommandLease({
      organizationId,
      connectorId: connector.id,
      commandId: leaseCommand.id,
      claimToken: firstLease.claimToken,
      leaseSeconds: 5,
      now: new Date(leaseNow.getTime() + 1000),
    });
    const reclaimed =
      await connectorStore.claimInfrastructureConnectorCommand({
        organizationId,
        connectorId: connector.id,
        leaseSeconds: 5,
        now: new Date(leaseNow.getTime() + 7000),
      });
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.claimToken, firstLease.claimToken);
    assert.equal(reclaimed.attempt, 2);
    await assert.rejects(
      connectorStore.renewInfrastructureConnectorCommandLease({
        organizationId,
        connectorId: connector.id,
        commandId: leaseCommand.id,
        claimToken: firstLease.claimToken,
        leaseSeconds: 5,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "CONNECTOR_CLAIM_REJECTED",
    );

    const flyEnvironmentId = `fly-environment-${suffix}`;
    const flyWorkspaceId = `fly-workspace-${suffix}`;
    await sql`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES
        (${userId}, 'BYOC', ${`byoc-${suffix}@example.com`}, true, now(), now()),
        (${flyUserId}, 'Fly', ${`fly-${suffix}@example.com`}, true, now(), now())
    `;
    const kubernetesWorkspaceId = `kubernetes-workspace-${suffix}`;
    await sql`
      INSERT INTO "environment_workspaces" (
        "id", "organization_id", "environment_id", "created_by_user_id",
        "personal_owner_user_id", "name", "kind", "source_type", "status"
      ) VALUES (
        ${kubernetesWorkspaceId}, ${organizationId}, ${environmentId},
        ${userId}, ${userId}, 'Kubernetes Workspace', 'scratch', 'blank', 'ready'
      )
    `;
    for (const [role, externalId] of [
      ["workspace_storage", `primary-pvc-${suffix}`],
      ["workspace_compute", `primary-compute-${suffix}`],
    ] as const) {
      await providerPersistence.upsertEnvironmentProviderResource({
        organizationId,
        environmentId,
        workspaceId: kubernetesWorkspaceId,
        providerConnectionId: secondConnection.id,
        provider: "kubernetes",
        resourceRole: role,
        externalId,
        desiredRevision: "primary-revision",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
        },
      });
      await providerPersistence.upsertEnvironmentProviderResource({
        organizationId,
        environmentId,
        workspaceId: kubernetesWorkspaceId,
        replacementId: "replacement-1",
        providerConnectionId: secondConnection.id,
        provider: "kubernetes",
        resourceRole: role,
        externalId: `replacement-${role}-${suffix}`,
        desiredRevision: "replacement-revision",
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
        },
      });
    }
    const beforePromotion = await providerPersistence.listEnvironmentProviderResources({
      organizationId,
      environmentId,
      workspaceId: kubernetesWorkspaceId,
    });
    assert.equal(beforePromotion.length, 4);
    await assert.rejects(
      knowledgeDb.transaction(async (transaction) => {
        await providerPersistence.promoteEnvironmentProviderReplacementInTransaction(
          transaction,
          {
            organizationId,
            environmentId,
            workspaceId: kubernetesWorkspaceId,
            replacementId: "replacement-1",
          },
        );
        throw new Error("rollback promotion proof");
      }),
      /rollback promotion proof/u,
    );
    const afterRolledBackPromotion =
      await providerPersistence.listEnvironmentProviderResources({
        organizationId,
        environmentId,
        workspaceId: kubernetesWorkspaceId,
      });
    assert.equal(afterRolledBackPromotion.length, 4);
    assert.equal(
      afterRolledBackPromotion.filter((resource) => resource.replacementId === null).length,
      2,
    );
    const snapshotWrite = {
      organizationId,
      environmentId,
      workspaceId: kubernetesWorkspaceId,
      providerConnectionId: secondConnection.id,
      provider: "kubernetes" as const,
      resourceRole: "snapshot" as const,
      externalId: `snapshot-${suffix}`,
      desiredRevision: "snapshot-revision",
      state: "ready",
      providerMetadata: {
        contract: "provider-resource-metadata-v1" as const,
        source: "provider_observation" as const,
      },
    };
    const firstSnapshot = await providerPersistence.upsertEnvironmentProviderResource(snapshotWrite);
    const replayedSnapshot = await providerPersistence.upsertEnvironmentProviderResource(snapshotWrite);
    assert.equal(replayedSnapshot.id, firstSnapshot.id);
    const promoted = await providerPersistence.promoteEnvironmentProviderReplacement({
      organizationId,
      environmentId,
      workspaceId: kubernetesWorkspaceId,
      replacementId: "replacement-1",
      expectedReplacementExternalIds: {
        workspace_compute: `replacement-workspace_compute-${suffix}`,
        workspace_storage: `replacement-workspace_storage-${suffix}`,
      },
      expectedRetiredExternalIds: {
        workspace_compute: `primary-compute-${suffix}`,
        workspace_storage: `primary-pvc-${suffix}`,
      },
    });
    assert.equal(promoted.promoted.length, 2);
    assert.equal(promoted.retired.length, 2);
    const afterPromotion = await providerPersistence.listEnvironmentProviderResources({
      organizationId,
      environmentId,
      workspaceId: kubernetesWorkspaceId,
    });
    assert.equal(afterPromotion.length, 3);
    assert.ok(afterPromotion.every((resource) => resource.replacementId === null));
    const replayedPromotion =
      await providerPersistence.promoteEnvironmentProviderReplacement({
        organizationId,
        environmentId,
        workspaceId: kubernetesWorkspaceId,
        replacementId: "replacement-1",
        expectedReplacementExternalIds: {
          workspace_compute: `replacement-workspace_compute-${suffix}`,
          workspace_storage: `replacement-workspace_storage-${suffix}`,
        },
        expectedRetiredExternalIds: {
          workspace_compute: `primary-compute-${suffix}`,
          workspace_storage: `primary-pvc-${suffix}`,
        },
      });
    assert.deepEqual(
      replayedPromotion.promoted.map((resource) => resource.id).sort(),
      promoted.promoted.map((resource) => resource.id).sort(),
    );
    assert.deepEqual(
      replayedPromotion.retired.map((resource) => resource.id).sort(),
      promoted.retired.map((resource) => resource.id).sort(),
    );
    await sql`
      INSERT INTO "ai_provider_connections" (
        "id", "organization_id", "provider", "scope", "display_name",
        "api_key", "enabled", "status", "metadata"
      ) VALUES (
        ${`organization-fly:${organizationId}`}, ${organizationId}, 'fly',
        'organization', 'Fly.io', 'encrypted-token', true, 'ready',
        ${sql.json({ organizationSlug: "customer-fly" })}
      )
    `;
    await sql`
      INSERT INTO "environments" (
        "id", "organization_id", "name", "slug", "provider", "region",
        "status", "fly_app_name", "fly_gateway_machine_id",
        "runtime_template", "idle_timeout_minutes"
      ) VALUES (
        ${flyEnvironmentId}, ${organizationId}, 'Fly', ${`fly-${suffix}`},
        'fly', 'iad', 'ready', ${`app-${suffix}`}, ${`gateway-${suffix}`},
        'kestrel-standard-v1', 15
      )
    `;
    await sql`
      INSERT INTO "environment_workspaces" (
        "id", "organization_id", "environment_id", "created_by_user_id",
        "personal_owner_user_id", "name", "kind", "source_type", "status",
        "fly_machine_id", "fly_volume_id"
      ) VALUES (
        ${flyWorkspaceId}, ${organizationId}, ${flyEnvironmentId},
        ${flyUserId}, ${flyUserId}, 'Workspace', 'scratch', 'blank', 'ready',
        ${`machine-${suffix}`}, ${`volume-${suffix}`}
      )
    `;
    const [flyEnvironment] = await sql<
      Array<{ providerConnectionId: string | null }>
    >`
      SELECT "provider_connection_id" AS "providerConnectionId"
      FROM "environments" WHERE "id" = ${flyEnvironmentId}
    `;
    assert.equal(
      flyEnvironment?.providerConnectionId,
      `organization-fly:${organizationId}`,
    );
    let flyResources = await sql<
      Array<{ id: string; role: string; externalId: string; deletedAt: Date | null }>
    >`
      SELECT "id", "resource_role" AS "role", "external_id" AS "externalId",
             "deleted_at" AS "deletedAt"
      FROM "environment_provider_resources"
      WHERE "environment_id" = ${flyEnvironmentId}
      ORDER BY "resource_role"
    `;
    assert.deepEqual(
      flyResources.filter((resource) => !resource.deletedAt).map(({ role }) => role),
      ["environment_scope", "gateway", "workspace_compute", "workspace_storage"],
    );
    await sql`
      UPDATE "environment_workspaces"
      SET "fly_machine_id" = ${`replacement-machine-${suffix}`},
          "fly_volume_id" = ${`replacement-volume-${suffix}`}
      WHERE "id" = ${flyWorkspaceId}
    `;
    flyResources = await sql`
      SELECT "id", "resource_role" AS "role", "external_id" AS "externalId",
             "deleted_at" AS "deletedAt"
      FROM "environment_provider_resources"
      WHERE "environment_id" = ${flyEnvironmentId}
      ORDER BY "resource_role"
    `;
    assert.equal(
      flyResources.find(({ role }) => role === "workspace_compute")?.externalId,
      `replacement-machine-${suffix}`,
    );
    assert.equal(new Set(flyResources.map(({ id }) => id)).size, 4);
    await sql`
      DELETE FROM "environment_provider_resources"
      WHERE "environment_id" = ${flyEnvironmentId}
        AND "resource_role" = 'gateway'
    `;
    const firstBackfill =
      await providerPersistence.runFlyProviderPersistenceBackfillBatch({
        batchSize: 10,
      });
    const secondBackfill =
      await providerPersistence.runFlyProviderPersistenceBackfillBatch({
        batchSize: 10,
      });
    assert.equal(firstBackfill.eligible, 1);
    assert.equal(firstBackfill.migrated, 1);
    assert.equal(firstBackfill.incomplete, 0);
    assert.equal(secondBackfill.eligible, 0);
    assert.equal(secondBackfill.incomplete, 0);
    const [resourceCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "environment_provider_resources"
      WHERE "environment_id" = ${flyEnvironmentId}
    `;
    assert.equal(resourceCount?.count, 4);

    const scope = flyResources.find(
      ({ role }) => role === "environment_scope",
    );
    assert.ok(scope);
    await providerPersistence.upsertEnvironmentProviderResource({
      organizationId,
      environmentId: flyEnvironmentId,
      workspaceId: null,
      providerConnectionId: `organization-fly:${organizationId}`,
      provider: "fly",
      resourceRole: "environment_scope",
      externalId: `provider-observed-${suffix}`,
      providerUid: null,
      desiredRevision: "revision-provider",
      observedGeneration: "generation-provider",
      state: "ready",
      providerMetadata: {
        contract: "provider-resource-metadata-v1",
        source: "provider_observation",
      },
    });
    await assert.rejects(
      providerPersistence.resolveFlyProviderResourceIdentity({
        organizationId,
        environmentId: flyEnvironmentId,
        role: "environment_scope",
        legacyExternalId: `app-${suffix}`,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "PROVIDER_RESOURCE_CONFLICT",
    );
    const [degraded] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "environments" WHERE "id" = ${flyEnvironmentId}
    `;
    assert.equal(degraded?.status, "degraded");
    await sql`
      UPDATE "environment_workspaces"
      SET "fly_machine_id" = NULL, "fly_volume_id" = NULL, "status" = 'deleted'
      WHERE "id" = ${flyWorkspaceId}
    `;
    await sql`
      UPDATE "environments"
      SET "fly_app_name" = NULL, "fly_gateway_machine_id" = NULL, "status" = 'deleted'
      WHERE "id" = ${flyEnvironmentId}
    `;
    const [activeAfterDelete] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "environment_provider_resources"
      WHERE "environment_id" = ${flyEnvironmentId} AND "deleted_at" IS NULL
    `;
    assert.equal(activeAfterDelete?.count, 0);

    const replayOperationId = `encrypted-replay-operation-${suffix}`;
    await sql`
      INSERT INTO "environment_operations" (
        "id", "organization_id", "environment_id", "type", "status",
        "stage", "idempotency_key"
      ) VALUES (
        ${replayOperationId}, ${organizationId}, ${environmentId},
        'environment.update', 'running', 'requested', ${`encrypted-replay:${suffix}`}
      )
    `;
    const replayKeys = generateConnectorCredentialEncryptionKeyPair();
    const replayCommandId = `k8s-${"e".repeat(48)}`;
    const replayCommandBase = {
      contract: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      id: replayCommandId,
      idempotencyKey: `encrypted-replay-command:${suffix}`,
      connectionId: secondConnection.id,
      organizationId,
      environmentId,
      desiredRevision: "e".repeat(64),
      type: "ensure_environment_gateway" as const,
      payload: {
        configurationRevision: "c".repeat(64),
        profile: kubernetesProfile(suffix),
        scope: { provider: "kubernetes" as const, role: "environment_scope" as const, externalId: "kestrel-environment" },
        placement: { connectionId: secondConnection.id, requested: null, observed: null },
        runtimeImage: `example/router@sha256:${"b".repeat(64)}`,
        ticketPublicKey: "p".repeat(32),
        controlPlaneUrl: "https://control.example.test",
        serviceTokenHash: "h".repeat(43),
      },
    };
    const encryptedCommand = () => ({
      ...replayCommandBase,
      encryptedSecrets: serializeConnectorCommandSecrets(
        encryptConnectorCommandSecrets({
          value: { serviceToken: "same-service-token" },
          recipientPublicKey: replayKeys.publicKey,
          commandId: replayCommandId,
        }),
      ),
    });
    const firstEncrypted = encryptedCommand();
    const secondEncrypted = encryptedCommand();
    assert.notEqual(firstEncrypted.encryptedSecrets, secondEncrypted.encryptedSecrets);
    const firstEncryptedRow = await connectorStore.enqueueInfrastructureConnectorCommand({
      operationId: replayOperationId,
      command: firstEncrypted,
    });
    const replayedEncryptedRow = await connectorStore.enqueueInfrastructureConnectorCommand({
      operationId: replayOperationId,
      command: secondEncrypted,
    });
    assert.equal(replayedEncryptedRow.id, firstEncryptedRow.id);
    assert.deepEqual(replayedEncryptedRow.envelope, firstEncrypted);

    await connectorStore.revokeInfrastructureConnector({
      organizationId,
      connectorId: connector.id,
    });
    const [cancelled] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "infrastructure_connector_commands"
      WHERE "id" = ${leaseCommand.id}
    `;
    assert.equal(cancelled?.status, "cancelled");
  },
);
