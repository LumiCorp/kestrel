import { and, desc, eq } from "drizzle-orm";

import { logAdminEvent } from "@/lib/admin/logs";
import {
  mcpAppAccessMode,
  mcpAppCapabilityKey,
  mcpAppRuntimeName,
} from "@/lib/apps/mcp-app";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { digestCanonicalJson } from "./capability-snapshot";
import type {
  CreateMcpCredentialInput,
  CreateMcpServerInput,
  McpApprovalMode,
} from "./contracts";
import {
  decryptMcpCredential,
  encryptMcpCredential,
  type McpCredentialPayload,
} from "./credential-crypto";

export async function listEnvironmentMcpCredentials(input: {
  organizationId: string;
  environmentId: string;
}) {
  await requireEnvironment(input);
  return knowledgeDb
    .select({
      id: schema.mcpCredentials.id,
      name: schema.mcpCredentials.name,
      kind: schema.mcpCredentials.kind,
      status: schema.mcpCredentials.status,
      expiresAt: schema.mcpCredentials.expiresAt,
      lastUsedAt: schema.mcpCredentials.lastUsedAt,
      createdAt: schema.mcpCredentials.createdAt,
      updatedAt: schema.mcpCredentials.updatedAt,
    })
    .from(schema.mcpCredentials)
    .where(
      and(
        eq(schema.mcpCredentials.organizationId, input.organizationId),
        eq(schema.mcpCredentials.environmentId, input.environmentId)
      )
    )
    .orderBy(desc(schema.mcpCredentials.createdAt));
}

export async function createEnvironmentMcpCredential(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  credential: CreateMcpCredentialInput;
}) {
  await requireEnvironment(input);
  const id = crypto.randomUUID();
  const encryptedPayload = encryptMcpCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    credentialId: id,
    payload: input.credential.payload,
  });
  const [credential] = await knowledgeDb
    .insert(schema.mcpCredentials)
    .values({
      id,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      createdByUserId: input.actorUserId,
      name: input.credential.name,
      kind: input.credential.payload.kind,
      encryptedPayload,
      expiresAt:
        input.credential.payload.kind === "oauth" &&
        input.credential.payload.expiresAt
          ? new Date(input.credential.payload.expiresAt)
          : null,
    })
    .returning({
      id: schema.mcpCredentials.id,
      name: schema.mcpCredentials.name,
      kind: schema.mcpCredentials.kind,
      status: schema.mcpCredentials.status,
      expiresAt: schema.mcpCredentials.expiresAt,
      createdAt: schema.mcpCredentials.createdAt,
    });
  if (!credential) {
    throw new Error("MCP credential creation failed.");
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.credential.created",
    targetType: "mcp_credential",
    targetId: credential.id,
    message: `Created ${credential.kind} MCP credential ${credential.name}.`,
    metadata: { environmentId: input.environmentId, kind: credential.kind },
  });
  return credential;
}

export async function revokeEnvironmentMcpCredential(input: {
  organizationId: string;
  environmentId: string;
  credentialId: string;
  actorUserId: string;
}) {
  const now = new Date();
  const credential = await knowledgeDb.transaction(async (transaction) => {
    const [revoked] = await transaction
      .update(schema.mcpCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.mcpCredentials.id, input.credentialId),
          eq(schema.mcpCredentials.organizationId, input.organizationId),
          eq(schema.mcpCredentials.environmentId, input.environmentId)
        )
      )
      .returning({
        id: schema.mcpCredentials.id,
        name: schema.mcpCredentials.name,
        kind: schema.mcpCredentials.kind,
        status: schema.mcpCredentials.status,
        revokedAt: schema.mcpCredentials.revokedAt,
      });
    if (!revoked) {
      throw Object.assign(new Error("MCP credential not found."), {
        code: "MCP_CREDENTIAL_NOT_FOUND",
      });
    }
    await transaction
      .update(schema.mcpServers)
      .set({
        status: "degraded",
        failureCode: "MCP_CREDENTIAL_REVOKED",
        failureMessage: "The MCP server credential was revoked.",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.mcpServers.organizationId, input.organizationId),
          eq(schema.mcpServers.environmentId, input.environmentId),
          eq(schema.mcpServers.credentialId, input.credentialId)
        )
      );
    const affectedServers = await transaction.query.mcpServers.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.credentialId, input.credentialId)
        ),
      columns: { id: true },
    });
    for (const server of affectedServers) {
      await transaction
        .update(schema.appConnections)
        .set({
          status: "degraded",
          failureCode: "MCP_CREDENTIAL_REVOKED",
          failureMessage: "The Custom App credential was revoked.",
          updatedAt: now,
        })
        .where(eq(schema.appConnections.id, server.id));
    }
    return revoked;
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.credential.revoked",
    targetType: "mcp_credential",
    targetId: credential.id,
    message: `Revoked MCP credential ${credential.name}.`,
    metadata: { environmentId: input.environmentId, kind: credential.kind },
  });
  return credential;
}

