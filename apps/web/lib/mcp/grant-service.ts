import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { digestCanonicalJson } from "./capability-snapshot";
import {
  buildMcpRunGrant,
  MCP_PROTOCOL_VERSION,
  resolveEffectiveMcpCapabilities,
} from "./contracts";

export async function issueHostedMcpRunContext(input: {
  runExecutionId: string;
  organizationId: string;
  environmentId: string;
  projectId: string | null;
  threadId: string;
  gatewayUrl?: string | undefined;
}) {
  const gatewayUrl = input.gatewayUrl ?? process.env.KESTREL_MCP_GATEWAY_URL;
  if (!gatewayUrl?.trim()) {
    return;
  }
  const normalizedGatewayUrl = assertMcpGatewayUrl(gatewayUrl);
  const rows = await knowledgeDb
    .select({
      id: schema.mcpCapabilities.id,
      kind: schema.mcpCapabilities.kind,
      environmentEnabled: schema.mcpCapabilities.environmentEnabled,
      approvalMode: schema.mcpCapabilities.approvalMode,
      serverId: schema.mcpServers.id,
      snapshotId: schema.mcpCapabilitySnapshots.id,
      snapshotDigest: schema.mcpCapabilitySnapshots.capabilityDigest,
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
        eq(schema.mcpServers.organizationId, input.organizationId),
        eq(schema.mcpServers.environmentId, input.environmentId),
        eq(schema.mcpServers.status, "ready"),
        eq(schema.mcpCapabilitySnapshots.status, "approved")
      )
    );
  const projectRestrictions = input.projectId
    ? await knowledgeDb.query.mcpProjectCapabilityRestrictions.findMany({
        where: (table, { eq }) => eq(table.projectId, input.projectId!),
      })
    : undefined;
  const effectiveCapabilities = resolveEffectiveMcpCapabilities({
    environmentCapabilities: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      environmentEnabled: row.environmentEnabled,
      approvalMode: row.approvalMode,
    })),
    projectRestrictions,
  });
  if (effectiveCapabilities.length === 0) {
    return;
  }
  const policyEvidence = {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    threadId: input.threadId,
    capabilities: effectiveCapabilities
      .map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        approvalMode: capability.approvalMode,
        serverId: rows.find((row) => row.id === capability.id)?.serverId,
        snapshotId: rows.find((row) => row.id === capability.id)?.snapshotId,
        snapshotDigest: rows.find((row) => row.id === capability.id)
          ?.snapshotDigest,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const grant = buildMcpRunGrant({
    id: crypto.randomUUID(),
    runExecutionId: input.runExecutionId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    threadId: input.threadId,
    policyDigest: digestCanonicalJson(policyEvidence),
    effectiveCapabilities,
  });
  await knowledgeDb.insert(schema.mcpRunGrants).values({
    id: grant.id,
    runExecutionId: grant.runExecutionId,
    organizationId: grant.organizationId,
    environmentId: grant.environmentId,
    projectId: grant.projectId ?? null,
    threadId: grant.threadId,
    policyDigest: grant.policyDigest,
    effectiveCapabilities: grant.effectiveCapabilities,
    effectivePolicy: grant.effectivePolicy,
    status: grant.status,
    expiresAt: grant.expiresAt,
    createdAt: grant.createdAt,
  });
  return {
    gatewayUrl: normalizedGatewayUrl,
    grantId: grant.id,
    protocolVersion: MCP_PROTOCOL_VERSION,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    threadId: input.threadId,
  };
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
