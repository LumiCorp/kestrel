import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  desktopCredentialEnvelopeContext,
  encryptDesktopCredential,
  ENVIRONMENT_ROUTER_AUDIENCE,
  normalizeDesktopCredentialEncryptionPublicKey,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import {
  parseRunnerEventV2,
  type RunnerEventEnvelope,
} from "@kestrel-agents/protocol";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { issueGatewayCredentialLease } from "@/lib/ai/gateway-credential-lease";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import type { ProjectRole } from "@/lib/projects/access";
import { toEnvironmentSlug } from "./contracts";
import {
  organizationEnvironmentCreateLockKey,
  organizationEnvironmentDefaultLockKey,
} from "./lifecycle-lock";
import {
  createExecutionAuthorizationRenewalToken,
  EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
} from "./authorization-renewal";

const ENROLLMENT_TTL_MS = 10 * 60_000;
const CONNECTOR_REQUEST_SKEW_SECONDS = 60;
const CONNECTOR_NONCE_TTL_MS = 5 * 60_000;
const CONNECTOR_CREDENTIAL_ROTATION_MS = 12 * 60 * 60_000;
const CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS = 5 * 60_000;
const COMMAND_LEASE_MS = 90_000;
const RUNTIME_RELEASE_FAILURE_CODES = new Set([
  "RUNTIME_RELEASE_DELIVERY_FAILED",
  "RUNTIME_RELEASE_ROUTE_UNAVAILABLE",
  "RUNTIME_BINDING_DEGRADED",
  "RUNTIME_NATIVE_SESSION_LOST",
  "RUNTIME_LIVE_WAIT_LOST",
  "CLAUDE_RUNTIME_FAILED",
  "CODEX_RUNTIME_FAILED",
]);
export const DESKTOP_ENVIRONMENTS_FEATURE_KEY = "desktop_environments";
const DESKTOP_ROUTE_CAPABILITIES = [
  "profile.read",
  "run.stream",
  "run.cancel",
  "runtime.release",
  "events.subscribe",
  "session.read",
] as const;

export const createDesktopEnrollmentRequestSchema = z.object({
  desktopName: z.string().trim().min(1).max(120),
  publicKey: z.string().trim().min(64).max(8192),
  encryptionPublicKey: z.string().trim().min(64).max(8192),
});

export const approveDesktopEnrollmentSchema = z.object({
  desktopName: z.string().trim().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
});

export const desktopPresenceSchema = z.object({
  capacity: z.number().int().min(1).max(16),
  activeRuns: z.number().int().min(0).max(16),
  desktopVersion: z.string().trim().min(1).max(80).optional(),
  runtimeVersion: z.string().trim().min(1).max(80).optional(),
  models: z
    .array(
      z.object({
        provider: z.string().trim().min(1).max(80),
        model: z.string().trim().min(1).max(200),
        health: z.enum(["ready", "unavailable"]),
      }),
    )
    .max(100)
    .default([]),
});

export const desktopWorkspaceCatalogSchema = z.object({
  workspaces: z
    .array(
      z.object({
        workspaceRef: z.string().trim().min(1).max(200),
        label: z.string().trim().min(1).max(200),
        available: z.boolean(),
      }),
    )
    .max(500),
});

export const desktopCommandClaimSchema = z.object({
  resumeCommandIds: z.array(z.string().uuid()).max(16).default([]),
  activeCommandIds: z.array(z.string().uuid()).max(16).default([]),
});

export const desktopCommandEventsSchema = z.object({
  claimToken: z.string().min(32).max(256),
  events: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        event: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(500)
    .superRefine((events, context) => {
      for (let index = 1; index < events.length; index += 1) {
        if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
          context.addIssue({
            code: "custom",
            message: "Desktop command event sequences must be contiguous.",
          });
          return;
        }
      }
    }),
});

export const desktopCommandCompletionSchema = z.object({
  claimToken: z.string().min(32).max(256),
  status: z.enum(["completed", "failed", "cancelled"]),
  failureCode: z.string().trim().min(1).max(120).optional(),
  failureMessage: z.string().trim().min(1).max(1000).optional(),
});

export const desktopRuntimeReleaseCompletionSchema = z.object({
  claimToken: z.string().min(32).max(256),
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal("released"), event: z.unknown() }),
    z.object({
      status: z.literal("failed"),
      failureCode: z.string().trim().min(1).max(120),
    }),
  ]),
});

export type DesktopConnectorAuthorization = {
  connection: typeof schema.desktopEnvironmentConnections.$inferSelect;
  environment: typeof schema.environments.$inferSelect;
};