export async function listEnvironmentMcpServers(input: {
  organizationId: string;
  environmentId: string;
}) {
  await requireEnvironment(input);
  return knowledgeDb.query.mcpServers.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId)
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

export async function getEnvironmentMcpOperationalSnapshot(input: {
  organizationId: string;
  environmentId: string;
}) {
  await requireEnvironment(input);
  const [servers, discoveryJobs, invocations, interactions] = await Promise.all(
    [
      listEnvironmentMcpServers(input),
      knowledgeDb.query.mcpDiscoveryJobs.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.environmentId, input.environmentId)
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
        limit: 20,
      }),
      knowledgeDb
        .select({
          id: schema.mcpInvocations.id,
          serverId: schema.mcpInvocations.serverId,
          capabilityId: schema.mcpInvocations.capabilityId,
          method: schema.mcpInvocations.method,
          status: schema.mcpInvocations.status,
          requestDigest: schema.mcpInvocations.requestDigest,
          responseDigest: schema.mcpInvocations.responseDigest,
          errorCode: schema.mcpInvocations.errorCode,
          createdAt: schema.mcpInvocations.createdAt,
          completedAt: schema.mcpInvocations.completedAt,
        })
        .from(schema.mcpInvocations)
        .innerJoin(
          schema.mcpRunGrants,
          eq(schema.mcpRunGrants.id, schema.mcpInvocations.grantId)
        )
        .where(
          and(
            eq(schema.mcpRunGrants.organizationId, input.organizationId),
            eq(schema.mcpRunGrants.environmentId, input.environmentId)
          )
        )
        .orderBy(desc(schema.mcpInvocations.createdAt))
        .limit(50),
      knowledgeDb
        .select({
          id: schema.mcpInteractionCheckpoints.id,
          invocationId: schema.mcpInteractionCheckpoints.invocationId,
          threadId: schema.mcpInteractionCheckpoints.threadId,
          kind: schema.mcpInteractionCheckpoints.kind,
          status: schema.mcpInteractionCheckpoints.status,
          createdAt: schema.mcpInteractionCheckpoints.createdAt,
          resolvedAt: schema.mcpInteractionCheckpoints.resolvedAt,
        })
        .from(schema.mcpInteractionCheckpoints)
        .innerJoin(
          schema.mcpInvocations,
          eq(
            schema.mcpInvocations.id,
            schema.mcpInteractionCheckpoints.invocationId
          )
        )
        .innerJoin(
          schema.mcpRunGrants,
          eq(schema.mcpRunGrants.id, schema.mcpInvocations.grantId)
        )
        .where(
          and(
            eq(schema.mcpRunGrants.organizationId, input.organizationId),
            eq(schema.mcpRunGrants.environmentId, input.environmentId)
          )
        )
        .orderBy(desc(schema.mcpInteractionCheckpoints.createdAt))
        .limit(20),
    ]
  );
  return {
    summary: {
      servers: servers.length,
      readyServers: servers.filter((server) => server.status === "ready")
        .length,
      degradedServers: servers.filter((server) => server.status === "degraded")
        .length,
      activeDiscoveryJobs: discoveryJobs.filter(
        (job) => job.status === "queued" || job.status === "running"
      ).length,
      pendingInteractions: interactions.filter(
        (interaction) => interaction.status === "requested"
      ).length,
      failedInvocations: invocations.filter(
        (invocation) => invocation.status === "failed"
      ).length,
    },
    discoveryJobs,
    invocations,
    interactions,
  };
}

