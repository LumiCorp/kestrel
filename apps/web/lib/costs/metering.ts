import "server-only";

import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createFlyProviderClient } from "@/lib/environments/fly-connection";
import type { EnvironmentProviderMachine } from "@/lib/environments/providers/contracts";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { flyPublicEgressService, queryFlyPublicEgressHour } from "./fly-metrics";
import { describeFlyMachineUsage } from "./fly-usage";
import { parseModelCostIdentity } from "./pricing";
import { recordUsageEvent } from "./store";

export async function meterPersistedModelMessages(messageIds: string[]) {
  if (messageIds.length === 0) return 0;
  const rows = await knowledgeDb
    .select({
      message: schema.threadMessages,
      organizationId: schema.threads.organizationId,
      projectId: schema.threads.projectId,
      threadOwnerId: schema.threads.createdByUserId,
      turnAuthorId: schema.threadTurns.authorUserId,
    })
    .from(schema.threadMessages)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadMessages.threadId))
    .leftJoin(schema.threadTurns, eq(schema.threadTurns.id, schema.threadMessages.turnId))
    .where(inArray(schema.threadMessages.id, messageIds));
  let stored = 0;
  for (const row of rows) {
    const message = row.message;
    if (message.role !== "assistant" || !message.model) continue;
    const identity = await resolveModelIdentity(row.organizationId, message.model);
    if (identity.provider === "runpod") continue;
    const cachedInputTokens = Math.min(
      message.inputTokens ?? 0,
      message.cachedInputTokens ?? 0
    );
    const tokenMeters = [
      ["input_tokens", Math.max(0, (message.inputTokens ?? 0) - cachedInputTokens)],
      ["cached_input_tokens", cachedInputTokens],
      ["output_tokens", message.outputTokens ?? 0],
    ] as const;
    for (const [meter, quantity] of tokenMeters) {
      if (quantity <= 0) continue;
      await recordUsageEvent({
        organizationId: row.organizationId,
        actorUserId: row.turnAuthorId ?? row.threadOwnerId,
        projectId: row.projectId,
        threadId: message.threadId,
        runId: message.turnId,
        category: "models",
        provider: identity.provider,
        service: identity.service,
        meter,
        quantity,
        unit: "token",
        sourceKind: "model_message",
        sourceId: message.id,
        occurredAt: message.createdAt,
        metadata: {
          source: message.source,
          ...(meter === "output_tokens" && message.reasoningTokens != null
            ? { reasoningTokens: message.reasoningTokens }
            : {}),
        },
      });
      stored += 1;
    }
  }
  return stored;
}

