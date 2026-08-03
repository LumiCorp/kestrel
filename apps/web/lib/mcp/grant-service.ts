import { and, eq } from "drizzle-orm";
import {
  parseResolvedOciMcpEgressBinding,
  type ResolvedOciMcpEgressBindingV1,
} from "@kestrel/mcp-security";
import { mcpAppCapabilityKey } from "@/lib/apps/mcp-app";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { digestCanonicalJson } from "./capability-snapshot";
import { buildMcpRunGrant, MCP_PROTOCOL_VERSION } from "./contracts";

type ResolvedCapability = {
  id: string;
  kind: Parameters<
    typeof buildMcpRunGrant
  >[0]["effectiveCapabilities"][number]["kind"];
  approvalMode: "auto" | "ask";
  serverId: string;
  snapshotId: string;
  snapshotDigest: string;
};

export type ResolvedHostedMcpRunPolicy = {
  gatewayUrl: string;
  organizationId: string;
  environmentId: string;
  projectId: string;
  effectiveCapabilities: ResolvedCapability[];
  ociEgressBindings: ResolvedOciMcpEgressBindingV1[];
};

export async function resolveHostedMcpRunPolicy(input: {
  organizationId: string;
  environmentId: string;
  projectId: string | null;
  gatewayUrl?: string | undefined;
}): Promise<ResolvedHostedMcpRunPolicy | undefined> {
  const gatewayUrl = input.gatewayUrl ?? process.env.KESTREL_MCP_GATEWAY_URL;
  if (!(gatewayUrl?.trim() && input.projectId)) return;
  const normalizedGatewayUrl = assertMcpGatewayUrl(gatewayUrl);
  const rows = await knowledgeDb
    .select({
      id: schema.mcpCapabilities.id,
      kind: schema.mcpCapabilities.kind,
      appKey: schema.appConnections.appKey,
      serverId: schema.mcpServers.id,
      sourceType: schema.mcpServers.sourceType,
      organizationId: schema.mcpServers.organizationId,
      environmentId: schema.mcpServers.environmentId,
      imageDigest: schema.mcpServers.ociDigest,
      policy: schema.mcpServers.ociEgressPolicy,
      policyDigest: schema.mcpServers.ociEgressPolicyDigest,
      policyRevision: schema.mcpServers.ociEgressPolicyRevision,
      policySource: schema.mcpServers.ociEgressPolicySource,
      snapshotId: schema.mcpCapabilitySnapshots.id,
      snapshotDigest: schema.mcpCapabilitySnapshots.capabilityDigest,
    })
    .from(schema.mcpCapabilities)
    .innerJoin(
      schema.mcpCapabilitySnapshots,
      eq(schema.mcpCapabilitySnapshots.id, schema.mcpCapabilities.snapshotId),
    )
    .innerJoin(
      schema.mcpServers,
      eq(schema.mcpServers.id, schema.mcpCapabilitySnapshots.serverId),
    )
    .innerJoin(
      schema.appConnections,
      eq(schema.appConnections.id, schema.mcpServers.id),
    )
    .where(
      and(
        eq(schema.mcpServers.organizationId, input.organizationId),
        eq(schema.mcpServers.environmentId, input.environmentId),
        eq(schema.mcpServers.status, "ready"),
        eq(schema.mcpCapabilitySnapshots.status, "approved"),
      ),
    );
  const accessByApp = new Map<
    string,
    Awaited<ReturnType<typeof resolveEffectiveProjectAppAccess>>
  >();
  for (const row of rows) {
    if (accessByApp.has(row.appKey)) continue;
    accessByApp.set(
      row.appKey,
      await resolveEffectiveProjectAppAccess({
        organizationId: input.organizationId,
        projectId: input.projectId,
        appKey: row.appKey,
        userId: "runtime-shared-app",
      }),
    );
  }
  const effectiveCapabilities = rows.flatMap((row): ResolvedCapability[] => {
    const access = accessByApp.get(row.appKey);
    if (!access || access.connectionId !== row.serverId) return [];
    const capability = access.capabilities.find(
      (candidate) => candidate.key === mcpAppCapabilityKey(row.id),
    );
    return capability && capability.approvalMode !== "deny"
      ? [
          {
            id: row.id,
            kind: row.kind,
            approvalMode: capability.approvalMode,
            serverId: row.serverId,
            snapshotId: row.snapshotId,
            snapshotDigest: row.snapshotDigest,
          },
        ]
      : [];
  });
  if (effectiveCapabilities.length === 0) return;

  const effectiveServerIds = new Set(
    effectiveCapabilities.map((capability) => capability.serverId),
  );
  const bindingsByServer = new Map<string, ResolvedOciMcpEgressBindingV1>();
  for (const row of rows) {
    if (row.sourceType !== "oci" || !effectiveServerIds.has(row.serverId)) {
      continue;
    }
    if (
      !(
        row.imageDigest &&
        row.policyDigest &&
        row.policyRevision &&
        row.policySource
      )
    ) {
      throw new Error("OCI MCP egress policy binding is incomplete.");
    }
    bindingsByServer.set(
      row.serverId,
      parseResolvedOciMcpEgressBinding({
        version: 1,
        source: row.policySource,
        organizationId: row.organizationId,
        environmentId: row.environmentId,
        serverId: row.serverId,
        imageDigest: row.imageDigest,
        policyRevision: row.policyRevision,
        policyDigest: row.policyDigest,
        policy: row.policy,
      }),
    );
  }
  return {
    gatewayUrl: normalizedGatewayUrl,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    effectiveCapabilities: effectiveCapabilities.sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    ociEgressBindings: [...bindingsByServer.values()].sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    ),
  };
}