export async function getEnvironmentMcpServer(input: {
  organizationId: string;
  environmentId: string;
  serverId: string;
}) {
  const server = await knowledgeDb.query.mcpServers.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.serverId),
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId)
      ),
  });
  if (!server) {
    throw Object.assign(new Error("MCP server not found."), {
      code: "MCP_SERVER_NOT_FOUND",
    });
  }
  const snapshots = await knowledgeDb.query.mcpCapabilitySnapshots.findMany({
    where: (table, { eq }) => eq(table.serverId, server.id),
    orderBy: (table, { desc }) => [desc(table.discoveredAt)],
  });
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const capabilities = snapshotIds.length
    ? await knowledgeDb.query.mcpCapabilities.findMany({
        where: (table, { inArray }) => inArray(table.snapshotId, snapshotIds),
      })
    : [];
  return {
    server,
    snapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      capabilities: capabilities.filter(
        (capability) => capability.snapshotId === snapshot.id
      ),
    })),
  };
}

export async function installEnvironmentMcpServer(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  server: CreateMcpServerInput;
}) {
  await requireEnvironment(input);
  const serverId = crypto.randomUUID();
  const providerKey = `mcp.${serverId}`;
  const credentialId =
    input.server.auth.mode === "none" ? null : input.server.auth.credentialId;
  let credentialPayload: McpCredentialPayload | undefined;
  if (credentialId) {
    const credential = await knowledgeDb.query.mcpCredentials.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, credentialId),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.status, "active")
        ),
    });
    if (!credential || credential.kind !== input.server.auth.mode) {
      throw new Error(
        "Active MCP credential does not match server authentication."
      );
    }
    credentialPayload = decryptMcpCredential({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      credentialId: credential.id,
      encrypted: credential.encryptedPayload,
    });
    if (
      credentialPayload.kind === "oauth" &&
      input.server.sourceType === "remote" &&
      credentialPayload.resource !== new URL(input.server.remoteUrl).toString()
    ) {
      throw new Error("MCP OAuth credential is bound to another resource.");
    }
  }
  const egressAllowlist = [
    ...new Set([
      ...input.server.egressAllowlist,
      ...(credentialPayload?.kind === "oauth" && credentialPayload.tokenEndpoint
        ? [new URL(credentialPayload.tokenEndpoint).origin]
        : []),
    ]),
  ];
  const now = new Date();
  const created = await knowledgeDb.transaction(async (transaction) => {
    await transaction.insert(schema.toolProviders).values({
      key: providerKey,
      displayName: input.server.name,
      description: `MCP server installed in Environment ${input.environmentId}.`,
      type: "custom_imported",
      authType:
        input.server.auth.mode === "oauth"
          ? "oauth"
          : input.server.auth.mode === "secret_headers"
            ? "api_key"
            : "none",
      metadata: {
        category: "mcp",
        sourceType: input.server.sourceType,
        environmentId: input.environmentId,
      },
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(schema.organizationToolProviders).values({
      organizationId: input.organizationId,
      providerKey,
      enabled: true,
      settings: { environmentId: input.environmentId, serverId },
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(schema.appDefinitions).values({
      key: providerKey,
      slug: `custom-${input.server.slug}-${serverId}`,
      displayName: input.server.name,
      description:
        "A custom App connected through an approved capability server.",
      category: "custom",
      kind: "custom",
      connectionModel: "environment",
      delivery: "mcp",
      installMode: "explicit",
      published: true,
      metadata: { custom: true },
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(schema.appInstallations).values({
      organizationId: input.organizationId,
      appKey: providerKey,
      status: "installed",
      installedByUserId: input.actorUserId,
      settings: {},
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const [server] = await transaction
      .insert(schema.mcpServers)
      .values({
        id: serverId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        providerKey,
        credentialId,
        createdByUserId: input.actorUserId,
        name: input.server.name,
        slug: input.server.slug,
        sourceType: input.server.sourceType,
        transport: input.server.transport,
        remoteUrl:
          input.server.sourceType === "remote" ? input.server.remoteUrl : null,
        ociImageReference:
          input.server.sourceType === "oci"
            ? input.server.imageReference
            : null,
        ociDigest:
          input.server.sourceType === "oci" ? input.server.digest : null,
        authMode: input.server.auth.mode,
        launchArguments: input.server.launchArguments,
        egressAllowlist,
        cpuMillicores: input.server.resources.cpuMillicores,
        memoryMib: input.server.resources.memoryMib,
        pidsLimit: input.server.resources.pidsLimit,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!server) {
      throw new Error("MCP server installation failed.");
    }
    await transaction.insert(schema.appConnections).values({
      id: server.id,
      organizationId: input.organizationId,
      appKey: providerKey,
      ownerType: "environment",
      environmentId: input.environmentId,
      name: input.server.name,
      status: "disconnected",
      scopes: [],
      deliveryConfig: { mcpServerId: server.id },
      createdAt: now,
      updatedAt: now,
    });
    return server;
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.server.installed",
    targetType: "mcp_server",
    targetId: created.id,
    message: `Installed MCP server ${created.name}.`,
    metadata: {
      environmentId: input.environmentId,
      sourceType: created.sourceType,
      transport: created.transport,
      imageDigest: created.ociDigest,
    },
  });
  return created;
}

export async function disableEnvironmentMcpServer(input: {
  organizationId: string;
  environmentId: string;
  serverId: string;
  actorUserId: string;
}) {
  const now = new Date();
  const server = await knowledgeDb.transaction(async (transaction) => {
    const [disabled] = await transaction
      .update(schema.mcpServers)
      .set({ status: "disabled", updatedAt: now })
      .where(
        and(
          eq(schema.mcpServers.id, input.serverId),
          eq(schema.mcpServers.organizationId, input.organizationId),
          eq(schema.mcpServers.environmentId, input.environmentId)
        )
      )
      .returning();
    if (disabled) {
      await transaction
        .update(schema.appConnections)
        .set({ status: "disconnected", disconnectedAt: now, updatedAt: now })
        .where(eq(schema.appConnections.id, disabled.id));
    }
    return disabled;
  });
  if (!server) {
    throw Object.assign(new Error("MCP server not found."), {
      code: "MCP_SERVER_NOT_FOUND",
    });
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.server.disabled",
    targetType: "mcp_server",
    targetId: server.id,
    message: `Disabled MCP server ${server.name}.`,
    metadata: { environmentId: input.environmentId },
  });
  return server;
}

export async function requestEnvironmentMcpDiscovery(input: {
  organizationId: string;
  environmentId: string;
  serverId: string;
  actorUserId: string;
}) {
  const { server, job } = await knowledgeDb.transaction(async (transaction) => {
    const server = await transaction.query.mcpServers.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.serverId),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId)
        ),
    });
    if (!server) {
      throw Object.assign(new Error("MCP server not found."), {
        code: "MCP_SERVER_NOT_FOUND",
      });
    }
    const approvedSnapshot =
      await transaction.query.mcpCapabilitySnapshots.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.serverId, server.id), eq(table.status, "approved")),
        columns: { id: true },
      });
    const now = new Date();
    const [createdJob] = await transaction
      .insert(schema.mcpDiscoveryJobs)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        serverId: server.id,
        requestedByUserId: input.actorUserId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const job =
      createdJob ??
      (await transaction.query.mcpDiscoveryJobs.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.serverId, server.id),
            inArray(table.status, ["queued", "running"])
          ),
      }));
    if (!job) {
      throw new Error("MCP discovery request could not be queued.");
    }
    if (!approvedSnapshot) {
      await transaction
        .update(schema.mcpServers)
        .set({
          status: "discovering",
          failureCode: null,
          failureMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.mcpServers.id, server.id));
    }
    return {
      server: approvedSnapshot
        ? server
        : { ...server, status: "discovering" as const },
      job,
    };
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.discovery.requested",
    targetType: "mcp_server",
    targetId: server.id,
    message: `Requested capability discovery for ${server.name}.`,
    metadata: { environmentId: input.environmentId },
  });
  return { server, discoveryJob: job };
}

