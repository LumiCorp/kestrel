import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  connectorVersionListSchema,
  infrastructureConnectorEventV1Schema,
} from "./provider-persistence-contracts";
import {
  infrastructureConnectorCommandV1Schema,
  infrastructureConnectorResultV1Schema,
  negotiateInfrastructureConnectorV1,
  parseInfrastructureConnectorPresenceV1,
  type InfrastructureConnectorCommandV1,
  type InfrastructureConnectorResultV1,
} from "./providers/connector-contracts";

const ACTIVE_COMMAND_STATUSES = ["claimed", "running"] as const;

export class InfrastructureConnectorStoreError extends Error {
  constructor(
    readonly code:
      | "CONNECTOR_NOT_FOUND"
      | "CONNECTOR_REVOKED"
      | "CONNECTOR_COMMAND_CONFLICT"
      | "CONNECTOR_CLAIM_REJECTED"
      | "CONNECTOR_EVENT_GAP"
      | "CONNECTOR_EVENT_CONFLICT"
      | "CONNECTOR_RESULT_REJECTED"
      | "CONNECTOR_NONCE_REPLAY",
    message: string,
  ) {
    super(message);
    this.name = "InfrastructureConnectorStoreError";
  }
}

const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashPayload = (value: unknown) => hashSecret(stableJson(value));

export async function createInfrastructureConnectorEnrollmentRequest(input: {
  organizationId: string;
  providerConnectionId: string;
  secretHash: string;
  fingerprint: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  requestedByUserId?: string | null | undefined;
  expiresAt: Date;
}) {
  const connection =
    await knowledgeDb.query.environmentProviderConnections.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.providerConnectionId),
          eq(table.organizationId, input.organizationId),
          eq(table.provider, "kubernetes"),
          isNull(table.revokedAt),
        ),
      columns: { id: true },
    });
  if (!connection) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_NOT_FOUND",
      "Kubernetes provider connection is unavailable.",
    );
  }
  const [created] = await knowledgeDb
    .insert(schema.infrastructureConnectorEnrollmentRequests)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      providerConnectionId: input.providerConnectionId,
      connectorName: "Legacy connector",
      connectorVersion: "unknown",
      supportedCommandVersions: ["infrastructure-connector-command-v1"],
      supportedResultVersions: ["infrastructure-connector-result-v1"],
      clusterMetadata: {},
      secretHash: input.secretHash,
      fingerprint: input.fingerprint,
      signingPublicKey: input.signingPublicKey,
      encryptionPublicKey: input.encryptionPublicKey,
      requestedByUserId: input.requestedByUserId ?? null,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!created) throw new Error("Connector enrollment request creation failed.");
  return created;
}

export async function createInfrastructureConnectorConnection(input: {
  organizationId: string;
  providerConnectionId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  credentialHash: string;
  connectorVersion: string;
  supportedCommandVersions: string[];
  supportedResultVersions: string[];
}) {
  const commandVersions = connectorVersionListSchema.parse(
    input.supportedCommandVersions,
  );
  const resultVersions = connectorVersionListSchema.parse(
    input.supportedResultVersions,
  );
  negotiateInfrastructureConnectorV1({
    connectionId: input.providerConnectionId,
    connectorVersion: input.connectorVersion,
    commandVersions,
    resultVersions,
  });
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const providerConnection =
      await transaction.query.environmentProviderConnections.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.providerConnectionId),
            eq(table.organizationId, input.organizationId),
            eq(table.provider, "kubernetes"),
            isNull(table.revokedAt),
          ),
        columns: { id: true },
      });
    if (!providerConnection) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_NOT_FOUND",
        "Kubernetes provider connection is unavailable.",
      );
    }
    const connectorId = crypto.randomUUID();
    const [connector] = await transaction
      .insert(schema.infrastructureConnectorConnections)
      .values({
        id: connectorId,
        organizationId: input.organizationId,
        providerConnectionId: input.providerConnectionId,
        signingPublicKey: input.signingPublicKey,
        encryptionPublicKey: input.encryptionPublicKey,
        currentCredentialHash: input.credentialHash,
        supportedCommandVersions: commandVersions,
        supportedResultVersions: resultVersions,
        connectorVersion: input.connectorVersion,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!connector) throw new Error("Connector connection creation failed.");
    await transaction
      .update(schema.environmentProviderConnections)
      .set({
        connectorId,
        status: "enrolling",
        updatedAt: now,
      })
      .where(eq(schema.environmentProviderConnections.id, input.providerConnectionId));
    return connector;
  });
}

