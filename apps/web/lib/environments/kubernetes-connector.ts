import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  CONNECTOR_ENROLLMENT_TTL_MS,
  CONNECTOR_CREDENTIAL_ROTATION_MS,
  CONNECTOR_NONCE_TTL_MS,
  CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS,
  connectorSecretMatches,
  connectorTimestampIsCurrent,
  encryptConnectorCredential,
  hashConnectorSecret,
  normalizeConnectorCredentialEncryptionPublicKey,
  normalizeConnectorSigningPublicKey,
  verifyConnectorRequestSignature,
} from "@lumi/kestrel-environment-auth";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  appendInfrastructureConnectorCommandEvent,
  claimInfrastructureConnectorCommand,
  completeInfrastructureConnectorCommand,
  consumeInfrastructureConnectorNonce,
  recordInfrastructureConnectorPresence,
  rotateInfrastructureConnectorCredential,
  renewInfrastructureConnectorCommandLease,
  revokeInfrastructureConnector,
} from "./connector-store";
import {
  kubernetesConnectionConfigRevision,
  kubernetesConnectionInfrastructureRevision,
  kubernetesConnectionConfigV1Schema,
  kubernetesConnectorEnrollmentSchema,
  kubernetesQualificationReportV1Schema,
  qualificationPassed,
} from "./kubernetes-connector-contracts";
import {
  connectorVersionListSchema,
} from "./provider-persistence-contracts";
import {
  INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
  INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
  infrastructureConnectorCommandV1Schema,
  infrastructureConnectorResultV1Schema,
  negotiateInfrastructureConnectorV1,
} from "./providers/connector-contracts";
import { resolveKubernetesByocSupportState } from "./providers/kubernetes-byoc-profile";

const fingerprintApprovalSchema = z
  .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();

export async function createKubernetesConnectorEnrollment(value: unknown) {
  const input = kubernetesConnectorEnrollmentSchema.parse(value);
  const signing = normalizeConnectorSigningPublicKey(input.signingPublicKey);
  const encryptionPublicKey = normalizeConnectorCredentialEncryptionPublicKey(
    input.encryptionPublicKey,
  );
  const commandVersions = connectorVersionListSchema.parse(input.commandVersions);
  const resultVersions = connectorVersionListSchema.parse(input.resultVersions);
  negotiateInfrastructureConnectorV1({
    connectionId: crypto.randomUUID(),
    connectorVersion: input.connectorVersion,
    commandVersions,
    resultVersions,
  });
  const requestSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  const [request] = await knowledgeDb
    .insert(schema.infrastructureConnectorEnrollmentRequests)
    .values({
      id: crypto.randomUUID(),
      connectorName: input.connectorName,
      connectorVersion: input.connectorVersion,
      supportedCommandVersions: commandVersions,
      supportedResultVersions: resultVersions,
      clusterMetadata: input.clusterMetadata,
      secretHash: hashConnectorSecret(requestSecret),
      fingerprint: signing.fingerprint,
      signingPublicKey: signing.pem,
      encryptionPublicKey,
      status: "pending",
      expiresAt: new Date(now.getTime() + CONNECTOR_ENROLLMENT_TTL_MS),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!request) throw new Error("Connector enrollment request was not created.");
  return {
    requestId: request.id,
    requestSecret,
    fingerprint: request.fingerprint,
    expiresAt: request.expiresAt.toISOString(),
    verificationPath: `/organization/connections/kubernetes/enrollments/${request.id}`,
  };
}

export async function getKubernetesConnectorEnrollment(input: {
  requestId: string;
  organizationId?: string;
}) {
  const request =
    await knowledgeDb.query.infrastructureConnectorEnrollmentRequests.findFirst({
      where: (table, { eq }) => eq(table.id, input.requestId),
    });
  if (!request) throw new Error("Connector enrollment request is unavailable.");
  if (
    input.organizationId &&
    request.organizationId &&
    request.organizationId !== input.organizationId
  ) {
    throw new Error("Connector enrollment request is unavailable.");
  }
  return sanitizeEnrollment(request);
}

export async function approveKubernetesConnectorEnrollment(input: {
  requestId: string;
  organizationId: string;
  actorUserId: string;
  approval: unknown;
}) {
  const approval = fingerprintApprovalSchema.parse(input.approval);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-enrollment:${input.requestId}`}, 0))`,
    );
    const request =
      await transaction.query.infrastructureConnectorEnrollmentRequests.findFirst({
        where: (table, { and, eq, gt }) =>
          and(
            eq(table.id, input.requestId),
            eq(table.status, "pending"),
            gt(table.expiresAt, now),
          ),
      });
    if (!request || request.fingerprint !== approval.fingerprint) {
      throw new Error("Connector enrollment fingerprint does not match.");
    }
    const connectionId = crypto.randomUUID();
    const [connection] = await transaction
      .insert(schema.environmentProviderConnections)
      .values({
        id: connectionId,
        organizationId: input.organizationId,
        provider: "kubernetes",
        displayName: request.connectorName,
        status: "enrolling",
        supportStatus: "unverified",
        configuration: { contract: "kubernetes-pending-connection-v1" },
        qualificationEvidence: [],
        configuredByUserId: input.actorUserId,
        configuredAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!connection) throw new Error("Kubernetes connection was not created.");
    await transaction
      .update(schema.infrastructureConnectorEnrollmentRequests)
      .set({
        organizationId: input.organizationId,
        providerConnectionId: connectionId,
        status: "approved",
        approvedByUserId: input.actorUserId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.infrastructureConnectorEnrollmentRequests.id, request.id));
    return { connection, fingerprint: request.fingerprint };
  });
}