export async function backfillAuthoritativeUsage(input?: { since?: Date }) {
  const since = input?.since;
  const messageRows = await knowledgeDb
    .select({ id: schema.threadMessages.id })
    .from(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.role, "assistant"),
        isNotNull(schema.threadMessages.model),
        since ? gte(schema.threadMessages.createdAt, since) : undefined
      )
    );
  const modelEvents = await meterPersistedModelMessages(
    messageRows.map((row) => row.id)
  );

  const runPodRows = await knowledgeDb
    .select({
      usage: schema.aiDeploymentUsage,
      deployment: schema.aiDeployments,
    })
    .from(schema.aiDeploymentUsage)
    .innerJoin(
      schema.aiDeployments,
      eq(schema.aiDeployments.id, schema.aiDeploymentUsage.deploymentId)
    )
    .where(since ? gte(schema.aiDeploymentUsage.bucketStartedAt, since) : undefined);
  for (const { usage, deployment } of runPodRows) {
    await meterRunPodUsage({ usage, deployment });
  }

  const mcpRows = await knowledgeDb
    .select({
      invocation: schema.mcpInvocations,
      grant: schema.mcpRunGrants,
      server: schema.mcpServers,
      actorId: schema.environmentRunExecutions.actorId,
    })
    .from(schema.mcpInvocations)
    .innerJoin(schema.mcpRunGrants, eq(schema.mcpRunGrants.id, schema.mcpInvocations.grantId))
    .innerJoin(schema.mcpServers, eq(schema.mcpServers.id, schema.mcpInvocations.serverId))
    .innerJoin(
      schema.environmentRunExecutions,
      eq(schema.environmentRunExecutions.id, schema.mcpRunGrants.runExecutionId)
    )
    .where(since ? gte(schema.mcpInvocations.createdAt, since) : undefined);
  for (const row of mcpRows) {
    await recordUsageEvent({
      organizationId: row.grant.organizationId,
      actorUserId: row.actorId,
      projectId: row.grant.projectId,
      threadId: row.grant.threadId,
      runId: row.grant.runExecutionId,
      category: "services",
      provider: row.server.providerKey,
      service: row.server.slug,
      meter: row.invocation.method,
      quantity: 1,
      unit: "invocation",
      sourceKind: "mcp_invocation",
      sourceId: row.invocation.id,
      occurredAt: row.invocation.createdAt,
      metadata: {
        sourceType: row.server.sourceType,
        status: row.invocation.status,
      },
    });
  }

  const leaseRows = await knowledgeDb.query.workspacePreviewLeases.findMany({
    where: since
      ? gte(schema.workspacePreviewLeases.createdAt, since)
      : undefined,
  });
  for (const lease of leaseRows) {
    const endedAt = lease.closedAt ?? lease.expiresAt;
    const hours = Math.max(0, endedAt.getTime() - lease.createdAt.getTime()) / 3_600_000;
    await recordUsageEvent({
      organizationId: lease.organizationId,
      actorUserId: lease.actorId,
      projectId: lease.projectId,
      threadId: lease.threadId,
      runId: lease.runId,
      category: "services",
      provider: "ngrok",
      service: "preview_lease",
      meter: "lease_hours",
      quantity: hours,
      unit: "hour",
      sourceKind: "ngrok_preview_lease",
      sourceId: lease.id,
      occurredAt: lease.createdAt,
      intervalStartedAt: lease.createdAt,
      intervalEndedAt: endedAt,
      metadata: { status: lease.status },
    });
  }

  const emailRows = await knowledgeDb.query.organizationEmailDeliveries.findMany({
    where: and(
      isNotNull(schema.organizationEmailDeliveries.approvalId),
      since ? gte(schema.organizationEmailDeliveries.createdAt, since) : undefined
    ),
  });
  for (const delivery of emailRows) {
    await meterEmailDelivery(delivery);
  }

  return {
    modelEvents,
    runPodEvents: runPodRows.length,
    mcpEvents: mcpRows.length,
    ngrokEvents: leaseRows.length,
    emailEvents: emailRows.length,
  };
}

export async function meterRunPodUsage(input: {
  usage: typeof schema.aiDeploymentUsage.$inferSelect;
  deployment: typeof schema.aiDeployments.$inferSelect;
}) {
  return recordUsageEvent({
    organizationId: input.deployment.organizationId,
    actorUserId: input.deployment.createdByUserId,
    category: "managed_compute",
    provider: "runpod",
    service: input.usage.providerEndpointId,
    meter: "billing_bucket",
    quantity: Math.max(0, input.usage.timeBilledMs),
    unit: "millisecond",
    reportedAmountUsd: input.usage.amountUsd,
    sourceKind: "runpod_billing_bucket",
    sourceId: input.usage.id,
    occurredAt: input.usage.bucketStartedAt,
    intervalStartedAt: input.usage.bucketStartedAt,
    metadata: {
      deploymentId: input.deployment.id,
      diskSpaceBilledGb: input.usage.diskSpaceBilledGb,
      gpuTypeId: input.usage.gpuTypeId,
    },
  });
}

export async function meterEmailDelivery(
  delivery: typeof schema.organizationEmailDeliveries.$inferSelect
) {
  return recordUsageEvent({
    organizationId: delivery.organizationId,
    actorUserId: delivery.actorUserId,
    projectId: delivery.projectId,
    threadId: delivery.threadId,
    category: "services",
    provider: "resend",
    service: "organization_email",
    meter: "recipients",
    quantity: delivery.recipientCount,
    unit: "recipient",
    sourceKind: "email_delivery",
    sourceId: delivery.approvalId ?? delivery.id,
    occurredAt: delivery.createdAt,
    metadata: { status: delivery.status },
  });
}