export async function createDesktopEnrollmentRequest(input: unknown) {
  const parsed = createDesktopEnrollmentRequestSchema.parse(input);
  const publicKey = normalizeEd25519PublicKey(parsed.publicKey);
  const encryptionPublicKey = normalizeDesktopCredentialEncryptionPublicKey(
    parsed.encryptionPublicKey,
  );
  const requestSecret = randomBytes(32).toString("base64url");
  const now = new Date();
  const [request] = await knowledgeDb
    .insert(schema.desktopEnvironmentEnrollmentRequests)
    .values({
      id: crypto.randomUUID(),
      secretHash: hashSecret(requestSecret),
      publicKey: publicKey.pem,
      encryptionPublicKey,
      fingerprint: publicKey.fingerprint,
      desktopName: parsed.desktopName,
      status: "pending",
      expiresAt: new Date(now.getTime() + ENROLLMENT_TTL_MS),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!request) throw new Error("Desktop enrollment request was not created.");
  return {
    requestId: request.id,
    requestSecret,
    fingerprint: request.fingerprint,
    expiresAt: request.expiresAt.toISOString(),
    verificationPath: `/desktop/enroll/${request.id}`,
  };
}

export async function approveDesktopEnrollment(input: {
  requestId: string;
  organizationId: string;
  actorUserId: string;
  approval: unknown;
}) {
  await assertDesktopEnvironmentsEnabled(input.organizationId);
  const approval = approveDesktopEnrollmentSchema.parse(input.approval);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-enrollment:${input.requestId}`}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentCreateLockKey(input.organizationId)}, 0))`,
    );
    const request =
      await transaction.query.desktopEnvironmentEnrollmentRequests.findFirst({
        where: (table, { and, eq, gt }) =>
          and(
            eq(table.id, input.requestId),
            eq(table.status, "pending"),
            gt(table.expiresAt, now),
          ),
      });
    if (!request) throw new Error("Desktop enrollment request is unavailable.");

    const name = approval.desktopName ?? request.desktopName;
    const baseSlug = toEnvironmentSlug(name);
    const conflicting = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.slug, baseSlug),
          isNull(table.archivedAt),
        ),
      columns: { id: true },
    });
    const slug = conflicting
      ? `${baseSlug.slice(0, 55)}-${request.id.slice(0, 7)}`
      : baseSlug;
    const existingDefault = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.isDefault, true),
          isNull(table.archivedAt),
          notInArray(table.status, ["deleting", "deleted"]),
        ),
      columns: { id: true },
    });
    const isDefault = approval.isDefault ?? !existingDefault;
    if (isDefault && existingDefault) {
      await transaction
        .update(schema.environments)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(schema.environments.id, existingDefault.id));
    }

    const environmentId = crypto.randomUUID();
    const [environment] = await transaction
      .insert(schema.environments)
      .values({
        id: environmentId,
        organizationId: input.organizationId,
        createdByUserId: input.actorUserId,
        name,
        slug,
        provider: "desktop",
        region: "local",
        status: "ready",
        isDefault,
        runtimeTemplate: "desktop-local-v1",
        runtimeImage: "desktop-local",
        lastHealthAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!environment) throw new Error("Desktop Environment was not created.");

    const [connection] = await transaction
      .insert(schema.desktopEnvironmentConnections)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        environmentId,
        publicKey: request.publicKey,
        encryptionPublicKey: request.encryptionPublicKey,
        credentialHash: hashSecret(randomBytes(32).toString("base64url")),
        credentialRotatedAt: now,
        status: "active",
        capacity: 1,
        activeRuns: 0,
        desktopName: name,
        approvedByUserId: input.actorUserId,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!connection) throw new Error("Desktop connection was not created.");

    await transaction
      .update(schema.desktopEnvironmentEnrollmentRequests)
      .set({
        status: "approved",
        organizationId: input.organizationId,
        environmentId,
        requestedByUserId: input.actorUserId,
        approvedByUserId: input.actorUserId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.desktopEnvironmentEnrollmentRequests.id, request.id));
    return { environment, connection, fingerprint: request.fingerprint };
  });
}

export async function consumeDesktopEnrollment(input: {
  requestId: string;
  requestSecret: string;
}) {
  const request =
    await knowledgeDb.query.desktopEnvironmentEnrollmentRequests.findFirst({
      where: (table, { eq }) => eq(table.id, input.requestId),
    });
  if (
    !request ||
    !secretMatches(input.requestSecret, request.secretHash) ||
    request.expiresAt <= new Date()
  ) {
    throw new Error("Desktop enrollment request is unavailable.");
  }
  if (request.status !== "approved" || !request.environmentId) {
    return {
      status: request.status,
      expiresAt: request.expiresAt.toISOString(),
    };
  }
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-enrollment:${request.id}`}, 0))`,
    );
    const current =
      await transaction.query.desktopEnvironmentEnrollmentRequests.findFirst({
        where: (table, { eq }) => eq(table.id, request.id),
      });
    if (current?.status !== "approved" || !current.environmentId) {
      return {
        status: current?.status ?? "expired",
        expiresAt: request.expiresAt.toISOString(),
      };
    }
    const connection =
      await transaction.query.desktopEnvironmentConnections.findFirst({
        where: (table, { eq }) =>
          eq(table.environmentId, current.environmentId!),
      });
    if (!connection) throw new Error("Desktop connection is unavailable.");
    const connectorCredential = randomBytes(32).toString("base64url");
    const now = new Date();
    await transaction
      .update(schema.desktopEnvironmentConnections)
      .set({
        previousCredentialHash: connection.credentialHash,
        previousCredentialExpiresAt: new Date(
          now.getTime() + CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS,
        ),
        credentialHash: hashSecret(connectorCredential),
        credentialRotatedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.desktopEnvironmentConnections.id, connection.id));
    await transaction
      .update(schema.desktopEnvironmentEnrollmentRequests)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(eq(schema.desktopEnvironmentEnrollmentRequests.id, current.id));
    return {
      status: "active" as const,
      connectionId: connection.id,
      environmentId: connection.environmentId,
      organizationId: connection.organizationId,
      connectorCredential,
      ticketPublicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    };
  });
}