export async function consumeKubernetesConnectorEnrollment(input: {
  requestId: string;
  requestSecret: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-enrollment:${input.requestId}`}, 0))`,
    );
    const request =
      await transaction.query.infrastructureConnectorEnrollmentRequests.findFirst({
        where: (table, { eq }) => eq(table.id, input.requestId),
      });
    if (
      !(request &&connectorSecretMatches(input.requestSecret, request.secretHash) ) ||
      request.expiresAt <= new Date()
    ) {
      throw new Error("Connector enrollment request is unavailable.");
    }
    if (request.status === "consumed" && request.consumptionEnvelope) {
      return request.consumptionEnvelope;
    }
    if (
      request.status !== "approved" ||
      !request.organizationId ||
      !request.providerConnectionId
    ) {
      return { status: request.status, expiresAt: request.expiresAt.toISOString() };
    }
    const credential = randomBytes(32).toString("base64url");
    const now = new Date();
    const connectorId = crypto.randomUUID();
    await transaction.insert(schema.infrastructureConnectorConnections).values({
      id: connectorId,
      organizationId: request.organizationId,
      providerConnectionId: request.providerConnectionId,
      signingPublicKey: request.signingPublicKey,
      encryptionPublicKey: request.encryptionPublicKey,
      currentCredentialHash: hashConnectorSecret(credential),
      supportedCommandVersions: request.supportedCommandVersions,
      supportedResultVersions: request.supportedResultVersions,
      connectorVersion: request.connectorVersion,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await transaction
      .update(schema.environmentProviderConnections)
      .set({ connectorId, lastSeenAt: now, updatedAt: now })
      .where(eq(schema.environmentProviderConnections.id, request.providerConnectionId));
    const response = {
      status: "active" as const,
      connectionId: request.providerConnectionId,
      organizationId: request.organizationId,
      credentialEnvelope: encryptConnectorCredential({
        value: { credential },
        recipientPublicKey: request.encryptionPublicKey,
        requestId: request.id,
      }),
      ticketPublicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
      commandVersion: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      resultVersion: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
    };
    await transaction
      .update(schema.infrastructureConnectorEnrollmentRequests)
      .set({
        status: "consumed",
        consumedAt: now,
        consumptionEnvelope: response,
        updatedAt: now,
      })
      .where(eq(schema.infrastructureConnectorEnrollmentRequests.id, request.id));
    return response;
  });
}

export type KubernetesConnectorAuthorization = {
  connector: typeof schema.infrastructureConnectorConnections.$inferSelect;
  connection: typeof schema.environmentProviderConnections.$inferSelect;
};

export async function authorizeKubernetesConnector(input: {
  request: Request;
  bodyText: string;
  connectionId: string;
}): Promise<KubernetesConnectorAuthorization> {
  const credential = input.request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/u)?.[1];
  const timestamp = Number(input.request.headers.get("x-kestrel-timestamp"));
  const nonce = input.request.headers.get("x-kestrel-nonce");
  const signature = input.request.headers.get("x-kestrel-signature");
  if (
    !((((credential &&connectorTimestampIsCurrent({ timestamp }) ) &&nonce ) &&/^[A-Za-z0-9_-]{16,128}$/u.test(nonce) ) &&signature)
  ) {
    throw new Error("Unauthorized");
  }
  const connection = await knowledgeDb.query.environmentProviderConnections.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.id, input.connectionId), eq(table.provider, "kubernetes"), isNull(table.revokedAt)),
  });
  const connector = connection?.connectorId
    ? await knowledgeDb.query.infrastructureConnectorConnections.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.id, connection.connectorId!), eq(table.status, "active")),
      })
    : null;
  const credentialAccepted = Boolean(
    connector &&
      (connectorSecretMatches(credential, connector.currentCredentialHash) ||
        (connector.previousCredentialHash &&
          connector.previousCredentialExpiresAt &&
          connector.previousCredentialExpiresAt > new Date() &&
          connectorSecretMatches(credential, connector.previousCredentialHash))),
  );
  if (
    !(((connection &&connector ) &&credentialAccepted ) &&verifyConnectorRequestSignature({
      publicKey: connector.signingPublicKey,
      signature,
      method: input.request.method,
      path: new URL(input.request.url).pathname,
      timestamp,
      nonce,
      bodyText: input.bodyText,
    }))
  ) {
    throw new Error("Unauthorized");
  }
  await consumeInfrastructureConnectorNonce({
    organizationId: connector.organizationId,
    connectorId: connector.id,
    nonce,
    expiresAt: new Date(Date.now() + CONNECTOR_NONCE_TTL_MS),
  });
  return { connector, connection };
}

export async function recordKubernetesConnectorPresence(
  authorization: KubernetesConnectorAuthorization,
  value: unknown,
) {
  const body = z
    .object({
      connectionId: z.string(),
      connectorVersion: z.string(),
      commandVersions: z.array(z.string()).min(1),
      resultVersions: z.array(z.string()).min(1),
      replicaId: z.string().min(1).max(255),
    })
    .strict()
    .parse(value);
  const { replicaId, ...presence } = body;
  const negotiated = await recordInfrastructureConnectorPresence({
    organizationId: authorization.connector.organizationId,
    connectorId: authorization.connector.id,
    replicaId,
    presence,
  });
  if (
    authorization.connection.status === "degraded" &&
    authorization.connection.failureCode === "CONNECTOR_OFFLINE"
  ) {
    await knowledgeDb
      .update(schema.environmentProviderConnections)
      .set({
        status:
          authorization.connection.supportStatus === "unverified"
            ? "enrolling"
            : "ready",
        failureCode: null,
        failureMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.environmentProviderConnections.id, authorization.connection.id));
  }
  const now = new Date();
  const rotationDue =
    !authorization.connector.credentialRotatedAt ||
    now.getTime() - authorization.connector.credentialRotatedAt.getTime() >=
      CONNECTOR_CREDENTIAL_ROTATION_MS;
  if (!rotationDue) return { status: "active" as const, negotiated };
  const credential = randomBytes(32).toString("base64url");
  await rotateInfrastructureConnectorCredential({
    organizationId: authorization.connector.organizationId,
    connectorId: authorization.connector.id,
    expectedCurrentCredentialHash:
      authorization.connector.currentCredentialHash,
    nextCredentialHash: hashConnectorSecret(credential),
    previousCredentialExpiresAt: new Date(
      now.getTime() + CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS,
    ),
  });
  return {
    status: "active" as const,
    negotiated,
    credentialEnvelope: encryptConnectorCredential({
      value: { credential },
      recipientPublicKey: authorization.connector.encryptionPublicKey,
      requestId: authorization.connection.id,
    }),
    rotatedAt: now.toISOString(),
  };
}