export async function meterFlyReconciledHour(now = new Date()) {
  const endedAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours()
    )
  );
  const startedAt = new Date(endedAt.getTime() - 3_600_000);
  const [environments, workspaceRows, snapshotRows] = await Promise.all([
    knowledgeDb.query.environments.findMany({
      where: and(
        isNull(schema.environments.archivedAt),
        isNotNull(schema.environments.flyAppName),
        isNotNull(schema.environments.flyGatewayMachineId)
      ),
    }),
    knowledgeDb
      .select({
        workspace: schema.environmentWorkspaces,
        environment: schema.environments,
      })
      .from(schema.environmentWorkspaces)
      .innerJoin(
        schema.environments,
        eq(schema.environments.id, schema.environmentWorkspaces.environmentId)
      )
      .where(
        and(
          isNull(schema.environmentWorkspaces.deletedAt),
          isNull(schema.environments.archivedAt),
          isNotNull(schema.environments.flyAppName),
          or(
            isNotNull(schema.environmentWorkspaces.flyMachineId),
            isNotNull(schema.environmentWorkspaces.flyVolumeId)
          )
        )
      ),
    knowledgeDb.query.workspaceBackups.findMany({
      where: and(
        eq(schema.workspaceBackups.status, "available"),
        isNotNull(schema.workspaceBackups.sizeBytes),
        gt(schema.workspaceBackups.expiresAt, startedAt)
      ),
    }),
  ]);
  if (
    environments.length === 0 &&
    workspaceRows.length === 0 &&
    snapshotRows.length === 0
  ) {
    return { gateways: 0, workspaces: 0, volumes: 0, snapshots: 0, networkSeries: 0 };
  }
  const provider = await createFlyProviderClient();
  const inventoryByApp = new Map<
    string,
    Awaited<ReturnType<typeof provider.listEnvironmentResources>>
  >();
  const inventoryFor = async (appName: string) => {
    const cached = inventoryByApp.get(appName);
    if (cached) return cached;
    const inventory = await provider.listEnvironmentResources({ appName });
    inventoryByApp.set(appName, inventory);
    return inventory;
  };
  let gatewayCount = 0;
  let workspaceCount = 0;
  let volumeCount = 0;
  for (const environment of environments) {
    if (!(environment.flyAppName && environment.flyGatewayMachineId)) continue;
    const machine = await provider.getMachine({
      appName: environment.flyAppName,
      machineId: environment.flyGatewayMachineId,
    });
    if (!machine) continue;
    await meterFlyMachine({
      organizationId: environment.organizationId,
      actorUserId: environment.createdByUserId,
      sourceId: `gateway:${environment.id}`,
      machine,
      startedAt,
      endedAt,
    });
    gatewayCount += 1;
  }
  for (const { workspace, environment } of workspaceRows) {
    if (!environment.flyAppName) continue;
    if (workspace.flyMachineId) {
      const machine = await provider.getMachine({
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
      });
      if (machine) {
        await meterFlyMachine({
          organizationId: workspace.organizationId,
          actorUserId: workspace.createdByUserId,
          projectId: workspace.projectId,
          threadId: workspace.standaloneThreadId,
          sourceId: `workspace:${workspace.id}`,
          machine,
          startedAt,
          endedAt,
        });
        workspaceCount += 1;
      }
    }
    if (workspace.flyVolumeId) {
      const inventory = await inventoryFor(environment.flyAppName);
      const volume = inventory.volumes.find(
        (candidate) => candidate.id === workspace.flyVolumeId
      );
      if (!volume?.sizeGb) continue;
      await recordUsageEvent({
        organizationId: workspace.organizationId,
        actorUserId: workspace.createdByUserId,
        projectId: workspace.projectId,
        threadId: workspace.standaloneThreadId,
        category: "environments",
        provider: "fly",
        service: "volume",
        meter: "provisioned_gb_hours",
        quantity: volume.sizeGb,
        unit: "gb_hour",
        sourceKind: "fly_reconciled_resource",
        sourceId: `volume:${workspace.flyVolumeId}`,
        occurredAt: startedAt,
        intervalStartedAt: startedAt,
        intervalEndedAt: endedAt,
        metadata: {
          region: volume.region ?? environment.region,
          source: "machines_api",
        },
      });
      volumeCount += 1;
    }
  }
  for (const backup of snapshotRows) {
    if (!backup.sizeBytes) continue;
    await recordUsageEvent({
      organizationId: backup.organizationId,
      category: "environments",
      provider: "fly",
      service: "volume_snapshot",
      meter: "stored_gb_hours",
      quantity: backup.sizeBytes / 1_000_000_000,
      unit: "gb_hour",
      sourceKind: "fly_reconciled_resource",
      sourceId: `snapshot:${backup.id}`,
      occurredAt: startedAt,
      intervalStartedAt: startedAt,
      intervalEndedAt: endedAt,
      metadata: { source: "backup_artifact_size_assumption" },
    });
  }
  const environmentByApp = new Map(
    [...environments, ...workspaceRows.map((row) => row.environment)].flatMap(
      (environment) =>
        environment.flyAppName
          ? [[environment.flyAppName, environment] as const]
          : []
    )
  );
  const networkRows = await queryFlyPublicEgressHour({ endedAt });
  for (const row of networkRows) {
    const environment = environmentByApp.get(row.appName);
    if (!environment || row.bytes <= 0) continue;
    await recordUsageEvent({
      organizationId: environment.organizationId,
      actorUserId: environment.createdByUserId,
      category: "environments",
      provider: "fly",
      service: flyPublicEgressService(row.region),
      meter: "outbound_gb",
      quantity: row.bytes / 1_000_000_000,
      unit: "gb",
      sourceKind: "fly_metrics",
      sourceId: `network:${row.appName}:${row.region ?? "unknown"}`,
      occurredAt: startedAt,
      intervalStartedAt: startedAt,
      intervalEndedAt: endedAt,
      metadata: { region: row.region, source: "prometheus" },
    });
  }
  return {
    gateways: gatewayCount,
    workspaces: workspaceCount,
    volumes: volumeCount,
    snapshots: snapshotRows.length,
    networkSeries: networkRows.length,
  };
}

