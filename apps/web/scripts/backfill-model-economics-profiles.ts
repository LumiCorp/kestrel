import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "../lib/knowledge/db";
import { planGatewayModelEconomicsProfileBackfill } from "../lib/ai/model-economics-profile-backfill";
import { saveGatewayModel } from "../lib/ai/gateways";

function parseArguments(argv: string[]) {
  const organizationFlag = argv.indexOf("--organization-id");
  const organizationId =
    organizationFlag >= 0 ? argv[organizationFlag + 1]?.trim() : undefined;
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (dryRun === apply) {
    throw new Error("Choose exactly one of --dry-run or --apply.");
  }
  return { organizationId: organizationId || undefined, apply };
}

async function main() {
  const { organizationId, apply } = parseArguments(process.argv.slice(2));
  const rows = await knowledgeDb
    .select({
      id: schema.aiGatewayModels.id,
      organizationId: schema.aiGatewayModels.organizationId,
      gatewayId: schema.aiGatewayModels.gatewayId,
      rawModelId: schema.aiGatewayModels.rawModelId,
      modality: schema.aiGatewayModels.modality,
      approved: schema.aiGatewayModels.approved,
      metadata: schema.aiGatewayModels.metadata,
      updatedAt: schema.aiGatewayModels.updatedAt,
      gatewayProvider: schema.aiGateways.provider,
      gatewayBaseUrl: schema.aiGateways.baseUrl,
      credentialRevision: schema.aiGateways.credentialRevision,
      alias: schema.aiGatewayModels.alias,
      description: schema.aiGatewayModels.description,
      isDefault: schema.aiGatewayModels.isDefault,
    })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId),
    )
    .where(
      and(
        eq(schema.aiGatewayModels.approved, true),
        eq(schema.aiGatewayModels.modality, "language"),
        inArray(schema.aiGateways.provider, [
          "anthropic",
          "lumi",
          "ollama",
          "openai",
          "openrouter",
          "runpod",
        ]),
        ...(organizationId
          ? [eq(schema.aiGatewayModels.organizationId, organizationId)]
          : []),
      ),
    );
  const plan = planGatewayModelEconomicsProfileBackfill(rows);
  let applied = 0;
  const resolvedOpenRouterIds = new Set<string>();

  if (apply) {
    for (const skipped of plan.skipped.filter(
      (item) => item.reason === "openrouter_resolution_required",
    )) {
      const row = rows.find((candidate) => candidate.id === skipped.id);
      if (!row || !row.organizationId) continue;
      try {
        await saveGatewayModel({
          organizationId: row.organizationId,
          id: row.id,
          gatewayId: row.gatewayId,
          rawModelId: row.rawModelId,
          alias: row.alias,
          modality: "language",
          approved: true,
          isDefault: row.isDefault,
          description: row.description,
          metadata: row.metadata as Record<string, unknown> | null,
          resolveOpenRouterModel: true,
        });
        resolvedOpenRouterIds.add(row.id);
        applied += 1;
      } catch (error) {
        console.warn(
          JSON.stringify({
            id: row.id,
            code: "OPENROUTER_RESOLUTION_FAILED",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
  }

  if (apply && (plan.updates.length > 0 || plan.skipped.length > 0)) {
    await knowledgeDb.transaction(async (transaction) => {
      for (const update of plan.updates) {
        const source = rows.find((row) => row.id === update.id);
        if (!source) continue;
        const [currentGateway] = await transaction
          .select({ credentialRevision: schema.aiGateways.credentialRevision })
          .from(schema.aiGateways)
          .where(eq(schema.aiGateways.id, source.gatewayId))
          .limit(1);
        if (
          source.credentialRevision !== undefined &&
          currentGateway?.credentialRevision !== source.credentialRevision
        ) {
          continue;
        }
        const updated = await transaction
          .update(schema.aiGatewayModels)
          .set({ metadata: update.metadata, updatedAt: new Date() })
          .where(
            and(
              eq(schema.aiGatewayModels.id, update.id),
              eq(schema.aiGatewayModels.approved, true),
              eq(schema.aiGatewayModels.modality, "language"),
              ...(update.expectedUpdatedAt
                ? [eq(schema.aiGatewayModels.updatedAt, update.expectedUpdatedAt)]
                : []),
            ),
          )
          .returning({ id: schema.aiGatewayModels.id });
        applied += updated.length;
      }
      for (const skipped of plan.skipped.filter(
        (item) => !resolvedOpenRouterIds.has(item.id),
      )) {
        const source = rows.find((row) => row.id === skipped.id);
        if (!source) continue;
        const [currentGateway] = await transaction
          .select({ credentialRevision: schema.aiGateways.credentialRevision })
          .from(schema.aiGateways)
          .where(eq(schema.aiGateways.id, source.gatewayId))
          .limit(1);
        if (
          source.credentialRevision !== undefined &&
          currentGateway?.credentialRevision !== source.credentialRevision
        ) {
          continue;
        }
        const updated = await transaction
          .update(schema.aiGatewayModels)
          .set({ approved: false, isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.aiGatewayModels.id, skipped.id),
              eq(schema.aiGatewayModels.approved, true),
              eq(schema.aiGatewayModels.modality, "language"),
              ...(source.updatedAt
                ? [eq(schema.aiGatewayModels.updatedAt, source.updatedAt)]
                : []),
            ),
          )
          .returning({ id: schema.aiGatewayModels.id });
        applied += updated.length;
      }
    });
  }

  console.info(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        organizationId: organizationId ?? null,
        scanned: plan.scanned,
        repairable: plan.repairable,
        applied,
        alreadyComplete: plan.alreadyComplete,
        skipped: plan.skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