export async function configureKubernetesConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string | null;
  value: unknown;
}) {
  const config = kubernetesConnectionConfigV1Schema.parse(input.value);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-connection:${input.connectionId}`}, 0))`,
    );
    const existing = await transaction.query.environmentProviderConnections.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.connectionId),
          eq(table.organizationId, input.organizationId),
          eq(table.provider, "kubernetes"),
          isNull(table.revokedAt),
        ),
    });
    if (!existing?.connectorId) throw new Error("Kubernetes connection is unavailable.");
    const infrastructureChanged =
      safeInfrastructureRevision(existing.configuration) !==
      kubernetesConnectionInfrastructureRevision(config);
    if (infrastructureChanged) {
      const boundEnvironment = await transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull, ne }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.providerConnectionId, input.connectionId),
            ne(table.status, "deleted"),
            isNull(table.archivedAt),
          ),
        columns: { id: true },
      });
      if (boundEnvironment) {
        throw new Error(
          "Kubernetes infrastructure configuration cannot change while the connection owns an active Environment.",
        );
      }
    }
    if (config.isDefault) {
      await transaction
        .update(schema.environmentProviderConnections)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(schema.environmentProviderConnections.organizationId, input.organizationId),
            eq(schema.environmentProviderConnections.provider, "kubernetes"),
            eq(schema.environmentProviderConnections.isDefault, true),
            isNull(schema.environmentProviderConnections.revokedAt),
          ),
        );
    }
    const [updated] = await transaction
      .update(schema.environmentProviderConnections)
      .set({
        displayName: config.displayName,
        isDefault: config.isDefault,
        configuration: config,
        ...(infrastructureChanged
          ? {
              qualificationEvidence: [],
              status: "enrolling" as const,
              supportStatus: "unverified" as const,
              qualifiedAt: null,
              lastQualifiedAt: null,
              qualifiedByUserId: null,
              failureCode: null,
              failureMessage: null,
            }
          : {}),
        configuredByUserId: input.actorUserId,
        attestedByUserId: input.actorUserId,
        configuredAt: now,
        attestedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.environmentProviderConnections.id, input.connectionId))
      .returning();
    if (!updated) throw new Error("Kubernetes connection configuration failed.");
    return {
      connection: updated,
      configRevision: kubernetesConnectionConfigRevision(config),
      infrastructureRevision:
        kubernetesConnectionInfrastructureRevision(config),
      infrastructureChanged,
      defaultChanged: existing.isDefault !== config.isDefault,
    };
  });
}