export async function accrueOrganizationFixedRates(now = new Date()) {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const cards = await knowledgeDb.query.costRateCards.findMany({
    where: and(
      isNotNull(schema.costRateCards.organizationId),
      eq(schema.costRateCards.enabled, true),
      ne(schema.costRateCards.rateKind, "unit"),
      lte(schema.costRateCards.effectiveFrom, day),
      or(
        isNull(schema.costRateCards.effectiveTo),
        gt(schema.costRateCards.effectiveTo, day)
      )
    ),
  });
  for (const card of cards) {
    if (!card.organizationId) continue;
    await recordUsageEvent({
      organizationId: card.organizationId,
      category: card.category,
      provider: card.provider,
      service: card.service,
      meter: card.meter,
      quantity: 1,
      unit: card.unit,
      sourceKind: "fixed_rate_accrual",
      sourceId: card.id,
      occurredAt: day,
      intervalStartedAt: day,
      intervalEndedAt: new Date(day.getTime() + 86_400_000),
      metadata: { rateKind: card.rateKind },
    });
  }
  return cards.length;
}

async function meterFlyMachine(input: {
  organizationId: string;
  actorUserId: string | null;
  projectId?: string | null;
  threadId?: string | null;
  sourceId: string;
  machine: EnvironmentProviderMachine;
  startedAt: Date;
  endedAt: Date;
}) {
  const usage = describeFlyMachineUsage(
    input.machine,
    input.endedAt.getTime() - input.startedAt.getTime()
  );
  await recordUsageEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    threadId: input.threadId,
    category: "environments",
    provider: "fly",
    service: usage.service,
    meter: usage.meter,
    quantity: usage.quantity,
    unit: usage.unit,
    sourceKind: "fly_reconciled_resource",
    sourceId: input.sourceId,
    occurredAt: input.startedAt,
    intervalStartedAt: input.startedAt,
    intervalEndedAt: input.endedAt,
    metadata: {
      region: input.machine.region,
      state: input.machine.state,
      cpuKind: input.machine.cpuKind,
      cpus: input.machine.cpus,
      memoryMb: input.machine.memoryMb,
      source: "machines_api",
      ...(usage.pricingGap ? { pricingGap: usage.pricingGap } : {}),
    },
  });
}

async function resolveModelIdentity(organizationId: string, model: string) {
  const [match] = await knowledgeDb
    .select({
      provider: schema.aiGateways.provider,
      rawModelId: schema.aiGatewayModels.rawModelId,
    })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId)
    )
    .where(
      and(
        or(
          eq(schema.aiGatewayModels.organizationId, organizationId),
          isNull(schema.aiGatewayModels.organizationId)
        ),
        or(
          eq(schema.aiGatewayModels.rawModelId, model),
          eq(schema.aiGatewayModels.alias, model)
        )
      )
    )
    .orderBy(
      desc(
        sql`case when ${schema.aiGatewayModels.organizationId} is null then 0 else 1 end`
      )
    )
    .limit(1);
  const fallback = parseModelCostIdentity(model);
  return {
    provider: match?.provider ?? fallback.provider,
    service: match?.rawModelId ?? fallback.service,
  };
}