export async function authorizeDesktopConnector(input: {
  request: Request;
  bodyText: string;
  connectionId: string;
}): Promise<DesktopConnectorAuthorization> {
  const authorization = input.request.headers.get("authorization");
  const credential = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  const timestampValue = input.request.headers.get("x-kestrel-timestamp");
  const nonce = input.request.headers.get("x-kestrel-nonce");
  const signatureValue = input.request.headers.get("x-kestrel-signature");
  const timestamp = timestampValue ? Number(timestampValue) : Number.NaN;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !credential ||
    !Number.isInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > CONNECTOR_REQUEST_SKEW_SECONDS ||
    !nonce ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce) ||
    !signatureValue
  ) {
    throw new DesktopConnectorAuthError(
      "DESKTOP_CONNECTOR_AUTHORIZATION_INVALID",
    );
  }
  const connection =
    await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.id, input.connectionId), eq(table.status, "active")),
    });
  const currentCredentialMatches =
    connection && secretMatches(credential, connection.credentialHash);
  const previousCredentialMatches =
    connection?.previousCredentialHash &&
    connection.previousCredentialExpiresAt &&
    connection.previousCredentialExpiresAt > new Date() &&
    secretMatches(credential, connection.previousCredentialHash);
  if (
    !connection ||
    (!currentCredentialMatches && !previousCredentialMatches)
  ) {
    throw new DesktopConnectorAuthError(
      "DESKTOP_CONNECTOR_AUTHORIZATION_INVALID",
    );
  }
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.id, connection.environmentId),
        eq(table.organizationId, connection.organizationId),
        eq(table.provider, "desktop"),
        isNull(table.archivedAt),
      ),
  });
  if (!environment) {
    throw new DesktopConnectorAuthError("DESKTOP_ENVIRONMENT_REVOKED");
  }
  await assertDesktopEnvironmentsEnabled(connection.organizationId);
  const pathname = new URL(input.request.url).pathname;
  const digest = createHash("sha256").update(input.bodyText).digest("hex");
  const signingInput = [
    input.request.method.toUpperCase(),
    pathname,
    String(timestamp),
    nonce,
    digest,
  ].join("\n");
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureValue, "base64url");
  } catch {
    throw new DesktopConnectorAuthError("DESKTOP_CONNECTOR_SIGNATURE_INVALID");
  }
  if (
    !verify(
      null,
      Buffer.from(signingInput),
      createPublicKey(connection.publicKey),
      signature,
    )
  ) {
    throw new DesktopConnectorAuthError("DESKTOP_CONNECTOR_SIGNATURE_INVALID");
  }
  const now = new Date();
  try {
    await knowledgeDb.transaction(async (transaction) => {
      await transaction
        .delete(schema.desktopEnvironmentRequestNonces)
        .where(lt(schema.desktopEnvironmentRequestNonces.expiresAt, now));
      await transaction.insert(schema.desktopEnvironmentRequestNonces).values({
        connectionId: connection.id,
        nonce,
        expiresAt: new Date(now.getTime() + CONNECTOR_NONCE_TTL_MS),
        createdAt: now,
      });
    });
  } catch {
    throw new DesktopConnectorAuthError("DESKTOP_CONNECTOR_REPLAY_REJECTED");
  }
  return { connection, environment };
}

export async function assertDesktopEnvironmentsEnabled(organizationId: string) {
  const flag = await knowledgeDb.query.organizationFeatureFlags.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.key, DESKTOP_ENVIRONMENTS_FEATURE_KEY),
        eq(table.enabled, true),
      ),
    columns: { enabled: true },
  });
  if (!flag) {
    throw new DesktopConnectorAuthError("DESKTOP_ENVIRONMENT_NOT_ALLOWLISTED");
  }
}

export async function reportDesktopPresence(
  authorization: DesktopConnectorAuthorization,
  input: unknown,
) {
  const presence = desktopPresenceSchema.parse(input);
  if (presence.activeRuns > presence.capacity) {
    throw new Error("Desktop active runs cannot exceed capacity.");
  }
  const now = new Date();
  const rotateCredential =
    !authorization.connection.credentialRotatedAt ||
    now.getTime() - authorization.connection.credentialRotatedAt.getTime() >=
      CONNECTOR_CREDENTIAL_ROTATION_MS;
  const connectorCredential = rotateCredential
    ? randomBytes(32).toString("base64url")
    : undefined;
  const [connection] = await knowledgeDb
    .update(schema.desktopEnvironmentConnections)
    .set({
      capacity: presence.capacity,
      activeRuns: presence.activeRuns,
      desktopVersion: presence.desktopVersion,
      runtimeVersion: presence.runtimeVersion,
      advertisedModels: presence.models,
      ...(connectorCredential
        ? {
            previousCredentialHash: authorization.connection.credentialHash,
            previousCredentialExpiresAt: new Date(
              now.getTime() + CONNECTOR_PREVIOUS_CREDENTIAL_GRACE_MS,
            ),
            credentialHash: hashSecret(connectorCredential),
            credentialRotatedAt: now,
          }
        : {}),
      lastSeenAt: now,
      failureCode: null,
      failureMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          schema.desktopEnvironmentConnections.id,
          authorization.connection.id,
        ),
        eq(schema.desktopEnvironmentConnections.status, "active"),
      ),
    )
    .returning();
  if (!connection) throw new Error("Desktop connection is unavailable.");
  await knowledgeDb
    .update(schema.environments)
    .set({
      lastHealthAt: now,
      failureCode: null,
      failureMessage: null,
      updatedAt: now,
    })
    .where(eq(schema.environments.id, authorization.environment.id));
  return {
    ...describeDesktopConnection(connection, now),
    ...(connectorCredential ? { connectorCredential } : {}),
  };
}

export async function syncDesktopWorkspaceCatalog(
  authorization: DesktopConnectorAuthorization,
  input: unknown,
) {
  const catalog = desktopWorkspaceCatalogSchema.parse(input);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.desktopEnvironmentWorkspaceCatalog)
      .set({ availability: "missing", updatedAt: now })
      .where(
        eq(
          schema.desktopEnvironmentWorkspaceCatalog.environmentId,
          authorization.environment.id,
        ),
      );
    const rows = [];
    for (const workspace of catalog.workspaces) {
      const [row] = await transaction
        .insert(schema.desktopEnvironmentWorkspaceCatalog)
        .values({
          id: crypto.randomUUID(),
          organizationId: authorization.connection.organizationId,
          environmentId: authorization.environment.id,
          connectionId: authorization.connection.id,
          workspaceRef: workspace.workspaceRef,
          label: workspace.label,
          availability: workspace.available ? "available" : "missing",
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.desktopEnvironmentWorkspaceCatalog.environmentId,
            schema.desktopEnvironmentWorkspaceCatalog.workspaceRef,
          ],
          set: {
            label: workspace.label,
            availability: workspace.available ? "available" : "missing",
            lastSeenAt: now,
            updatedAt: now,
          },
        })
        .returning();
      if (row) rows.push(row);
    }
    return rows;
  });
}