export async function enqueueKubernetesQualification(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-qualification:${input.connectionId}`}, 0))`,
    );
    const connection = await transaction.query.environmentProviderConnections.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.connectionId),
          eq(table.organizationId, input.organizationId),
          eq(table.provider, "kubernetes"),
          isNull(table.revokedAt),
        ),
    });
    if (!connection?.connectorId) throw new Error("Kubernetes connection is unavailable.");
    const config = kubernetesConnectionConfigV1Schema.parse(connection.configuration);
    const revision = kubernetesConnectionInfrastructureRevision(config);
    const runId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const command = infrastructureConnectorCommandV1Schema.parse({
      contract: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      id: commandId,
      idempotencyKey: `qualification:${runId}`,
      connectionId: connection.id,
      organizationId: input.organizationId,
      desiredRevision: revision,
      type: "qualify_connection",
      payload: {
        runId,
        configurationRevision: revision,
        profile: config.profile,
        probeImage: config.qualificationProbeImage,
        expiresAt: expiresAt.toISOString(),
      },
    });
    await transaction.insert(schema.infrastructureConnectorQualificationRuns).values({
      id: runId,
      organizationId: input.organizationId,
      providerConnectionId: connection.id,
      requestedByUserId: input.actorUserId,
      configRevision: revision,
      status: "queued",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(schema.infrastructureConnectorCommands).values({
      id: commandId,
      organizationId: input.organizationId,
      providerConnectionId: connection.id,
      connectorId: connection.connectorId,
      qualificationRunId: runId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.type,
      desiredRevision: revision,
      envelope: command,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await transaction
      .update(schema.infrastructureConnectorQualificationRuns)
      .set({ commandId, updatedAt: now })
      .where(eq(schema.infrastructureConnectorQualificationRuns.id, runId));
    await transaction
      .update(schema.environmentProviderConnections)
      .set({ status: "qualifying", failureCode: null, failureMessage: null, updatedAt: now })
      .where(eq(schema.environmentProviderConnections.id, connection.id));
    return { runId, commandId, configRevision: revision, expiresAt: expiresAt.toISOString() };
  });
}

export async function completeKubernetesConnectorCommand(input: {
  authorization: KubernetesConnectorAuthorization;
  commandId: string;
  claimToken: string;
  result: unknown;
  qualification?: unknown;
}) {
  const result = infrastructureConnectorResultV1Schema.parse(input.result);
  const report = input.qualification
    ? kubernetesQualificationReportV1Schema.parse(input.qualification)
    : undefined;
  const pending = await knowledgeDb.query.infrastructureConnectorCommands.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.commandId),
        eq(table.organizationId, input.authorization.connector.organizationId),
        eq(table.connectorId, input.authorization.connector.id),
      ),
  });
  if (!pending) throw new Error("Connector command is unavailable.");
  if (
    pending.qualificationRunId &&
    (!report ||
      report.runId !== pending.qualificationRunId ||
      report.connectionId !== pending.providerConnectionId ||
      report.configurationRevision !== pending.desiredRevision)
  ) {
    throw new Error("Qualification report does not match the active command.");
  }
  const completed = await completeInfrastructureConnectorCommand({
    organizationId: input.authorization.connector.organizationId,
    connectorId: input.authorization.connector.id,
    commandId: input.commandId,
    claimToken: input.claimToken,
    result,
  });
  if (!completed.qualificationRunId) return completed;
  if (!report) throw new Error("Qualification report is required.");
  const now = new Date();
  const qualificationState = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-connection:${completed.providerConnectionId}`}, 0))`,
    );
    const connection = await transaction.query.environmentProviderConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, completed.providerConnectionId),
          eq(table.organizationId, completed.organizationId),
          eq(table.provider, "kubernetes"),
        ),
    });
    if (!connection) throw new Error("Kubernetes connection is unavailable.");
    const config = kubernetesConnectionConfigV1Schema.parse(connection.configuration);
    const currentRevision = kubernetesConnectionInfrastructureRevision(config);
    const stale = report.configurationRevision !== currentRevision;
    const passed =
      !stale && result.status === "succeeded" && qualificationPassed(report);
    const support = resolveKubernetesByocSupportState({
      profile: config.profile,
      compatible: passed,
      ...(passed && config.profile.selectedCertificationProfile
        ? {
            verifiedFacts: {
              profileId: config.profile.selectedCertificationProfile,
              platform: {
                ...config.profile.platform,
                distribution: report.observed.distribution,
                storageCsiDriver: report.observed.storageDriver,
                snapshotCsiDriver: report.observed.snapshotDriver,
                edgeController: report.observed.edgeController,
              },
              edgeMode: report.observed.edgeMode,
              evidenceLevel: "isolated_provider" as const,
              evidenceRef: `qualification:${report.runId}`,
            },
          }
        : {}),
    });
    const run = await transaction.query.infrastructureConnectorQualificationRuns.findFirst({
      where: (table, { eq }) => eq(table.id, report.runId),
    });
    await transaction
      .update(schema.infrastructureConnectorQualificationRuns)
      .set({
        status: passed ? "passed" : "failed",
        result: report,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.infrastructureConnectorQualificationRuns.id, report.runId));
    if (!stale) {
      await transaction
        .update(schema.environmentProviderConnections)
        .set({
        status: passed ? "ready" : "degraded",
        supportStatus:
          passed && support.state === "certified"
            ? "certified"
            : passed
              ? "qualified"
              : "unverified",
        qualificationEvidence: [report],
        qualifiedByUserId: passed ? run?.requestedByUserId ?? null : null,
        qualifiedAt: passed ? now : null,
        lastQualifiedAt: passed ? now : null,
        failureCode: passed ? null : "QUALIFICATION_FAILED",
        failureMessage: passed ? null : "Kubernetes qualification did not pass every required check.",
        updatedAt: now,
        })
        .where(eq(schema.environmentProviderConnections.id, connection.id));
    }
    return {
      passed,
      support,
      stale,
      requestedByUserId: run?.requestedByUserId ?? null,
    };
  });
  await logAdminEvent({
    organizationId: completed.organizationId,
    actorUserId: qualificationState.requestedByUserId,
    level: qualificationState.passed ? "info" : "warn",
    category: "environments",
    action: "kubernetes_connection.qualification.completed",
    targetType: "provider-connection",
    targetId: completed.providerConnectionId,
    message: qualificationState.passed
      ? "Kubernetes connection qualification passed."
      : "Kubernetes connection qualification did not pass.",
    metadata: {
      runId: report.runId,
      passed: qualificationState.passed,
      stale: qualificationState.stale,
      supportState: qualificationState.support.state,
    },
  });
  return {
    ...completed,
    qualificationAccepted: qualificationState.passed,
    support: qualificationState.support,
    stale: qualificationState.stale,
  };
}

async function getKubernetesConnectionRecord(input: {
  organizationId: string;
  connectionId: string;
}) {
  const connection = await knowledgeDb.query.environmentProviderConnections.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.id, input.connectionId), eq(table.organizationId, input.organizationId), eq(table.provider, "kubernetes")),
  });
  if (!connection) throw new Error("Kubernetes connection is unavailable.");
  const connector = connection.connectorId
    ? await knowledgeDb.query.infrastructureConnectorConnections.findFirst({
        where: (table, { eq }) => eq(table.id, connection.connectorId!),
      })
    : null;
  const qualification = await knowledgeDb.query.infrastructureConnectorQualificationRuns.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, input.organizationId), eq(table.providerConnectionId, input.connectionId)),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  const stale = Boolean(
    connector?.lastSeenAt && Date.now() - connector.lastSeenAt.getTime() > 2 * 60_000,
  );
  return { connection, connector, qualification, stale };
}

export async function getKubernetesConnection(input: {
  organizationId: string;
  connectionId: string;
}) {
  return sanitizeConnection(await getKubernetesConnectionRecord(input));
}

export async function listKubernetesConnections(input: {
  organizationId: string;
}) {
  const connections =
    await knowledgeDb.query.environmentProviderConnections.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.provider, "kubernetes"),
        ),
      orderBy: (table, { desc }) => [desc(table.isDefault), desc(table.updatedAt)],
      columns: { id: true },
    });
  return Promise.all(
    connections.map((connection) =>
      getKubernetesConnection({
        organizationId: input.organizationId,
        connectionId: connection.id,
      }),
    ),
  );
}

