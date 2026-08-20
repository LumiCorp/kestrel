import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "../lib/knowledge/db";
import { planGatewayModelEconomicsProfileBackfill } from "../lib/ai/model-economics-profile-backfill";

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

  if (apply && plan.updates.length > 0) {
    await knowledgeDb.transaction(async (transaction) => {
      for (const update of plan.updates) {
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