export async function recordInfrastructureConnectorPresence(input: {
  organizationId: string;
  connectorId: string;
  replicaId: string;
  presence: unknown;
}) {
  const presence = parseInfrastructureConnectorPresenceV1(input.presence);
  const negotiated = negotiateInfrastructureConnectorV1(presence);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const connector =
      await transaction.query.infrastructureConnectorConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.connectorId),
            eq(table.organizationId, input.organizationId),
            eq(table.status, "active"),
          ),
      });
    if (!connector || presence.connectionId !== connector.providerConnectionId) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_NOT_FOUND",
        "Connector presence does not match an active tenant connection.",
      );
    }
    await transaction
      .insert(schema.infrastructureConnectorReplicaPresence)
      .values({
        connectorId: input.connectorId,
        replicaId: input.replicaId,
        connectorVersion: presence.connectorVersion,
        supportedCommandVersions: presence.commandVersions,
        supportedResultVersions: presence.resultVersions,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.infrastructureConnectorReplicaPresence.connectorId,
          schema.infrastructureConnectorReplicaPresence.replicaId,
        ],
        set: {
          connectorVersion: presence.connectorVersion,
          supportedCommandVersions: presence.commandVersions,
          supportedResultVersions: presence.resultVersions,
          lastSeenAt: now,
        },
      });
    await transaction
      .update(schema.infrastructureConnectorConnections)
      .set({
        connectorVersion: presence.connectorVersion,
        supportedCommandVersions: presence.commandVersions,
        supportedResultVersions: presence.resultVersions,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(schema.infrastructureConnectorConnections.id, input.connectorId));
    await transaction
      .update(schema.environmentProviderConnections)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(
        eq(
          schema.environmentProviderConnections.id,
          connector.providerConnectionId,
        ),
      );
    return negotiated;
  });
}

export async function consumeInfrastructureConnectorNonce(input: {
  organizationId: string;
  connectorId: string;
  nonce: string;
  expiresAt: Date;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  if (input.expiresAt <= now) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_NONCE_REPLAY",
      "Connector nonce is already expired.",
    );
  }
  const connector =
    await knowledgeDb.query.infrastructureConnectorConnections.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.connectorId),
          eq(table.organizationId, input.organizationId),
          eq(table.status, "active"),
        ),
      columns: { id: true },
    });
  if (!connector) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_NOT_FOUND",
      "Connector is unavailable.",
    );
  }
  try {
    await knowledgeDb
      .insert(schema.infrastructureConnectorRequestNonces)
      .values({
        connectorId: input.connectorId,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
        createdAt: now,
      });
  } catch (error) {
    const postgresCode =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (
      error instanceof Error &&
      postgresCode === "23505"
    ) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_NONCE_REPLAY",
        "Connector nonce has already been used.",
      );
    }
    throw error;
  }
}

export async function rotateInfrastructureConnectorCredential(input: {
  organizationId: string;
  connectorId: string;
  expectedCurrentCredentialHash: string;
  nextCredentialHash: string;
  previousCredentialExpiresAt: Date;
}) {
  const now = new Date();
  const [rotated] = await knowledgeDb
    .update(schema.infrastructureConnectorConnections)
    .set({
      previousCredentialHash: input.expectedCurrentCredentialHash,
      previousCredentialExpiresAt: input.previousCredentialExpiresAt,
      currentCredentialHash: input.nextCredentialHash,
      credentialRotatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.infrastructureConnectorConnections.id, input.connectorId),
        eq(
          schema.infrastructureConnectorConnections.organizationId,
          input.organizationId,
        ),
        eq(schema.infrastructureConnectorConnections.status, "active"),
        eq(
          schema.infrastructureConnectorConnections.currentCredentialHash,
          input.expectedCurrentCredentialHash,
        ),
      ),
    )
    .returning();
  if (!rotated) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_CLAIM_REJECTED",
      "Connector credential rotation lost its expected current credential.",
    );
  }
  return rotated;
}