export async function requireKubernetesConnectionForEnvironmentCreation(input: {
  organizationId: string;
  connectionId: string;
  runtimeTemplate: string;
}) {
  const current = await getKubernetesConnectionRecord(input);
  const { connection, qualification } = current;
  if (
    connection.status !== "ready" ||
    connection.revokedAt ||
    !connection.connectorId
  ) {
    throw new Error("Kubernetes connection is not ready for Environment creation.");
  }
  const config = kubernetesConnectionConfigV1Schema.parse(
    connection.configuration,
  );
  if (!config.runtimeTemplateAllowlist.some((template) => template === input.runtimeTemplate)) {
    throw new Error(
      "Runtime template is not allowed by the Kubernetes connection.",
    );
  }
  if (!qualification?.result) {
    throw new Error("Kubernetes connection has no current qualification.");
  }
  const report = kubernetesQualificationReportV1Schema.parse(
    qualification.result,
  );
  if (
    qualification.status !== "passed" ||
    report.configurationRevision !==
      kubernetesConnectionInfrastructureRevision(config) ||
    !qualificationPassed(report)
  ) {
    throw new Error("Kubernetes connection qualification is stale or expired.");
  }
  return { connection, config, report };
}

export async function revokeKubernetesConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string | null;
}) {
  const current = await getKubernetesConnectionRecord(input);
  const [environment, activeCommand, residual, inventoryCommand, latestCommand] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq, isNull, ne }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
          ne(table.status, "deleted"),
          isNull(table.archivedAt),
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.infrastructureConnectorCommands.findFirst({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
          inArray(table.status, ["queued", "claimed", "running"]),
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.environmentProviderResources.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
          isNull(table.deletedAt),
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.infrastructureConnectorCommands.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
          eq(table.commandType, "list_environment_resources"),
          eq(table.status, "completed"),
        ),
      orderBy: (table, { desc }) => [desc(table.completedAt)],
      columns: { id: true, result: true, completedAt: true },
    }),
    knowledgeDb.query.infrastructureConnectorCommands.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      columns: { id: true },
    }),
  ]);
  if (environment) {
    throw new Error(
      "Delete every Environment bound to this Kubernetes connection before revocation.",
    );
  }
  if (activeCommand) {
    throw new Error(
      "Kubernetes connection has an active command and cannot be revoked.",
    );
  }
  if (residual) {
    throw new Error(
      "Kubernetes connection has residual or unknown Kestrel resources.",
    );
  }
  if (!current.connector) {
    const displayName = await knowledgeDb.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-connection:${input.connectionId}`}, 0))`,
      );
      const [boundEnvironment, activeCommand, residualResource, connection] =
        await Promise.all([
          transaction.query.environments.findFirst({
            where: (table, { and, eq, isNull, ne }) =>
              and(
                eq(table.organizationId, input.organizationId),
                eq(table.providerConnectionId, input.connectionId),
                ne(table.status, "deleted"),
                isNull(table.archivedAt),
              ),
            columns: { id: true },
          }),
          transaction.query.infrastructureConnectorCommands.findFirst({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.organizationId, input.organizationId),
                eq(table.providerConnectionId, input.connectionId),
                inArray(table.status, ["queued", "claimed", "running"]),
              ),
            columns: { id: true },
          }),
          transaction.query.environmentProviderResources.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.organizationId, input.organizationId),
                eq(table.providerConnectionId, input.connectionId),
                isNull(table.deletedAt),
              ),
            columns: { id: true },
          }),
          transaction.query.environmentProviderConnections.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.id, input.connectionId),
                eq(table.organizationId, input.organizationId),
                eq(table.provider, "kubernetes"),
                isNull(table.revokedAt),
              ),
            columns: { displayName: true, connectorId: true },
          }),
        ]);
      if (boundEnvironment) {
        throw new Error(
          "Delete every Environment bound to this Kubernetes connection before revocation.",
        );
      }
      if (activeCommand) {
        throw new Error(
          "Kubernetes connection has an active command and cannot be revoked.",
        );
      }
      if (residualResource) {
        throw new Error(
          "Kubernetes connection has residual or unknown Kestrel resources.",
        );
      }
      if (!connection || connection.connectorId) {
        throw new Error("Kubernetes connection state changed; retry revocation.");
      }
      const now = new Date();
      const [updated] = await transaction
        .update(schema.environmentProviderConnections)
        .set({
          status: "revoked",
          isDefault: false,
          revokedByUserId: input.actorUserId,
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.environmentProviderConnections.id, input.connectionId),
            eq(
              schema.environmentProviderConnections.organizationId,
              input.organizationId,
            ),
            isNull(schema.environmentProviderConnections.revokedAt),
          ),
        )
        .returning({ displayName: schema.environmentProviderConnections.displayName });
      if (!updated) throw new Error("Kubernetes connection is unavailable.");
      return updated.displayName;
    });
    await logAdminEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: "environments",
      action: "kubernetes_connection.revoked",
      targetType: "provider-connection",
      targetId: input.connectionId,
      message: `Revoked Kubernetes connection ${displayName}.`,
    });
    return { revoked: true, displayName };
  }
  if (current.stale || !current.connector.lastSeenAt) {
    throw new Error(
      "Kubernetes connector must be online to prove clean revocation inventory.",
    );
  }
  const inventoryResult = inventoryCommand?.result
    ? infrastructureConnectorResultV1Schema.safeParse(inventoryCommand.result)
    : null;
  if (
    !inventoryCommand?.completedAt ||
    latestCommand?.id !== inventoryCommand.id ||
    !inventoryResult?.success ||
    inventoryResult.data.status !== "succeeded" ||
    inventoryResult.data.resources.length !== 0 ||
    (inventoryResult.data.output?.resourceObservations?.length ?? 0) !== 0
  ) {
    throw new Error(
      "Kubernetes connection requires a current empty connector inventory before revocation.",
    );
  }
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:kubernetes-connection:${input.connectionId}`}, 0))`,
    );
    const [boundEnvironment, activeCommand, residualResource, connection, connector, latestInventory] =
      await Promise.all([
        transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, ne }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.providerConnectionId, input.connectionId),
              ne(table.status, "deleted"),
              isNull(table.archivedAt),
            ),
          columns: { id: true },
        }),
        transaction.query.infrastructureConnectorCommands.findFirst({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.providerConnectionId, input.connectionId),
              inArray(table.status, ["queued", "claimed", "running"]),
            ),
          columns: { id: true },
        }),
        transaction.query.environmentProviderResources.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.providerConnectionId, input.connectionId),
              isNull(table.deletedAt),
            ),
          columns: { id: true },
        }),
        transaction.query.environmentProviderConnections.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.id, input.connectionId),
              eq(table.organizationId, input.organizationId),
              eq(table.provider, "kubernetes"),
              isNull(table.revokedAt),
            ),
          columns: { displayName: true, connectorId: true },
        }),
        transaction.query.infrastructureConnectorConnections.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, current.connector!.id),
              eq(table.organizationId, input.organizationId),
              isNull(table.revokedAt),
            ),
          columns: { id: true, lastSeenAt: true },
        }),
        transaction.query.infrastructureConnectorCommands.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.providerConnectionId, input.connectionId),
              eq(table.commandType, "list_environment_resources"),
              eq(table.status, "completed"),
            ),
          orderBy: (table, { desc }) => [desc(table.completedAt)],
          columns: { id: true, result: true, completedAt: true },
        }),
      ]);
    if (boundEnvironment) {
      throw new Error(
        "Delete every Environment bound to this Kubernetes connection before revocation.",
      );
    }
    if (activeCommand) {
      throw new Error(
        "Kubernetes connection has an active command and cannot be revoked.",
      );
    }
    if (residualResource) {
      throw new Error(
        "Kubernetes connection has residual or unknown Kestrel resources.",
      );
    }
    if (!connection || !connector || connection.connectorId !== connector.id) {
      throw new Error("Kubernetes connection state changed; retry revocation.");
    }
    if (
      !connector.lastSeenAt ||
      Date.now() - connector.lastSeenAt.getTime() > 2 * 60_000
    ) {
      throw new Error(
        "Kubernetes connector must be online to prove clean revocation inventory.",
      );
    }
    const liveInventory = latestInventory?.result
      ? infrastructureConnectorResultV1Schema.safeParse(latestInventory.result)
      : null;
    const latestCommand = await transaction.query.infrastructureConnectorCommands.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      columns: { id: true },
    });
    if (
      !latestInventory?.completedAt ||
      latestCommand?.id !== latestInventory.id ||
      !liveInventory?.success ||
      liveInventory.data.status !== "succeeded" ||
      liveInventory.data.resources.length !== 0 ||
      (liveInventory.data.output?.resourceObservations?.length ?? 0) !== 0
    ) {
      throw new Error(
        "Kubernetes connection requires a current empty connector inventory before revocation.",
      );
    }
    const now = new Date();
    const [revokedConnector] = await transaction
      .update(schema.infrastructureConnectorConnections)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.infrastructureConnectorConnections.id, connector.id),
          eq(
            schema.infrastructureConnectorConnections.organizationId,
            input.organizationId,
          ),
          isNull(schema.infrastructureConnectorConnections.revokedAt),
        ),
      )
      .returning({ id: schema.infrastructureConnectorConnections.id });
    if (!revokedConnector) throw new Error("Kubernetes connector is unavailable.");
    await transaction
      .update(schema.environmentProviderConnections)
      .set({
        status: "revoked",
        isDefault: false,
        revokedByUserId: input.actorUserId,
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.environmentProviderConnections.id, input.connectionId));
    await transaction
      .update(schema.infrastructureConnectorCommands)
      .set({
        status: "cancelled",
        claimTokenHash: null,
        claimExpiresAt: null,
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(
            schema.infrastructureConnectorCommands.organizationId,
            input.organizationId,
          ),
          eq(
            schema.infrastructureConnectorCommands.providerConnectionId,
            input.connectionId,
          ),
          inArray(schema.infrastructureConnectorCommands.status, [
            "queued",
            "claimed",
            "running",
          ]),
        ),
      );
    await transaction
      .update(schema.infrastructureConnectorQualificationRuns)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(
            schema.infrastructureConnectorQualificationRuns.organizationId,
            input.organizationId,
          ),
          eq(
            schema.infrastructureConnectorQualificationRuns.providerConnectionId,
            input.connectionId,
          ),
          inArray(schema.infrastructureConnectorQualificationRuns.status, [
            "queued",
            "running",
          ]),
        ),
      );
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "kubernetes_connection.revoked",
    targetType: "provider-connection",
    targetId: input.connectionId,
    message: `Revoked Kubernetes connection ${current.connection.displayName}.`,
  });
  return { revoked: true, displayName: current.connection.displayName };
}