export async function issueHostedMcpRunContext(input: {
  runExecutionId: string;
  threadId: string;
  executionProfileId: string;
  executionProfileFingerprint: string;
  resolvedPolicy: ResolvedHostedMcpRunPolicy;
}) {
  const policyDigest = digestHostedMcpRunPolicyEvidence({
    threadId: input.threadId,
    executionProfileId: input.executionProfileId,
    executionProfileFingerprint: input.executionProfileFingerprint,
    resolvedPolicy: input.resolvedPolicy,
  });
  const grant = buildMcpRunGrant({
    id: crypto.randomUUID(),
    runExecutionId: input.runExecutionId,
    organizationId: input.resolvedPolicy.organizationId,
    environmentId: input.resolvedPolicy.environmentId,
    projectId: input.resolvedPolicy.projectId,
    threadId: input.threadId,
    policyDigest,
    effectiveCapabilities: input.resolvedPolicy.effectiveCapabilities,
  });
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.insert(schema.mcpRunGrants).values({
      id: grant.id,
      runExecutionId: grant.runExecutionId,
      organizationId: grant.organizationId,
      environmentId: grant.environmentId,
      projectId: grant.projectId ?? null,
      threadId: grant.threadId,
      policyDigest: grant.policyDigest,
      executionProfileId: input.executionProfileId,
      executionProfileFingerprint: input.executionProfileFingerprint,
      ociEgressBindings: input.resolvedPolicy.ociEgressBindings,
      effectiveCapabilities: grant.effectiveCapabilities,
      effectivePolicy: grant.effectivePolicy,
      status: grant.status,
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt,
    });
    if (input.resolvedPolicy.ociEgressBindings.length > 0) {
      await transaction.insert(schema.mcpEgressEvents).values(
        input.resolvedPolicy.ociEgressBindings.map((binding) => ({
          organizationId: binding.organizationId,
          environmentId: binding.environmentId,
          serverId: binding.serverId,
          grantId: grant.id,
          executionProfileFingerprint: input.executionProfileFingerprint,
          policyRevision: binding.policyRevision,
          policyDigest: binding.policyDigest,
          imageDigest: binding.imageDigest,
          eventKind: "policy.resolved" as const,
          networkMode: binding.policy.mode,
        })),
      );
    }
  });
  return {
    gatewayUrl: input.resolvedPolicy.gatewayUrl,
    grantId: grant.id,
    protocolVersion: MCP_PROTOCOL_VERSION,
    organizationId: grant.organizationId,
    environmentId: grant.environmentId,
    projectId: input.resolvedPolicy.projectId,
    threadId: input.threadId,
  };
}

export function digestHostedMcpRunPolicyEvidence(input: {
  threadId: string;
  executionProfileId: string;
  executionProfileFingerprint: string;
  resolvedPolicy: ResolvedHostedMcpRunPolicy;
}): string {
  const policyEvidence = {
    organizationId: input.resolvedPolicy.organizationId,
    environmentId: input.resolvedPolicy.environmentId,
    projectId: input.resolvedPolicy.projectId,
    threadId: input.threadId,
    executionProfileId: input.executionProfileId,
    executionProfileFingerprint: input.executionProfileFingerprint,
    ociEgressBindings: input.resolvedPolicy.ociEgressBindings,
    capabilities: input.resolvedPolicy.effectiveCapabilities.map(
      ({ id, kind, approvalMode, serverId, snapshotId, snapshotDigest }) => ({
        id,
        kind,
        approvalMode,
        serverId,
        snapshotId,
        snapshotDigest,
      }),
    ),
  };
  return digestCanonicalJson(policyEvidence);
}

function assertMcpGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Kestrel MCP gateway URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Kestrel MCP gateway URL must not contain credentials.");
  }
  return url.toString();
}