export async function listDesktopWorkspaceCatalog(input: {
  organizationId: string;
  environmentId: string;
}) {
  return knowledgeDb.query.desktopEnvironmentWorkspaceCatalog.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
      ),
    orderBy: (table, { asc }) => [asc(table.label), asc(table.id)],
  });
}

export async function listVisibleProjectDesktopWorkspaceCatalog(input: {
  organizationId: string;
  role: ProjectRole;
  desktopCatalogId: string | null | undefined;
}) {
  if (input.role === "member" && !input.desktopCatalogId) return [];
  return knowledgeDb.query.desktopEnvironmentWorkspaceCatalog.findMany({
    where: (table, { and, eq, or }) =>
      and(
        eq(table.organizationId, input.organizationId),
        input.role === "member"
          ? eq(table.id, input.desktopCatalogId!)
          : or(
              eq(table.availability, "available"),
              ...(input.desktopCatalogId
                ? [eq(table.id, input.desktopCatalogId)]
                : []),
            ),
      ),
    orderBy: (table, { asc }) => [asc(table.label), asc(table.id)],
  });
}

export async function revokeDesktopEnvironment(input: {
  organizationId: string;
  environmentId: string;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [connection] = await transaction
      .update(schema.desktopEnvironmentConnections)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(
            schema.desktopEnvironmentConnections.organizationId,
            input.organizationId,
          ),
          eq(
            schema.desktopEnvironmentConnections.environmentId,
            input.environmentId,
          ),
          eq(schema.desktopEnvironmentConnections.status, "active"),
        ),
      )
      .returning();
    await transaction
      .update(schema.desktopEnvironmentCommands)
      .set({
        status: "cancelled",
        failureCode: "DESKTOP_ENVIRONMENT_REVOKED",
        failureMessage: "Desktop Environment access was revoked.",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(
            schema.desktopEnvironmentCommands.environmentId,
            input.environmentId,
          ),
          inArray(schema.desktopEnvironmentCommands.status, [
            "queued",
            "claimed",
            "running",
          ]),
        ),
      );
    await transaction
      .update(schema.environmentRunExecutions)
      .set({ status: "failed", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(
            schema.environmentRunExecutions.environmentId,
            input.environmentId,
          ),
          inArray(schema.environmentRunExecutions.status, [
            "routed",
            "running",
          ]),
        ),
      );
    const previews = await transaction
      .update(schema.workspacePreviewLeases)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.workspacePreviewLeases.environmentId, input.environmentId),
          eq(schema.workspacePreviewLeases.targetProvider, "desktop"),
          inArray(schema.workspacePreviewLeases.status, [
            "provisioning",
            "active",
          ]),
        ),
      )
      .returning({ id: schema.workspacePreviewLeases.id });
    if (previews.length > 0) {
      await transaction
        .update(schema.workspacePreviewAccessTokens)
        .set({ revokedAt: now })
        .where(
          inArray(
            schema.workspacePreviewAccessTokens.leaseId,
            previews.map((preview) => preview.id),
          ),
        );
    }
    return connection ?? null;
  });
}

export async function enqueueDesktopEnvironmentCommand(input: {
  id: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  executionId: string;
  payload: Record<string, unknown>;
}) {
  const [command] = await knowledgeDb
    .insert(schema.desktopEnvironmentCommands)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      commandType: "run.start",
      payload: input.payload,
      status: "queued",
    })
    .onConflictDoNothing({
      target: schema.desktopEnvironmentCommands.executionId,
    })
    .returning();
  return (
    command ??
    (await knowledgeDb.query.desktopEnvironmentCommands.findFirst({
      where: (table, { eq }) => eq(table.executionId, input.executionId),
    }))
  );
}