export async function getKubernetesConnectionDiagnostic(input: {
  organizationId: string;
  connectionId: string;
}) {
  const connection = await getKubernetesConnection(input);
  const [environments, resources, commands] = await Promise.all([
    knowledgeDb.query.environments.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
        ),
      columns: {
        id: true,
        name: true,
        status: true,
        runtimeTemplate: true,
        workspaceLimit: true,
        failureCode: true,
        failureMessage: true,
        updatedAt: true,
      },
    }),
    knowledgeDb.query.environmentProviderResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
        ),
      columns: {
        id: true,
        environmentId: true,
        workspaceId: true,
        replacementId: true,
        resourceRole: true,
        externalId: true,
        desiredRevision: true,
        observedGeneration: true,
        state: true,
        deletedAt: true,
        updatedAt: true,
      },
    }),
    knowledgeDb.query.infrastructureConnectorCommands.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.providerConnectionId, input.connectionId),
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: 200,
      columns: {
        id: true,
        operationId: true,
        envelope: true,
        commandType: true,
        desiredRevision: true,
        status: true,
        attempt: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        completedAt: true,
      },
    }),
  ]);
  const operations = environments.length
    ? await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.organizationId, input.organizationId),
            inArray(
              table.environmentId,
              environments.map((environment) => environment.id),
            ),
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
        limit: 200,
        columns: {
          id: true,
          environmentId: true,
          workspaceId: true,
          type: true,
          status: true,
          stage: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          completedAt: true,
        },
      })
    : [];
  return {
    contract: "kubernetes-byoc-diagnostic-v1" as const,
    generatedAt: new Date().toISOString(),
    connection,
    environments,
    resources,
    operations,
    commands: commands.map(({ envelope, ...command }) => {
      const parsed = infrastructureConnectorCommandV1Schema.safeParse(envelope);
      return {
        ...command,
        environmentId: parsed.success ? parsed.data.environmentId ?? null : null,
        workspaceId: parsed.success ? parsed.data.workspaceId ?? null : null,
      };
    }),
  };
}