export async function setEnvironmentMcpCapabilityPolicy(input: {
  organizationId: string;
  environmentId: string;
  capabilityId: string;
  actorUserId: string;
  enabled: boolean;
  approvalMode: McpApprovalMode;
}) {
  const now = new Date();
  const result = await knowledgeDb.transaction(async (transaction) => {
    const row = await transaction
      .select({
        capability: schema.mcpCapabilities,
        server: schema.mcpServers,
        snapshotStatus: schema.mcpCapabilitySnapshots.status,
      })
      .from(schema.mcpCapabilities)
      .innerJoin(
        schema.mcpCapabilitySnapshots,
        eq(schema.mcpCapabilitySnapshots.id, schema.mcpCapabilities.snapshotId)
      )
      .innerJoin(
        schema.mcpServers,
        eq(schema.mcpServers.id, schema.mcpCapabilitySnapshots.serverId)
      )
      .where(
        and(
          eq(schema.mcpCapabilities.id, input.capabilityId),
          eq(schema.mcpServers.organizationId, input.organizationId),
          eq(schema.mcpServers.environmentId, input.environmentId)
        )
      )
      .limit(1);
    const found = row[0];
    if (!found || found.snapshotStatus !== "approved") {
      throw new Error(
        "Only capabilities from an approved snapshot can be enabled."
      );
    }
    const [capability] = await transaction
      .update(schema.mcpCapabilities)
      .set({
        environmentEnabled: input.enabled,
        approvalMode: input.enabled ? input.approvalMode : "deny",
        approvedByUserId: input.actorUserId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.mcpCapabilities.id, input.capabilityId))
      .returning();
    if (!capability) {
      throw new Error("MCP capability update failed.");
    }
    if (capability.kind === "tool" && capability.toolCapabilityKey) {
      if (input.enabled) {
        const existingGrant =
          await transaction.query.environmentCapabilityGrants.findFirst({
            where: (table, { and, eq, isNull }) =>
              and(
                eq(table.environmentId, input.environmentId),
                eq(table.providerKey, capability.providerKey),
                eq(table.capabilityKey, capability.toolCapabilityKey!),
                isNull(table.resourceId)
              ),
          });
        if (existingGrant) {
          await transaction
            .update(schema.environmentCapabilityGrants)
            .set({ approvalMode: input.approvalMode, updatedAt: now })
            .where(eq(schema.environmentCapabilityGrants.id, existingGrant.id));
        } else {
          await transaction.insert(schema.environmentCapabilityGrants).values({
            id: crypto.randomUUID(),
            environmentId: input.environmentId,
            providerKey: capability.providerKey,
            capabilityKey: capability.toolCapabilityKey,
            approvalMode: input.approvalMode,
            loggingMode: "full",
            rateLimitMode: "default",
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        await transaction
          .delete(schema.environmentCapabilityGrants)
          .where(
            and(
              eq(
                schema.environmentCapabilityGrants.environmentId,
                input.environmentId
              ),
              eq(
                schema.environmentCapabilityGrants.providerKey,
                capability.providerKey
              ),
              eq(
                schema.environmentCapabilityGrants.capabilityKey,
                capability.toolCapabilityKey
              )
            )
          );
      }
    }
    const appCapabilityKey = mcpAppCapabilityKey(
      capability.kind,
      capability.capabilityKey
    );
    await transaction
      .insert(schema.environmentAppCapabilityGrants)
      .values({
        environmentId: input.environmentId,
        appKey: capability.providerKey,
        capabilityKey: appCapabilityKey,
        enabled: input.enabled,
        approvalMode: input.enabled ? input.approvalMode : "deny",
        loggingMode: "full",
        rateLimitMode: "default",
        settings: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.environmentAppCapabilityGrants.environmentId,
          schema.environmentAppCapabilityGrants.appKey,
          schema.environmentAppCapabilityGrants.capabilityKey,
        ],
        set: {
          enabled: input.enabled,
          approvalMode: input.enabled ? input.approvalMode : "deny",
          updatedAt: now,
        },
      });
    return capability;
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action: "mcp.capability.policy_updated",
    targetType: "mcp_capability",
    targetId: result.id,
    message: `Updated MCP capability ${result.capabilityKey}.`,
    metadata: {
      environmentId: input.environmentId,
      enabled: input.enabled,
      approvalMode: input.enabled ? input.approvalMode : "deny",
    },
  });
  return result;
}

export async function reviewEnvironmentMcpSnapshot(input: {
  organizationId: string;
  environmentId: string;
  serverId: string;
  snapshotId: string;
  actorUserId: string;
  decision: "approve" | "reject";
}) {
  const now = new Date();
  const snapshot = await knowledgeDb.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        snapshot: schema.mcpCapabilitySnapshots,
        providerKey: schema.mcpServers.providerKey,
      })
      .from(schema.mcpCapabilitySnapshots)
      .innerJoin(
        schema.mcpServers,
        eq(schema.mcpServers.id, schema.mcpCapabilitySnapshots.serverId)
      )
      .where(
        and(
          eq(schema.mcpCapabilitySnapshots.id, input.snapshotId),
          eq(schema.mcpServers.id, input.serverId),
          eq(schema.mcpServers.organizationId, input.organizationId),
          eq(schema.mcpServers.environmentId, input.environmentId)
        )
      )
      .limit(1);
    const currentRecord = rows[0];
    if (!currentRecord) {
      throw Object.assign(new Error("MCP capability snapshot not found."), {
        code: "MCP_SNAPSHOT_NOT_FOUND",
      });
    }
    const { providerKey, snapshot: current } = currentRecord;
    if (current.status !== "pending_review") {
      throw new Error("MCP capability snapshot has already been reviewed.");
    }
    if (input.decision === "approve") {
      const previousApproved =
        await transaction.query.mcpCapabilitySnapshots.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.serverId, input.serverId),
              eq(table.status, "approved")
            ),
        });
      const nextCapabilities = await transaction.query.mcpCapabilities.findMany(
        {
          where: (table, { eq }) => eq(table.snapshotId, input.snapshotId),
        }
      );
      const previousCapabilities = previousApproved
        ? await transaction.query.mcpCapabilities.findMany({
            where: (table, { eq }) => eq(table.snapshotId, previousApproved.id),
          })
        : [];
      const nextAppCapabilityKeys = new Set<string>();
      for (const capability of nextCapabilities) {
        const appCapabilityKey = mcpAppCapabilityKey(
          capability.kind,
          capability.capabilityKey
        );
        nextAppCapabilityKeys.add(appCapabilityKey);
        const previous = previousCapabilities.find(
          (candidate) =>
            candidate.kind === capability.kind &&
            candidate.capabilityKey === capability.capabilityKey &&
            digestCanonicalJson(candidate.definition) ===
              digestCanonicalJson(capability.definition)
        );
        if (previous) {
          const restrictions =
            await transaction.query.mcpProjectCapabilityRestrictions.findMany({
              where: (table, { eq }) => eq(table.capabilityId, previous.id),
            });
          for (const restriction of restrictions) {
            await transaction
              .insert(schema.mcpProjectCapabilityRestrictions)
              .values({
                projectId: restriction.projectId,
                capabilityId: capability.id,
                enabled: restriction.enabled,
                approvalMode: restriction.approvalMode,
                createdAt: restriction.createdAt,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  schema.mcpProjectCapabilityRestrictions.projectId,
                  schema.mcpProjectCapabilityRestrictions.capabilityId,
                ],
                set: {
                  enabled: restriction.enabled,
                  approvalMode: restriction.approvalMode,
                  updatedAt: now,
                },
              });
          }
        }
        if (
          capability.kind === "tool" &&
          capability.toolCapabilityKey &&
          !capability.environmentEnabled
        ) {
          await transaction
            .delete(schema.environmentCapabilityGrants)
            .where(
              and(
                eq(
                  schema.environmentCapabilityGrants.environmentId,
                  input.environmentId
                ),
                eq(
                  schema.environmentCapabilityGrants.providerKey,
                  capability.providerKey
                ),
                eq(
                  schema.environmentCapabilityGrants.capabilityKey,
                  capability.toolCapabilityKey
                )
              )
            );
        }
        await transaction
          .insert(schema.appCapabilities)
          .values({
            appKey: capability.providerKey,
            key: appCapabilityKey,
            runtimeName: mcpAppRuntimeName(capability.id),
            displayName: capability.displayName ?? capability.capabilityKey,
            description:
              capability.description ??
              `Capability provided by ${capability.providerKey}.`,
            groupKey: capability.kind,
            accessMode: mcpAppAccessMode(capability.kind),
            audience: "project",
            defaultEnabled: false,
            defaultApprovalMode: "deny",
            defaultRateLimitMode: "default",
            defaultLoggingMode: "full",
            defaultSettings: {},
            metadata: {
              mcpCapabilityId: capability.id,
              mcpKind: capability.kind,
              definitionDigest: digestCanonicalJson(capability.definition),
            },
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.appCapabilities.appKey, schema.appCapabilities.key],
            set: {
              runtimeName: mcpAppRuntimeName(capability.id),
              displayName: capability.displayName ?? capability.capabilityKey,
              description:
                capability.description ??
                `Capability provided by ${capability.providerKey}.`,
              groupKey: capability.kind,
              accessMode: mcpAppAccessMode(capability.kind),
              metadata: {
                mcpCapabilityId: capability.id,
                mcpKind: capability.kind,
                definitionDigest: digestCanonicalJson(capability.definition),
              },
              updatedAt: now,
            },
          });
        await transaction
          .insert(schema.environmentAppCapabilityGrants)
          .values({
            environmentId: input.environmentId,
            appKey: capability.providerKey,
            capabilityKey: appCapabilityKey,
            enabled: capability.environmentEnabled,
            approvalMode: capability.environmentEnabled
              ? capability.approvalMode
              : "deny",
            loggingMode: "full",
            rateLimitMode: "default",
            settings: {},
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.environmentAppCapabilityGrants.environmentId,
              schema.environmentAppCapabilityGrants.appKey,
              schema.environmentAppCapabilityGrants.capabilityKey,
            ],
            set: {
              enabled: capability.environmentEnabled,
              approvalMode: capability.environmentEnabled
                ? capability.approvalMode
                : "deny",
              updatedAt: now,
            },
          });
      }
      const existingAppCapabilities =
        await transaction.query.appCapabilities.findMany({
          where: (table, { eq: equals }) => equals(table.appKey, providerKey),
          columns: { key: true, appKey: true },
        });
      for (const stale of existingAppCapabilities) {
        if (!nextAppCapabilityKeys.has(stale.key)) {
          await transaction
            .delete(schema.appCapabilities)
            .where(
              and(
                eq(schema.appCapabilities.appKey, stale.appKey),
                eq(schema.appCapabilities.key, stale.key)
              )
            );
        }
      }
      await transaction
        .update(schema.mcpCapabilitySnapshots)
        .set({ status: "superseded", reviewedAt: now })
        .where(
          and(
            eq(schema.mcpCapabilitySnapshots.serverId, input.serverId),
            eq(schema.mcpCapabilitySnapshots.status, "approved")
          )
        );
    }
    const [reviewed] = await transaction
      .update(schema.mcpCapabilitySnapshots)
      .set({
        status: input.decision === "approve" ? "approved" : "rejected",
        reviewedByUserId: input.actorUserId,
        reviewedAt: now,
      })
      .where(eq(schema.mcpCapabilitySnapshots.id, input.snapshotId))
      .returning();
    if (!reviewed) {
      throw new Error("MCP capability snapshot review failed.");
    }
    const approved =
      input.decision === "approve"
        ? true
        : Boolean(
            await transaction.query.mcpCapabilitySnapshots.findFirst({
              where: (table, { and, eq }) =>
                and(
                  eq(table.serverId, input.serverId),
                  eq(table.status, "approved")
                ),
              columns: { id: true },
            })
          );
    await transaction
      .update(schema.mcpServers)
      .set({
        status: approved ? "ready" : "degraded",
        failureCode: approved ? null : "MCP_CAPABILITIES_REJECTED",
        failureMessage: approved
          ? null
          : "The discovered MCP capabilities were rejected.",
        updatedAt: now,
      })
      .where(eq(schema.mcpServers.id, input.serverId));
    await transaction
      .update(schema.appConnections)
      .set({
        status: approved ? "connected" : "degraded",
        failureCode: approved ? null : "MCP_CAPABILITIES_REJECTED",
        failureMessage: approved
          ? null
          : "The discovered App capabilities were rejected.",
        lastHealthAt: now,
        disconnectedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.appConnections.id, input.serverId));
    return reviewed;
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "mcp",
    action:
      input.decision === "approve"
        ? "mcp.snapshot.approved"
        : "mcp.snapshot.rejected",
    targetType: "mcp_capability_snapshot",
    targetId: snapshot.id,
    message: `${input.decision === "approve" ? "Approved" : "Rejected"} MCP capability snapshot.`,
    metadata: {
      environmentId: input.environmentId,
      serverId: input.serverId,
      capabilityDigest: snapshot.capabilityDigest,
    },
  });
  return snapshot;
}

async function requireEnvironment(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await getOrganizationEnvironment(input);
  if (!environment) {
    throw Object.assign(new Error("Environment not found."), {
      code: "ENVIRONMENT_NOT_FOUND",
    });
  }
  return environment;
}