export async function enqueueInfrastructureConnectorCommand(input: {
  operationId: string;
  command: InfrastructureConnectorCommandV1;
}) {
  const command = infrastructureConnectorCommandV1Schema.parse(input.command);
  if (command.id !== input.command.id) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_COMMAND_CONFLICT",
      "Connector command identity changed during validation.",
    );
  }
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`connector-command:${command.connectionId}:${command.idempotencyKey}`}, 0))`,
    );
    const [operation] = await transaction
      .select()
      .from(schema.environmentOperations)
      .where(
        and(
          eq(schema.environmentOperations.id, input.operationId),
          eq(
            schema.environmentOperations.organizationId,
            command.organizationId,
          ),
          command.environmentId
            ? eq(
                schema.environmentOperations.environmentId,
                command.environmentId,
              )
            : undefined,
          command.workspaceId
            ? eq(schema.environmentOperations.workspaceId, command.workspaceId)
            : undefined,
        ),
      )
      .for("update");
    const connection =
      await transaction.query.environmentProviderConnections.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, command.connectionId),
            eq(table.organizationId, command.organizationId),
            eq(table.provider, "kubernetes"),
            isNull(table.revokedAt),
          ),
        columns: { id: true, connectorId: true },
      });
    if (!(operation && connection)) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_COMMAND_CONFLICT",
        "Connector command does not match its operation and provider connection.",
      );
    }
    const existing =
      await transaction.query.infrastructureConnectorCommands.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.providerConnectionId, command.connectionId),
            eq(table.idempotencyKey, command.idempotencyKey),
          ),
      });
    if (existing) {
      const existingEnvelope = infrastructureConnectorCommandV1Schema.parse(
        existing.envelope,
      );
      if (
        existing.id !== command.id ||
        stableJson(commandReplayIdentity(existingEnvelope)) !==
          stableJson(commandReplayIdentity(command))
      ) {
        throw new InfrastructureConnectorStoreError(
          "CONNECTOR_COMMAND_CONFLICT",
          "Connector command idempotency key is already bound to another envelope.",
        );
      }
      return existing;
    }
    const now = new Date();
    const [created] = await transaction
      .insert(schema.infrastructureConnectorCommands)
      .values({
        id: command.id,
        organizationId: command.organizationId,
        providerConnectionId: command.connectionId,
        connectorId: connection.connectorId,
        operationId: input.operationId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        desiredRevision: command.desiredRevision,
        envelope: command,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Connector command enqueue failed.");
    await transaction
      .update(schema.environmentOperations)
      .set({
        connectorCommandId: command.id,
        result: {
          ...(operation.result ?? {}),
          connectorCommand: {
            id: command.id,
            desiredRevision: command.desiredRevision,
            contract: command.contract,
          },
        },
        updatedAt: now,
      })
      .where(eq(schema.environmentOperations.id, input.operationId));
    return created;
  });
}

function commandReplayIdentity(command: InfrastructureConnectorCommandV1) {
  const { encryptedSecrets: _encryptedSecrets, ...identity } = command;
  return identity;
}

export async function readInfrastructureConnectorCommand(input: {
  organizationId: string;
  commandId: string;
}) {
  const row = await knowledgeDb.query.infrastructureConnectorCommands.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.commandId),
        eq(table.organizationId, input.organizationId),
      ),
  });
  if (!row) return null;
  return {
    ...row,
    command: infrastructureConnectorCommandV1Schema.parse(row.envelope),
    result: row.result
      ? infrastructureConnectorResultV1Schema.parse(row.result)
      : null,
  };
}

export async function claimInfrastructureConnectorCommand(input: {
  organizationId: string;
  connectorId: string;
  leaseSeconds: number;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  const leaseSeconds = Math.min(Math.max(Math.floor(input.leaseSeconds), 5), 300);
  return knowledgeDb.transaction(async (transaction) => {
    const connector =
      await transaction.query.infrastructureConnectorConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, input.connectorId),
            eq(table.organizationId, input.organizationId),
            eq(table.status, "active"),
          ),
      });
    if (!connector) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_NOT_FOUND",
        "Connector is unavailable.",
      );
    }
    const [command] = await transaction
      .select()
      .from(schema.infrastructureConnectorCommands)
      .where(
        and(
          eq(
            schema.infrastructureConnectorCommands.organizationId,
            input.organizationId,
          ),
          eq(
            schema.infrastructureConnectorCommands.providerConnectionId,
            connector.providerConnectionId,
          ),
          or(
            eq(schema.infrastructureConnectorCommands.status, "queued"),
            and(
              inArray(schema.infrastructureConnectorCommands.status, [
                ...ACTIVE_COMMAND_STATUSES,
              ]),
              lt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.infrastructureConnectorCommands.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!command) return null;
    const claimToken = randomBytes(32).toString("base64url");
    const claimExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const [claimed] = await transaction
      .update(schema.infrastructureConnectorCommands)
      .set({
        connectorId: input.connectorId,
        status: "claimed",
        claimTokenHash: hashSecret(claimToken),
        claimExpiresAt,
        attempt: sql`${schema.infrastructureConnectorCommands.attempt} + 1`,
        claimedAt: now,
        startedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.infrastructureConnectorCommands.id, command.id))
      .returning();
    if (!claimed) return null;
    if (claimed.qualificationRunId) {
      await transaction
        .update(schema.infrastructureConnectorQualificationRuns)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(
              schema.infrastructureConnectorQualificationRuns.id,
              claimed.qualificationRunId,
            ),
            inArray(schema.infrastructureConnectorQualificationRuns.status, [
              "queued",
              "running",
            ]),
          ),
        );
    }
    return {
      command: infrastructureConnectorCommandV1Schema.parse(claimed.envelope),
      claimToken,
      claimExpiresAt,
      attempt: claimed.attempt,
      eventCursor: claimed.eventCursor,
    };
  });
}

export async function renewInfrastructureConnectorCommandLease(input: {
  organizationId: string;
  connectorId: string;
  commandId: string;
  claimToken: string;
  leaseSeconds: number;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  const claimExpiresAt = new Date(
    now.getTime() +
      Math.min(Math.max(Math.floor(input.leaseSeconds), 5), 300) * 1000,
  );
  const [renewed] = await knowledgeDb
    .update(schema.infrastructureConnectorCommands)
    .set({ claimExpiresAt, updatedAt: now })
    .where(
      and(
        eq(schema.infrastructureConnectorCommands.id, input.commandId),
        eq(
          schema.infrastructureConnectorCommands.organizationId,
          input.organizationId,
        ),
        eq(schema.infrastructureConnectorCommands.connectorId, input.connectorId),
        inArray(schema.infrastructureConnectorCommands.status, [
          ...ACTIVE_COMMAND_STATUSES,
        ]),
        eq(
          schema.infrastructureConnectorCommands.claimTokenHash,
          hashSecret(input.claimToken),
        ),
        gt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
      ),
    )
    .returning({ id: schema.infrastructureConnectorCommands.id });
  if (!renewed) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_CLAIM_REJECTED",
      "Connector command lease is no longer owned by this claim.",
    );
  }
  return { claimExpiresAt };
}

export async function markInfrastructureConnectorCommandRunning(input: {
  organizationId: string;
  connectorId: string;
  commandId: string;
  claimToken: string;
}) {
  const now = new Date();
  const [running] = await knowledgeDb
    .update(schema.infrastructureConnectorCommands)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.infrastructureConnectorCommands.id, input.commandId),
        eq(
          schema.infrastructureConnectorCommands.organizationId,
          input.organizationId,
        ),
        eq(schema.infrastructureConnectorCommands.connectorId, input.connectorId),
        eq(schema.infrastructureConnectorCommands.status, "claimed"),
        eq(
          schema.infrastructureConnectorCommands.claimTokenHash,
          hashSecret(input.claimToken),
        ),
        gt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
      ),
    )
    .returning({ id: schema.infrastructureConnectorCommands.id });
  if (!running) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_CLAIM_REJECTED",
      "Connector command cannot enter running state for this claim.",
    );
  }
}

export async function appendInfrastructureConnectorCommandEvent(input: {
  organizationId: string;
  connectorId: string;
  commandId: string;
  claimToken: string;
  event: unknown;
}) {
  const event = infrastructureConnectorEventV1Schema.parse(input.event);
  if (event.commandId !== input.commandId) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_EVENT_CONFLICT",
      "Connector event command identity does not match its route.",
    );
  }
  const payloadHash = hashPayload(event);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [command] = await transaction
      .select()
      .from(schema.infrastructureConnectorCommands)
      .where(
        and(
          eq(schema.infrastructureConnectorCommands.id, input.commandId),
          eq(
            schema.infrastructureConnectorCommands.organizationId,
            input.organizationId,
          ),
          eq(
            schema.infrastructureConnectorCommands.connectorId,
            input.connectorId,
          ),
          inArray(schema.infrastructureConnectorCommands.status, [
            ...ACTIVE_COMMAND_STATUSES,
          ]),
          eq(
            schema.infrastructureConnectorCommands.claimTokenHash,
            hashSecret(input.claimToken),
          ),
          gt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
        ),
      )
      .for("update");
    if (!command) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_CLAIM_REJECTED",
        "Connector event claim is no longer active.",
      );
    }
    if (event.sequence <= command.eventCursor) {
      const existing =
        await transaction.query.infrastructureConnectorCommandEvents.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.commandId, input.commandId),
              eq(table.sequence, event.sequence),
            ),
        });
      if (existing?.payloadHash === payloadHash) return { replayed: true };
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_EVENT_CONFLICT",
        "Connector event sequence was replayed with different content.",
      );
    }
    if (event.sequence !== command.eventCursor + 1) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_EVENT_GAP",
        `Connector event ${event.sequence} does not follow ${command.eventCursor}.`,
      );
    }
    await transaction.insert(schema.infrastructureConnectorCommandEvents).values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      commandId: input.commandId,
      sequence: event.sequence,
      event,
      payloadHash,
      createdAt: now,
    });
    await transaction
      .update(schema.infrastructureConnectorCommands)
      .set({ eventCursor: event.sequence, updatedAt: now })
      .where(eq(schema.infrastructureConnectorCommands.id, input.commandId));
    return { replayed: false };
  });
}

export async function completeInfrastructureConnectorCommand(input: {
  organizationId: string;
  connectorId: string;
  commandId: string;
  claimToken: string;
  result: InfrastructureConnectorResultV1;
}) {
  const result = infrastructureConnectorResultV1Schema.parse(input.result);
  if (result.commandId !== input.commandId) {
    throw new InfrastructureConnectorStoreError(
      "CONNECTOR_RESULT_REJECTED",
      "Connector result command identity does not match its route.",
    );
  }
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [command] = await transaction
      .select()
      .from(schema.infrastructureConnectorCommands)
      .where(
        and(
          eq(schema.infrastructureConnectorCommands.id, input.commandId),
          eq(
            schema.infrastructureConnectorCommands.organizationId,
            input.organizationId,
          ),
          eq(
            schema.infrastructureConnectorCommands.connectorId,
            input.connectorId,
          ),
          inArray(schema.infrastructureConnectorCommands.status, [
            ...ACTIVE_COMMAND_STATUSES,
          ]),
          eq(
            schema.infrastructureConnectorCommands.claimTokenHash,
            hashSecret(input.claimToken),
          ),
          gt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
        ),
      )
      .for("update");
    if (
      !command ||
      result.connectionId !== command.providerConnectionId ||
      result.commandType !== command.commandType ||
      result.observedRevision !== command.desiredRevision
    ) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_RESULT_REJECTED",
        "Connector result does not match the active command claim.",
      );
    }
    const status = result.status === "succeeded" ? "completed" : "failed";
    const [completed] = await transaction
      .update(schema.infrastructureConnectorCommands)
      .set({
        status,
        result,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message ?? null,
        claimTokenHash: null,
        claimExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.infrastructureConnectorCommands.id, input.commandId),
          inArray(schema.infrastructureConnectorCommands.status, [
            ...ACTIVE_COMMAND_STATUSES,
          ]),
          eq(
            schema.infrastructureConnectorCommands.claimTokenHash,
            hashSecret(input.claimToken),
          ),
          gt(schema.infrastructureConnectorCommands.claimExpiresAt, now),
        ),
      )
      .returning();
    if (!completed) {
      throw new InfrastructureConnectorStoreError(
        "CONNECTOR_CLAIM_REJECTED",
        "Connector command completion lost its claim.",
      );
    }
    return completed;
  });
}

export async function revokeInfrastructureConnector(input: {
  organizationId: string;
  connectorId: string;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [connector] = await transaction
      .update(schema.infrastructureConnectorConnections)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.infrastructureConnectorConnections.id, input.connectorId),
          eq(
            schema.infrastructureConnectorConnections.organizationId,
            input.organizationId,
          ),
          isNull(schema.infrastructureConnectorConnections.revokedAt),
        ),
      )
      .returning();
    if (!connector) return null;
    await transaction
      .update(schema.environmentProviderConnections)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(
            schema.environmentProviderConnections.id,
            connector.providerConnectionId,
          ),
          eq(
            schema.environmentProviderConnections.organizationId,
            input.organizationId,
          ),
        ),
      );
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
            connector.providerConnectionId,
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
            connector.providerConnectionId,
          ),
          inArray(schema.infrastructureConnectorQualificationRuns.status, [
            "queued",
            "running",
          ]),
        ),
      );
    return connector;
  });
}

export async function listInfrastructureConnectorCommandEvents(input: {
  organizationId: string;
  commandId: string;
}) {
  const rows = await knowledgeDb.query.infrastructureConnectorCommandEvents.findMany(
    {
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.commandId, input.commandId),
        ),
      orderBy: (table, { asc }) => [asc(table.sequence)],
    },
  );
  return rows.map((row) => ({
    ...row,
    event: infrastructureConnectorEventV1Schema.parse(row.event),
  }));
}