export async function proveKubernetesQualificationEndpoint(input: {
  authorization: KubernetesConnectorAuthorization;
  value: unknown;
}) {
  const body = z
    .object({
      runId: z.union([
        z.string().uuid(),
        z.string().regex(/^k8s-[a-f0-9]{48}$/u),
      ]),
      url: z.string().url(),
      nonce: z.string().regex(/^[a-f0-9]{48}$/u),
    })
    .strict()
    .parse(input.value);
  const run = await knowledgeDb.query.infrastructureConnectorQualificationRuns.findFirst({
    where: (table, { and, eq, gt }) =>
      and(
        eq(table.id, body.runId),
        eq(table.organizationId, input.authorization.connector.organizationId),
        eq(table.providerConnectionId, input.authorization.connection.id),
        gt(table.expiresAt, new Date()),
      ),
  });
  const config = kubernetesConnectionConfigV1Schema.parse(
    input.authorization.connection.configuration,
  );
  const target = new URL(body.url);
  const qualification = run && ["queued", "running"].includes(run.status);
  let expectedHost: string;
  let expectedEnvironmentId: string | null = null;
  if (qualification) {
    if (
      run.configRevision !==
      kubernetesConnectionInfrastructureRevision(config)
    ) {
      throw new Error("Qualification configuration is stale.");
    }
    const shortId = body.runId.replace(/-/gu, "").slice(0, 10);
    expectedHost = `${shortId}.${config.profile.baseDomain}`;
  } else {
    const command = await knowledgeDb.query.infrastructureConnectorCommands.findFirst({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.id, body.runId),
          eq(table.organizationId, input.authorization.connector.organizationId),
          eq(table.providerConnectionId, input.authorization.connection.id),
          eq(table.commandType, "ensure_environment_gateway"),
          inArray(table.status, ["claimed", "running"]),
        ),
    });
    if (!command) throw new Error("Gateway lifecycle command is unavailable.");
    const envelope = infrastructureConnectorCommandV1Schema.parse(command.envelope);
    const payload = envelope.payload as Record<string, unknown>;
    if (
      payload.configurationRevision !==
        kubernetesConnectionInfrastructureRevision(config) ||
      envelope.environmentId === undefined
    ) {
      throw new Error("Gateway lifecycle configuration is stale.");
    }
    expectedEnvironmentId = envelope.environmentId;
    const environmentHash = createHash("sha256")
      .update(envelope.environmentId)
      .digest("hex")
      .slice(0, 12);
    expectedHost = `${environmentHash}.${config.profile.baseDomain}`;
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== expectedHost ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/health" ||
    target.searchParams.size !== 1 ||
    target.searchParams.get("nonce") !== body.nonce
  ) {
    throw new Error("Qualification probe URL is outside the configured route boundary.");
  }
  const response = await fetch(target, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const responseValue = await response.json();
  if (!response.ok) throw new Error("Qualification endpoint did not return success.");
  if (qualification) {
    const responseBody = z
      .object({ ready: z.literal(true), nonce: z.literal(body.nonce) })
      .strict()
      .parse(responseValue);
    return { passed: responseBody.ready, hostname: expectedHost };
  }
  const responseBody = z
    .object({
      ok: z.literal(true),
      configurationReady: z.literal(true),
      environmentId: z.literal(expectedEnvironmentId!),
      gatewayId: z.literal("gateway"),
      nonce: z.literal(body.nonce),
    })
    .parse(responseValue);
  return { passed: responseBody.ok, hostname: expectedHost };
}

export const kubernetesConnectorRuntime = {
  claim: (authorization: KubernetesConnectorAuthorization) =>
    claimInfrastructureConnectorCommand({
      organizationId: authorization.connector.organizationId,
      connectorId: authorization.connector.id,
      leaseSeconds: 90,
    }),
  lease: renewInfrastructureConnectorCommandLease,
  event: appendInfrastructureConnectorCommandEvent,
  revoke: revokeInfrastructureConnector,
};

function sanitizeEnrollment(request: typeof schema.infrastructureConnectorEnrollmentRequests.$inferSelect) {
  return {
    id: request.id,
    connectorName: request.connectorName,
    connectorVersion: request.connectorVersion,
    fingerprint: request.fingerprint,
    status: request.status,
    expiresAt: request.expiresAt,
    organizationId: request.organizationId,
    providerConnectionId: request.providerConnectionId,
    clusterMetadata: request.clusterMetadata,
    createdAt: request.createdAt,
  };
}

function safeInfrastructureRevision(value: unknown) {
  const parsed = kubernetesConnectionConfigV1Schema.safeParse(value);
  return parsed.success
    ? kubernetesConnectionInfrastructureRevision(parsed.data)
    : null;
}