export async function claimDesktopEnvironmentCommand(
  authorization: DesktopConnectorAuthorization,
  input: unknown,
) {
  const claim = desktopCommandClaimSchema.parse(input);
  const now = new Date();
  const privateKey = process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "";
  const claimed = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-connection:${authorization.connection.id}`}, 0))`,
    );
    const connection =
      await transaction.query.desktopEnvironmentConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, authorization.connection.id),
            eq(table.status, "active"),
          ),
      });
    if (!connection) return null;
    if (claim.activeCommandIds.length > 0) {
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({
          claimExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(
              schema.desktopEnvironmentCommands.environmentId,
              authorization.environment.id,
            ),
            inArray(
              schema.desktopEnvironmentCommands.id,
              claim.activeCommandIds,
            ),
            inArray(schema.desktopEnvironmentCommands.status, [
              "claimed",
              "running",
            ]),
          ),
        );
    }

    const resumable =
      claim.resumeCommandIds.length > 0
        ? await transaction.query.desktopEnvironmentCommands.findFirst({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.environmentId, authorization.environment.id),
                inArray(table.id, claim.resumeCommandIds),
                inArray(table.status, ["claimed", "running"]),
              ),
            orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
          })
        : null;
    if (!resumable && connection.activeRuns >= connection.capacity) return null;
    const [eligible] = resumable
      ? []
      : await transaction
          .select({ command: schema.desktopEnvironmentCommands })
          .from(schema.desktopEnvironmentCommands)
          .innerJoin(
            schema.environmentRunExecutions,
            eq(
              schema.environmentRunExecutions.id,
              schema.desktopEnvironmentCommands.executionId,
            ),
          )
          .where(
            and(
              eq(
                schema.desktopEnvironmentCommands.environmentId,
                authorization.environment.id,
              ),
              ...(claim.activeCommandIds.length > 0
                ? [
                    notInArray(
                      schema.desktopEnvironmentCommands.id,
                      claim.activeCommandIds,
                    ),
                  ]
                : []),
              or(
                eq(schema.desktopEnvironmentCommands.status, "queued"),
                and(
                  inArray(schema.desktopEnvironmentCommands.status, [
                    "claimed",
                    "running",
                  ]),
                  lt(schema.desktopEnvironmentCommands.claimExpiresAt, now),
                ),
              ),
              sql`NOT EXISTS (
                SELECT 1
                FROM ${schema.desktopEnvironmentCommands} earlier_command
                INNER JOIN ${schema.environmentRunExecutions} earlier_execution
                  ON earlier_execution.id = earlier_command.execution_id
                WHERE earlier_execution.thread_id = ${schema.environmentRunExecutions.threadId}
                  AND earlier_command.status IN ('queued', 'claimed', 'running')
                  AND (
                    earlier_command.created_at,
                    earlier_command.id
                  ) < (
                    ${schema.desktopEnvironmentCommands.createdAt},
                    ${schema.desktopEnvironmentCommands.id}
                  )
              )`,
            ),
          )
          .orderBy(
            asc(schema.desktopEnvironmentCommands.createdAt),
            asc(schema.desktopEnvironmentCommands.id),
          )
          .limit(1);
    const command = resumable ?? eligible?.command;
    if (!command) return null;

    const [workspace, execution] = await Promise.all([
      transaction.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, command.workspaceId),
            eq(table.environmentId, authorization.environment.id),
            isNull(table.deletedAt),
          ),
      }),
      transaction.query.environmentRunExecutions.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, command.executionId),
            eq(table.environmentId, authorization.environment.id),
          ),
      }),
    ]);
    if (!(workspace?.desktopCatalogId && execution)) {
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({
          status: "failed",
          failureCode: "DESKTOP_WORKSPACE_UNAVAILABLE",
          failureMessage: "The bound Desktop workspace is unavailable.",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.desktopEnvironmentCommands.id, command.id));
      return null;
    }
    const catalog =
      await transaction.query.desktopEnvironmentWorkspaceCatalog.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, workspace.desktopCatalogId!),
            eq(table.organizationId, authorization.connection.organizationId),
            eq(table.environmentId, authorization.environment.id),
            eq(table.connectionId, authorization.connection.id),
            eq(table.availability, "available"),
          ),
      });
    if (!catalog) {
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({
          status: "failed",
          failureCode: "DESKTOP_WORKSPACE_REMOVED",
          failureMessage:
            "The Desktop project registration was removed or is unavailable.",
          completedAt: now,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(schema.desktopEnvironmentCommands.id, command.id));
      await transaction
        .update(schema.environmentRunExecutions)
        .set({ status: "failed", completedAt: now, updatedAt: now })
        .where(eq(schema.environmentRunExecutions.id, command.executionId));
      if (command.status === "claimed" || command.status === "running") {
        await transaction
          .update(schema.desktopEnvironmentConnections)
          .set({
            activeRuns: sql`greatest(${schema.desktopEnvironmentConnections.activeRuns} - 1, 0)`,
            updatedAt: now,
          })
          .where(eq(schema.desktopEnvironmentConnections.id, connection.id));
      }
      return null;
    }

    const claimToken = randomBytes(32).toString("base64url");
    const wasActive =
      command.status === "claimed" || command.status === "running";
    const [updated] = await transaction
      .update(schema.desktopEnvironmentCommands)
      .set({
        status: "claimed",
        claimTokenHash: hashSecret(claimToken),
        claimExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
        claimedAt: command.claimedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.desktopEnvironmentCommands.id, command.id))
      .returning();
    if (!updated) return null;
    if (!wasActive) {
      await transaction
        .update(schema.desktopEnvironmentConnections)
        .set({
          activeRuns: sql`${schema.desktopEnvironmentConnections.activeRuns} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.desktopEnvironmentConnections.id, connection.id));
    }
    const issuedAt = Math.floor(now.getTime() / 1000);
    const renewal = createExecutionAuthorizationRenewalToken();
    await transaction
      .update(schema.environmentRunExecutions)
      .set({
        authorizationRenewalTokenHash: renewal.tokenHash,
        updatedAt: now,
      })
      .where(eq(schema.environmentRunExecutions.id, execution.id));
    const [organization, project, thread, actor] = await Promise.all([
      transaction.query.organizations.findFirst({
        where: (table, { eq }) =>
          eq(table.id, authorization.connection.organizationId),
      }),
      execution.projectId
        ? transaction.query.projects.findFirst({
            where: (table, { and, eq }) =>
              and(
                eq(table.id, execution.projectId!),
                eq(
                  table.organizationId,
                  authorization.connection.organizationId,
                ),
              ),
          })
        : null,
      transaction.query.threads.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.id, execution.threadId),
            eq(table.organizationId, authorization.connection.organizationId),
          ),
      }),
      transaction.query.users.findFirst({
        where: (table, { eq }) => eq(table.id, execution.actorId),
      }),
    ]);
    return {
      command: updated,
      claimToken,
      provenance: {
        organizationId: authorization.connection.organizationId,
        organizationName: organization?.name ?? "Kestrel One organization",
        projectId: project?.id ?? execution.projectId,
        projectName: project?.name ?? "Unassigned project",
        threadId: execution.threadId,
        threadTitle: thread?.title ?? "Untitled thread",
        requestingUserId: execution.actorId,
        requestingUserName: actor?.name ?? "Kestrel One member",
        workspaceRef: catalog.workspaceRef,
        queuedAt: updated.createdAt.toISOString(),
      },
      executionTicket: signEnvironmentExecutionTicket({
        privateKey,
        ticket: {
          version: 2,
          audience: ENVIRONMENT_ROUTER_AUDIENCE,
          organizationId: execution.organizationId,
          environmentId: execution.environmentId,
          workspaceId: execution.workspaceId,
          threadId: execution.threadId,
          runId: execution.id,
          actorId: execution.actorId,
          agentId: "kestrel-one-desktop-connector",
          target: {
            provider: "desktop",
            connectionId: connection.id,
            workspaceRef: catalog.workspaceRef,
          },
          capabilities: [
            ...new Set([
              ...DESKTOP_ROUTE_CAPABILITIES,
              ...execution.effectiveCapabilities,
            ]),
          ],
          issuedAt,
          expiresAt: issuedAt + 300,
          nonce: crypto.randomUUID(),
        },
      }),
      authorizationRenewal: {
        version: EXECUTION_AUTHORIZATION_RENEWAL_VERSION,
        endpoint: new URL(
          `/api/runtime/executions/${encodeURIComponent(execution.id)}/authorization/renew`,
          resolveKestrelAppUrl(process.env),
        ).toString(),
        token: renewal.token,
      },
      cancelRequested: Boolean(updated.cancelRequestedAt),
    };
  });
  if (!claimed) return null;

  try {
    const modelGrant = await issueEncryptedDesktopModelGrant({
      authorization,
      executionId: claimed.command.executionId,
    });
    if (!modelGrant) return claimed;
    return {
      ...claimed,
      modelGrant,
    };
  } catch (error) {
    await failClaimedDesktopCommand({
      commandId: claimed.command.id,
      connectionId: authorization.connection.id,
      failureCode: "DESKTOP_MODEL_GRANT_UNAVAILABLE",
      failureMessage:
        error instanceof Error
          ? error.message
          : "The selected Kestrel One model is unavailable.",
    });
    throw error;
  }
}

export async function claimDesktopRuntimeRelease(
  authorization: DesktopConnectorAuthorization,
) {
  const now = new Date();
  const claimToken = randomBytes(32).toString("base64url");
  return await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-runtime-release:${authorization.connection.id}`}, 0))`,
    );
    const [candidate] = await transaction
      .select()
      .from(schema.runtimeBindingReleaseOutbox)
      .where(
        and(
          eq(
            schema.runtimeBindingReleaseOutbox.organizationId,
            authorization.connection.organizationId,
          ),
          eq(
            schema.runtimeBindingReleaseOutbox.environmentId,
            authorization.environment.id,
          ),
          or(
            inArray(schema.runtimeBindingReleaseOutbox.state, [
              "pending",
              "failed",
            ]),
            and(
              eq(schema.runtimeBindingReleaseOutbox.state, "delivering"),
              lt(schema.runtimeBindingReleaseOutbox.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(
        asc(schema.runtimeBindingReleaseOutbox.createdAt),
        asc(schema.runtimeBindingReleaseOutbox.id),
      )
      .limit(1);
    if (!candidate) return null;
    const claimExpiresAt = new Date(now.getTime() + COMMAND_LEASE_MS);
    const [claimed] = await transaction
      .update(schema.runtimeBindingReleaseOutbox)
      .set({
        state: "delivering",
        attempts: candidate.attempts + 1,
        claimTokenHash: hashSecret(claimToken),
        claimExpiresAt,
        claimedAt: now,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.runtimeBindingReleaseOutbox.id, candidate.id))
      .returning();
    if (!claimed) return null;
    return {
      release: {
        id: claimed.id,
        runtimeId: claimed.runtimeId,
        bindingId: claimed.bindingId,
        participantId: claimed.participantId,
        threadId: claimed.threadId,
        environmentId: claimed.environmentId,
        actorUserId: claimed.actorUserId,
      },
      claimToken,
      claimExpiresAt: claimExpiresAt.toISOString(),
    };
  });
}

export async function renewDesktopRuntimeReleaseLease(input: {
  authorization: DesktopConnectorAuthorization;
  releaseId: string;
  body: unknown;
}) {
  const body = z
    .object({ claimToken: z.string().min(32).max(256) })
    .parse(input.body);
  const release = await requireClaimedRuntimeRelease({
    authorization: input.authorization,
    releaseId: input.releaseId,
    claimToken: body.claimToken,
  });
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + COMMAND_LEASE_MS);
  const [renewed] = await knowledgeDb
    .update(schema.runtimeBindingReleaseOutbox)
    .set({ claimExpiresAt, updatedAt: now })
    .where(
      and(
        eq(schema.runtimeBindingReleaseOutbox.id, release.id),
        eq(schema.runtimeBindingReleaseOutbox.state, "delivering"),
      ),
    )
    .returning();
  if (!renewed) {
    throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_CLAIM_INVALID");
  }
  return { claimExpiresAt: claimExpiresAt.toISOString() };
}

export async function completeDesktopRuntimeRelease(input: {
  authorization: DesktopConnectorAuthorization;
  releaseId: string;
  body: unknown;
}) {
  const body = desktopRuntimeReleaseCompletionSchema.parse(input.body);
  const release = await requireClaimedRuntimeRelease({
    authorization: input.authorization,
    releaseId: input.releaseId,
    claimToken: body.claimToken,
    allowReleased: body.outcome.status === "released",
  });
  const now = new Date();
  if (body.outcome.status === "failed") {
    if (release.state === "released") {
      throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_ALREADY_ACKNOWLEDGED");
    }
    const failureCode = RUNTIME_RELEASE_FAILURE_CODES.has(
      body.outcome.failureCode,
    )
      ? body.outcome.failureCode
      : "RUNTIME_RELEASE_DELIVERY_FAILED";
    const [failed] = await knowledgeDb
      .update(schema.runtimeBindingReleaseOutbox)
      .set({
        state: "failed",
        claimTokenHash: null,
        claimExpiresAt: null,
        failureCode,
        failureMessage: "Runtime binding release will be retried.",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.runtimeBindingReleaseOutbox.id, release.id),
          eq(schema.runtimeBindingReleaseOutbox.state, "delivering"),
        ),
      )
      .returning();
    if (!failed) {
      throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_CLAIM_INVALID");
    }
    return failed;
  }

  const event = parseRunnerEventV2(body.outcome.event);
  assertRuntimeReleaseAcknowledgement(release, event);
  if (release.state === "released") {
    if (release.acknowledgementEventId !== event.id) {
      throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_ACK_CONFLICT");
    }
    return release;
  }
  const [completed] = await knowledgeDb
    .update(schema.runtimeBindingReleaseOutbox)
    .set({
      state: "released",
      acknowledgementEventId: event.id,
      acknowledgedAt: now,
      claimExpiresAt: null,
      failureCode: null,
      failureMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.runtimeBindingReleaseOutbox.id, release.id),
        eq(schema.runtimeBindingReleaseOutbox.state, "delivering"),
      ),
    )
    .returning();
  if (!completed) {
    throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_CLAIM_INVALID");
  }
  return completed;
}

export async function appendDesktopCommandEvents(input: {
  authorization: DesktopConnectorAuthorization;
  commandId: string;
  body: unknown;
}) {
  const body = desktopCommandEventsSchema.parse(input.body);
  const command = await requireClaimedCommand({
    connection: input.authorization.connection,
    commandId: input.commandId,
    claimToken: body.claimToken,
  });
  const now = new Date();
  const acknowledgedSequence = await knowledgeDb.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-command-events:${command.id}`}, 0))`,
      );
      const [cursor] = await transaction
        .select({
          sequence: max(schema.desktopEnvironmentCommandEvents.sequence),
        })
        .from(schema.desktopEnvironmentCommandEvents)
        .where(
          eq(schema.desktopEnvironmentCommandEvents.commandId, command.id),
        );
      const currentSequence = cursor?.sequence ?? 0;
      const firstNew = body.events.find(
        (event) => event.sequence > currentSequence,
      );
      if (firstNew && firstNew.sequence !== currentSequence + 1) {
        throw new Error("Desktop command event sequence has a gap.");
      }
      for (const item of body.events) {
        await transaction
          .insert(schema.desktopEnvironmentCommandEvents)
          .values({
            commandId: command.id,
            sequence: item.sequence,
            event: item.event,
            createdAt: now,
          })
          .onConflictDoNothing();
      }
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({
          status: "running",
          claimExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
          updatedAt: now,
        })
        .where(eq(schema.desktopEnvironmentCommands.id, command.id));
      await transaction
        .update(schema.environmentRunExecutions)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(eq(schema.environmentRunExecutions.id, command.executionId));
      return Math.max(
        currentSequence,
        ...body.events.map((event) => event.sequence),
      );
    },
  );
  return {
    acknowledgedSequence,
    cancelRequested: Boolean(command.cancelRequestedAt),
  };
}

export async function renewDesktopEnvironmentCommandLease(input: {
  authorization: DesktopConnectorAuthorization;
  commandId: string;
  body: unknown;
}) {
  const body = z
    .object({ claimToken: z.string().min(32).max(256) })
    .parse(input.body);
  const command = await requireClaimedCommand({
    connection: input.authorization.connection,
    commandId: input.commandId,
    claimToken: body.claimToken,
  });
  const now = new Date();
  await knowledgeDb
    .update(schema.desktopEnvironmentCommands)
    .set({
      claimExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.desktopEnvironmentCommands.id, command.id),
        inArray(schema.desktopEnvironmentCommands.status, [
          "claimed",
          "running",
        ]),
      ),
    );
  const modelGrant = await issueEncryptedDesktopModelGrant({
    authorization: input.authorization,
    executionId: command.executionId,
  }).catch(() => undefined);
  return {
    cancelRequested: Boolean(command.cancelRequestedAt),
    ...(modelGrant ? { modelGrant } : {}),
  };
}

async function issueEncryptedDesktopModelGrant(input: {
  authorization: DesktopConnectorAuthorization;
  executionId: string;
}) {
  const modelGrant = await knowledgeDb.query.environmentModelGrants.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.runId, input.executionId),
        eq(table.organizationId, input.authorization.connection.organizationId),
        eq(table.environmentId, input.authorization.environment.id),
        eq(table.status, "active"),
      ),
  });
  if (!modelGrant) return undefined;
  const lease = await issueGatewayCredentialLease({
    version: "gateway-credential-lease-v3",
    gatewayId: modelGrant.gatewayId,
    organizationId: modelGrant.organizationId,
    environmentId: modelGrant.environmentId,
    rawModelId: modelGrant.rawModelId,
  });
  return encryptDesktopCredential({
    value: lease,
    recipientPublicKey: input.authorization.connection.encryptionPublicKey,
    context: desktopCredentialEnvelopeContext({
      organizationId: modelGrant.organizationId,
      environmentId: modelGrant.environmentId,
      connectionId: input.authorization.connection.id,
      runId: modelGrant.runId,
    }),
  });
}

export async function completeDesktopEnvironmentCommand(input: {
  authorization: DesktopConnectorAuthorization;
  commandId: string;
  body: unknown;
}) {
  const body = desktopCommandCompletionSchema.parse(input.body);
  const command = await requireClaimedCommand({
    connection: input.authorization.connection,
    commandId: input.commandId,
    claimToken: body.claimToken,
  });
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [completed] = await transaction
      .update(schema.desktopEnvironmentCommands)
      .set({
        status: body.status,
        failureCode: body.failureCode ?? null,
        failureMessage: body.failureMessage ?? null,
        completedAt: now,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.desktopEnvironmentCommands.id, command.id),
          inArray(schema.desktopEnvironmentCommands.status, [
            "claimed",
            "running",
          ]),
        ),
      )
      .returning();
    if (!completed) return command;
    await transaction
      .update(schema.environmentRunExecutions)
      .set({
        status: body.status,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.environmentRunExecutions.id, command.executionId));
    await transaction
      .update(schema.desktopEnvironmentConnections)
      .set({
        activeRuns: sql`greatest(${schema.desktopEnvironmentConnections.activeRuns} - 1, 0)`,
        updatedAt: now,
      })
      .where(
        eq(
          schema.desktopEnvironmentConnections.id,
          input.authorization.connection.id,
        ),
      );
    return completed;
  });
}

async function failClaimedDesktopCommand(input: {
  commandId: string;
  connectionId: string;
  failureCode: string;
  failureMessage: string;
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const command =
      await transaction.query.desktopEnvironmentCommands.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.id, input.commandId),
            inArray(table.status, ["claimed", "running"]),
          ),
      });
    if (!command) return;
    await transaction
      .update(schema.desktopEnvironmentCommands)
      .set({
        status: "failed",
        failureCode: input.failureCode,
        failureMessage: input.failureMessage.slice(0, 1000),
        completedAt: now,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(schema.desktopEnvironmentCommands.id, command.id));
    await transaction
      .update(schema.environmentRunExecutions)
      .set({ status: "failed", completedAt: now, updatedAt: now })
      .where(eq(schema.environmentRunExecutions.id, command.executionId));
    await transaction
      .update(schema.environmentModelGrants)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(eq(schema.environmentModelGrants.runId, command.executionId));
    await transaction
      .update(schema.desktopEnvironmentConnections)
      .set({
        activeRuns: sql`greatest(${schema.desktopEnvironmentConnections.activeRuns} - 1, 0)`,
        updatedAt: now,
      })
      .where(eq(schema.desktopEnvironmentConnections.id, input.connectionId));
  });
}

export function describeDesktopConnection(
  connection: typeof schema.desktopEnvironmentConnections.$inferSelect,
  now = new Date(),
) {
  return {
    id: connection.id,
    environmentId: connection.environmentId,
    status: connection.status,
    connectionStatus:
      connection.status === "active" &&
      connection.lastSeenAt &&
      now.getTime() - connection.lastSeenAt.getTime() <= 90_000
        ? ("online" as const)
        : ("offline" as const),
    desktopName: connection.desktopName,
    desktopVersion: connection.desktopVersion,
    runtimeVersion: connection.runtimeVersion,
    capacity: connection.capacity,
    activeRuns: connection.activeRuns,
    models: connection.advertisedModels,
    lastSeenAt: connection.lastSeenAt?.toISOString() ?? null,
    approvedAt: connection.approvedAt?.toISOString() ?? null,
    revokedAt: connection.revokedAt?.toISOString() ?? null,
    failureCode: connection.failureCode,
    failureMessage: connection.failureMessage,
  };
}

async function requireClaimedCommand(input: {
  connection: typeof schema.desktopEnvironmentConnections.$inferSelect;
  commandId: string;
  claimToken: string;
}) {
  const command = await knowledgeDb.query.desktopEnvironmentCommands.findFirst({
    where: (table, { and, eq, inArray }) =>
      and(
        eq(table.id, input.commandId),
        eq(table.environmentId, input.connection.environmentId),
        inArray(table.status, ["claimed", "running"]),
      ),
  });
  if (
    !command?.claimTokenHash ||
    !secretMatches(input.claimToken, command.claimTokenHash)
  ) {
    throw new DesktopConnectorAuthError("DESKTOP_COMMAND_CLAIM_INVALID");
  }
  return command;
}

async function requireClaimedRuntimeRelease(input: {
  authorization: DesktopConnectorAuthorization;
  releaseId: string;
  claimToken: string;
  allowReleased?: boolean | undefined;
}) {
  const release = await knowledgeDb.query.runtimeBindingReleaseOutbox.findFirst({
    where: (table, { and, eq, inArray }) =>
      and(
        eq(table.id, input.releaseId),
        eq(table.organizationId, input.authorization.connection.organizationId),
        eq(table.environmentId, input.authorization.environment.id),
        inArray(
          table.state,
          input.allowReleased ? ["delivering", "released"] : ["delivering"],
        ),
      ),
  });
  if (
    !release?.claimTokenHash ||
    !secretMatches(input.claimToken, release.claimTokenHash) ||
    (release.state === "delivering" &&
      (!release.claimExpiresAt || release.claimExpiresAt <= new Date()))
  ) {
    throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_CLAIM_INVALID");
  }
  return release;
}

function assertRuntimeReleaseAcknowledgement(
  release: typeof schema.runtimeBindingReleaseOutbox.$inferSelect,
  event: ReturnType<typeof parseRunnerEventV2>,
): asserts event is RunnerEventEnvelope<"runtime.released"> {
  if (
    event.type !== "runtime.released" ||
    event.commandId !== release.id ||
    event.payload.runtimeId !== release.runtimeId ||
    event.payload.bindingId !== release.bindingId ||
    event.payload.participantId !== release.participantId ||
    event.payload.threadId !== release.threadId ||
    event.payload.environmentId !== release.environmentId
  ) {
    throw new DesktopConnectorAuthError("DESKTOP_RUNTIME_RELEASE_ACK_INVALID");
  }
}

function normalizeEd25519PublicKey(value: string) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not ed25519");
    }
    const pem = key.export({ type: "spki", format: "pem" }).toString();
    const der = key.export({ type: "spki", format: "der" });
    return {
      pem,
      fingerprint: createHash("sha256").update(der).digest("hex"),
    };
  } catch {
    throw new Error("Desktop enrollment public key must be Ed25519.");
  }
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DesktopConnectorAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DesktopConnectorAuthError";
  }
}
