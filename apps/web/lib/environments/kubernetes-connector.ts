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
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
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
    verificationPath: `/settings/infrastructure/kubernetes/enrollments/${request.id}`,
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
      !request ||
      !connectorSecretMatches(input.requestSecret, request.secretHash) ||
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
    !credential ||
    !connectorTimestampIsCurrent({ timestamp }) ||
    !nonce ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce) ||
    !signature
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
    !connection ||
    !connector ||
    !credentialAccepted ||
    !verifyConnectorRequestSignature({
      publicKey: connector.signingPublicKey,
      signature,
      method: input.request.method,
      path: new URL(input.request.url).pathname,
      timestamp,
      nonce,
      bodyText: input.bodyText,
    })
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
  actorUserId: string;
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
        qualificationEvidence: [],
        status: "enrolling",
        supportStatus: "unverified",
        configuredByUserId: input.actorUserId,
        attestedByUserId: input.actorUserId,
        configuredAt: now,
        attestedAt: now,
        qualifiedAt: null,
        lastQualifiedAt: null,
        qualifiedByUserId: null,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.environmentProviderConnections.id, input.connectionId))
      .returning();
    if (!updated) throw new Error("Kubernetes connection configuration failed.");
    return { connection: updated, configRevision: kubernetesConnectionConfigRevision(config) };
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
    const revision = kubernetesConnectionConfigRevision(config);
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
    const currentRevision = kubernetesConnectionConfigRevision(config);
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
    return { passed, support, stale };
  });
  return {
    ...completed,
    qualificationAccepted: qualificationState.passed,
    support: qualificationState.support,
    stale: qualificationState.stale,
  };
}

export async function getKubernetesConnection(input: {
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
  const effectiveConnection =
    stale && connection.status !== "revoked"
      ? (
          await knowledgeDb
            .update(schema.environmentProviderConnections)
            .set({
              status: "degraded",
              failureCode: "CONNECTOR_OFFLINE",
              failureMessage: "No connector presence was received for two minutes.",
              updatedAt: new Date(),
            })
            .where(eq(schema.environmentProviderConnections.id, connection.id))
            .returning()
        )[0] ?? connection
      : connection;
  return { connection: effectiveConnection, connector: connector ? { ...connector, currentCredentialHash: undefined, previousCredentialHash: undefined } : null, qualification, stale };
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
    if (run.configRevision !== kubernetesConnectionConfigRevision(config)) {
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
      payload.configurationRevision !== kubernetesConnectionConfigRevision(config) ||
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