async function sanitizeConnection(
  current: Awaited<ReturnType<typeof getKubernetesConnectionRecord>>,
) {
  const { connection, connector, qualification, stale } = current;
  const configuration = kubernetesConnectionConfigV1Schema.safeParse(
    connection.configuration,
  );
  const report = qualification?.result
    ? kubernetesQualificationReportV1Schema.safeParse(qualification.result)
    : null;
  const [activeEnvironments, activeCommand, residual, inventoryCommand, latestCommand] =
    await Promise.all([
      knowledgeDb.query.environments.findMany({
        where: (table, { and, eq, isNull, ne }) =>
          and(
            eq(table.organizationId, connection.organizationId),
            eq(table.providerConnectionId, connection.id),
            ne(table.status, "deleted"),
            isNull(table.archivedAt),
          ),
        columns: { id: true },
      }),
      knowledgeDb.query.infrastructureConnectorCommands.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.organizationId, connection.organizationId),
            eq(table.providerConnectionId, connection.id),
            inArray(table.status, ["queued", "claimed", "running"]),
          ),
        columns: { id: true },
      }),
      knowledgeDb.query.environmentProviderResources.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, connection.organizationId),
            eq(table.providerConnectionId, connection.id),
            isNull(table.deletedAt),
          ),
        columns: { id: true },
      }),
      knowledgeDb.query.infrastructureConnectorCommands.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, connection.organizationId),
            eq(table.providerConnectionId, connection.id),
            eq(table.commandType, "list_environment_resources"),
            eq(table.status, "completed"),
          ),
        orderBy: (table, { desc }) => [desc(table.completedAt)],
        columns: { id: true, result: true },
      }),
      knowledgeDb.query.infrastructureConnectorCommands.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, connection.organizationId),
            eq(table.providerConnectionId, connection.id),
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
        columns: { id: true },
      }),
    ]);
  let compatible = false;
  if (connector) {
    try {
      negotiateInfrastructureConnectorV1({
        connectionId: connection.id,
        connectorVersion: connector.connectorVersion,
        commandVersions: connector.supportedCommandVersions,
        resultVersions: connector.supportedResultVersions,
      });
      compatible = true;
    } catch {
      compatible = false;
    }
  }
  const presence = connector?.lastSeenAt
    ? stale
      ? "offline"
      : "online" : "unknown";
  const inventory = inventoryCommand?.result
    ? infrastructureConnectorResultV1Schema.safeParse(inventoryCommand.result)
    : null;
  const emptyInventory = Boolean(
    inventory?.success &&
      inventory.data.status === "succeeded" &&
      latestCommand?.id === inventoryCommand?.id &&
      inventory.data.resources.length === 0 &&
      (inventory.data.output?.resourceObservations?.length ?? 0) === 0,
  );
  return {
    id: connection.id,
    displayName: connection.displayName,
    isDefault: connection.isDefault,
    status: connection.status,
    supportStatus: connection.supportStatus,
    presence,
    lastSeenAt: connector?.lastSeenAt ?? connection.lastSeenAt,
    lastQualifiedAt: connection.lastQualifiedAt,
    failure:
      connection.failureCode || connection.failureMessage
        ? {
            code: connection.failureCode,
            message: connection.failureMessage,
          }
        : null,
    activeEnvironmentCount: activeEnvironments.length,
    connector: connector
      ? {
          id: connector.id,
          version: connector.connectorVersion,
          commandVersions: connector.supportedCommandVersions,
          resultVersions: connector.supportedResultVersions,
          compatible,
          status: connector.status,
        }
      : null,
    configuration: {
      value: configuration.success
        ? configuration.data
        : kubernetesConnectionConfigurationDraft(connection),
      revision: configuration.success
        ? kubernetesConnectionConfigRevision(configuration.data)
        : null,
      infrastructureRevision: configuration.success
        ? kubernetesConnectionInfrastructureRevision(configuration.data)
        : null,
      configured: configuration.success,
      frozen: activeEnvironments.length > 0,
    },
    qualification: qualification
      ? {
          id: qualification.id,
          status: qualification.status,
          configRevision: qualification.configRevision,
          createdAt: qualification.createdAt,
          completedAt: qualification.completedAt,
          expiresAt: qualification.expiresAt,
          report: report?.success
            ? {
                evidenceClass: report.data.evidenceClass,
                observed: report.data.observed,
                checks: report.data.checks,
                cleanup: report.data.cleanup,
              }
            : null,
        }
      : null,
    revocationReady:
      activeEnvironments.length === 0 &&
      !activeCommand &&
      !residual &&
      (current.connector
        ? emptyInventory && presence === "online"
        : true) &&
      connection.status !== "revoked",
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function kubernetesConnectionConfigurationDraft(
  connection: typeof schema.environmentProviderConnections.$inferSelect,
) {
  return {
    contract: "kubernetes-connection-config-v1" as const,
    displayName: connection.displayName,
    isDefault: connection.isDefault,
    runtimeTemplateAllowlist: [],
    qualificationProbeImage: "",
    attestationEvidenceNote: "",
    profile: {
      contract: "kubernetes-byoc-profile-v1" as const,
      selectedCertificationProfile: null,
      namespacePrefix: "",
      baseDomain: "",
      storageClassName: "",
      volumeSnapshotClassName: "",
      controllerNamespace: "",
      controllerPodSelector: {},
      pullSecretRef: null,
      encryptionAttestations: {
        persistentVolumes: {
          encryption: "unknown" as const,
          evidenceRef: null,
        },
        kubernetesSecrets: {
          encryption: "unknown" as const,
          evidenceRef: null,
        },
      },
      edge: { mode: "ingress" as const, ingressClassName: "" },
      platform: {
        distribution: "other" as const,
        computeProfile: "",
        networkPolicyProvider: "",
        storageCsiDriver: "",
        snapshotCsiDriver: "",
        edgeController: "",
      },
    },
  };
}
