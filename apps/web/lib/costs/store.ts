import "server-only";

import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type CostCategory,
  type CostVisibility,
  type RateCardInput,
  costVisibilitySchema,
  rateCardInputSchema,
} from "./contracts";
import { calculateRateAmount, pricingBasisForRate } from "./pricing";

const MONEY_SCALE = 100_000_000;

export type UsageEventInput = {
  organizationId: string;
  actorUserId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  runId?: string | null;
  category: CostCategory;
  provider: string;
  service: string;
  meter: string;
  quantity: number;
  unit: string;
  reportedAmountUsd?: number | null;
  sourceKind: string;
  sourceId: string;
  occurredAt: Date;
  intervalStartedAt?: Date | null;
  intervalEndedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

export async function recordUsageEvent(input: UsageEventInput) {
  assertFiniteNonnegative(input.quantity, "Usage quantity");
  if (input.reportedAmountUsd != null) {
    assertFiniteNonnegative(input.reportedAmountUsd, "Reported amount");
  }
  const now = new Date();
  const [event] = await knowledgeDb
    .insert(schema.organizationUsageEvents)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      projectId: input.projectId ?? null,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      category: input.category,
      provider: input.provider,
      service: input.service,
      meter: input.meter,
      quantity: decimal(input.quantity),
      unit: input.unit,
      reportedAmountUsd:
        input.reportedAmountUsd == null
          ? null
          : decimal(input.reportedAmountUsd),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      intervalStartedAt: input.intervalStartedAt ?? null,
      intervalEndedAt: input.intervalEndedAt ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationUsageEvents.organizationId,
        schema.organizationUsageEvents.sourceKind,
        schema.organizationUsageEvents.sourceId,
        schema.organizationUsageEvents.meter,
        schema.organizationUsageEvents.intervalStartedAt,
      ],
      set: {
        actorUserId: input.actorUserId ?? null,
        projectId: input.projectId ?? null,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        quantity: decimal(input.quantity),
        reportedAmountUsd:
          input.reportedAmountUsd == null
            ? null
            : decimal(input.reportedAmountUsd),
        intervalEndedAt: input.intervalEndedAt ?? null,
        metadata: input.metadata ?? null,
        updatedAt: now,
      },
    })
    .returning();
  if (!event) throw new Error("Usage event was not persisted.");
  return event;
}

export async function enrichUsageEvent(
  id: string,
  metadata: Record<string, unknown>
) {
  const event = await knowledgeDb.query.organizationUsageEvents.findFirst({
    where: eq(schema.organizationUsageEvents.id, id),
    columns: { metadata: true },
  });
  if (!event) return null;
  const [updated] = await knowledgeDb
    .update(schema.organizationUsageEvents)
    .set({
      metadata: { ...(event.metadata ?? {}), ...metadata },
      updatedAt: new Date(),
    })
    .where(eq(schema.organizationUsageEvents.id, id))
    .returning();
  return updated ?? null;
}

export async function priceUsageEvent(usageEventId: string) {
  const event = await knowledgeDb.query.organizationUsageEvents.findFirst({
    where: eq(schema.organizationUsageEvents.id, usageEventId),
  });
  if (!event) return null;

  if (event.reportedAmountUsd != null) {
    return writeCostRevision({
      event,
      amountUsd: Number(event.reportedAmountUsd),
      rateCard: null,
      pricingBasis: "provider_reported",
    });
  }

  const [rateCard] = await knowledgeDb
    .select()
    .from(schema.costRateCards)
    .where(
      and(
        or(
          eq(schema.costRateCards.organizationId, event.organizationId),
          isNull(schema.costRateCards.organizationId)
        ),
        eq(schema.costRateCards.category, event.category),
        eq(schema.costRateCards.provider, event.provider),
        eq(schema.costRateCards.service, event.service),
        eq(schema.costRateCards.meter, event.meter),
        eq(schema.costRateCards.unit, event.unit),
        eq(schema.costRateCards.enabled, true),
        lte(schema.costRateCards.effectiveFrom, event.occurredAt),
        or(
          isNull(schema.costRateCards.effectiveTo),
          gt(schema.costRateCards.effectiveTo, event.occurredAt)
        )
      )
    )
    .orderBy(
      desc(sql`case when ${schema.costRateCards.organizationId} is null then 0 else 1 end`),
      desc(schema.costRateCards.effectiveFrom)
    )
    .limit(1);
  if (!rateCard) {
    await knowledgeDb
      .update(schema.organizationCostEntries)
      .set({ isCurrent: false })
      .where(
        and(
          eq(schema.organizationCostEntries.usageEventId, event.id),
          eq(schema.organizationCostEntries.isCurrent, true)
        )
      );
    return null;
  }

  const amountUsd = calculateRateAmount({
    quantity: Number(event.quantity),
    occurredAt: event.occurredAt,
    rate: {
      rateKind: rateCard.rateKind,
      unitPriceUsd: Number(rateCard.unitPriceUsd),
      provenance: rateCard.provenance,
    },
  });
  return writeCostRevision({
    event,
    rateCard,
    amountUsd,
    pricingBasis: pricingBasisForRate({
      rateKind: rateCard.rateKind,
      unitPriceUsd: Number(rateCard.unitPriceUsd),
      provenance: rateCard.provenance,
    }),
  });
}

async function writeCostRevision(input: {
  event: typeof schema.organizationUsageEvents.$inferSelect;
  rateCard: typeof schema.costRateCards.$inferSelect | null;
  amountUsd: number;
  pricingBasis:
    | "provider_reported"
    | "measured_at_rate"
    | "allocated_fixed"
    | "assumed";
}) {
  const roundedAmount = roundMoney(input.amountUsd);
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`select ${schema.organizationUsageEvents.id}
          from ${schema.organizationUsageEvents}
          where ${schema.organizationUsageEvents.id} = ${input.event.id}
          for update`
    );
    const current = await transaction.query.organizationCostEntries.findFirst({
      where: and(
        eq(schema.organizationCostEntries.usageEventId, input.event.id),
        eq(schema.organizationCostEntries.isCurrent, true)
      ),
    });
    if (
      current &&
      Number(current.amountUsd) === roundedAmount &&
      current.rateCardId === (input.rateCard?.id ?? null) &&
      current.pricingBasis === input.pricingBasis &&
      Number(current.quantity) === Number(input.event.quantity)
    ) {
      return current;
    }

    if (current) {
      await transaction
        .update(schema.organizationCostEntries)
        .set({ isCurrent: false })
        .where(eq(schema.organizationCostEntries.id, current.id));
    }

    const [created] = await transaction
      .insert(schema.organizationCostEntries)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.event.organizationId,
        usageEventId: input.event.id,
        rateCardId: input.rateCard?.id ?? null,
        supersedesEntryId: current?.id ?? null,
        revision: (current?.revision ?? 0) + 1,
        amountUsd: decimal(roundedAmount),
        quantity: input.event.quantity,
        unitPriceUsd: input.rateCard?.unitPriceUsd ?? null,
        pricingBasis: input.pricingBasis,
        rateSnapshot: input.rateCard
          ? {
              category: input.rateCard.category,
              provider: input.rateCard.provider,
              service: input.rateCard.service,
              meter: input.rateCard.meter,
              unit: input.rateCard.unit,
              rateKind: input.rateCard.rateKind,
              unitPriceUsd: input.rateCard.unitPriceUsd,
              provenance: input.rateCard.provenance,
              effectiveFrom: input.rateCard.effectiveFrom.toISOString(),
              effectiveTo: input.rateCard.effectiveTo?.toISOString() ?? null,
              sourceUrl: input.rateCard.sourceUrl,
            }
          : { providerReported: true },
        isCurrent: true,
        pricedAt: new Date(),
        createdAt: new Date(),
      })
      .returning();
    if (!created) throw new Error("Cost entry was not persisted.");
    return created;
  });
}

export async function repriceOrganizationUsage(input: {
  organizationId: string;
  provider?: string;
  service?: string;
}) {
  const conditions = [
    eq(schema.organizationUsageEvents.organizationId, input.organizationId),
  ];
  if (input.provider) {
    conditions.push(eq(schema.organizationUsageEvents.provider, input.provider));
  }
  if (input.service) {
    conditions.push(eq(schema.organizationUsageEvents.service, input.service));
  }
  const events = await knowledgeDb
    .select({ id: schema.organizationUsageEvents.id })
    .from(schema.organizationUsageEvents)
    .where(and(...conditions));
  for (const event of events) await priceUsageEvent(event.id);
  return events.length;
}

export async function createOrganizationRateCard(input: {
  organizationId: string;
  actorUserId: string;
  rate: RateCardInput;
}) {
  const rate = rateCardInputSchema.parse(input.rate);
  const created = await knowledgeDb.transaction(async (transaction) => {
    const laterCards = await transaction.query.costRateCards.findMany({
      where: and(
        eq(schema.costRateCards.organizationId, input.organizationId),
        eq(schema.costRateCards.category, rate.category),
        eq(schema.costRateCards.provider, rate.provider),
        eq(schema.costRateCards.service, rate.service),
        eq(schema.costRateCards.meter, rate.meter),
        eq(schema.costRateCards.unit, rate.unit),
        gte(schema.costRateCards.effectiveFrom, rate.effectiveFrom),
        rate.effectiveTo
          ? lt(schema.costRateCards.effectiveFrom, rate.effectiveTo)
          : undefined
      ),
      columns: { id: true },
      limit: 1,
    });
    if (laterCards.length > 0) {
      throw new Error("A rate already begins within this effective period.");
    }
    await transaction
      .update(schema.costRateCards)
      .set({ effectiveTo: rate.effectiveFrom, updatedAt: new Date() })
      .where(
        and(
          eq(schema.costRateCards.organizationId, input.organizationId),
          eq(schema.costRateCards.category, rate.category),
          eq(schema.costRateCards.provider, rate.provider),
          eq(schema.costRateCards.service, rate.service),
          eq(schema.costRateCards.meter, rate.meter),
          eq(schema.costRateCards.unit, rate.unit),
          lt(schema.costRateCards.effectiveFrom, rate.effectiveFrom),
          or(
            isNull(schema.costRateCards.effectiveTo),
            gt(schema.costRateCards.effectiveTo, rate.effectiveFrom)
          )
        )
      );
    const [inserted] = await transaction
      .insert(schema.costRateCards)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        category: rate.category,
        provider: rate.provider,
        service: rate.service,
        meter: rate.meter,
        unit: rate.unit,
        rateKind: rate.rateKind,
        unitPriceUsd: decimal(rate.unitPriceUsd),
        provenance: rate.provenance,
        sourceUrl: rate.sourceUrl ?? null,
        effectiveFrom: rate.effectiveFrom,
        effectiveTo: rate.effectiveTo ?? null,
        enabled: true,
        createdByUserId: input.actorUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    if (!inserted) throw new Error("Rate card was not persisted.");
    return inserted;
  });
  if (!created) throw new Error("Rate card was not persisted.");
  await repriceOrganizationUsage({
    organizationId: input.organizationId,
    provider: rate.provider,
    service: rate.service,
  });
  return created;
}

export async function listCostRateCards(organizationId: string) {
  return knowledgeDb
    .select()
    .from(schema.costRateCards)
    .where(
      or(
        eq(schema.costRateCards.organizationId, organizationId),
        isNull(schema.costRateCards.organizationId)
      )
    )
    .orderBy(
      schema.costRateCards.category,
      schema.costRateCards.provider,
      schema.costRateCards.service,
      schema.costRateCards.meter,
      desc(schema.costRateCards.effectiveFrom)
    );
}

export async function endOrganizationRateCard(input: {
  organizationId: string;
  rateCardId: string;
  effectiveTo: Date;
}) {
  const existing = await knowledgeDb.query.costRateCards.findFirst({
    where: and(
      eq(schema.costRateCards.id, input.rateCardId),
      eq(schema.costRateCards.organizationId, input.organizationId)
    ),
  });
  if (!existing) throw new Error("Organization rate card not found.");
  if (input.effectiveTo <= existing.effectiveFrom) {
    throw new Error("Effective end must follow the rate start.");
  }
  const [updated] = await knowledgeDb
    .update(schema.costRateCards)
    .set({ effectiveTo: input.effectiveTo, updatedAt: new Date() })
    .where(eq(schema.costRateCards.id, existing.id))
    .returning();
  if (!updated) throw new Error("Rate card was not updated.");
  await repriceOrganizationUsage({
    organizationId: input.organizationId,
    provider: existing.provider,
    service: existing.service,
  });
  return updated;
}

export async function getOrganizationDashboardSettings(
  organizationId: string
): Promise<{ costVisibility: CostVisibility }> {
  const settings = await knowledgeDb.query.organizationDashboardSettings.findFirst({
    where: eq(
      schema.organizationDashboardSettings.organizationId,
      organizationId
    ),
  });
  return {
    costVisibility: costVisibilitySchema.parse(
      settings?.costVisibility ?? "all_members"
    ),
  };
}

export async function saveOrganizationDashboardSettings(input: {
  organizationId: string;
  actorUserId: string;
  costVisibility: CostVisibility;
}) {
  const costVisibility = costVisibilitySchema.parse(input.costVisibility);
  const now = new Date();
  const [settings] = await knowledgeDb
    .insert(schema.organizationDashboardSettings)
    .values({
      organizationId: input.organizationId,
      costVisibility,
      updatedByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.organizationDashboardSettings.organizationId,
      set: {
        costVisibility,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      },
    })
    .returning();
  if (!settings) throw new Error("Dashboard settings were not persisted.");
  return settings;
}

export async function listUnpricedUsage(organizationId: string) {
  return knowledgeDb
    .select({
      event: schema.organizationUsageEvents,
    })
    .from(schema.organizationUsageEvents)
    .leftJoin(
      schema.organizationCostEntries,
      and(
        eq(
          schema.organizationCostEntries.usageEventId,
          schema.organizationUsageEvents.id
        ),
        eq(schema.organizationCostEntries.isCurrent, true)
      )
    )
    .where(
      and(
        eq(schema.organizationUsageEvents.organizationId, organizationId),
        isNull(schema.organizationCostEntries.id)
      )
    );
}

function decimal(value: number) {
  return value.toFixed(10);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * MONEY_SCALE) / MONEY_SCALE;
}

function assertFiniteNonnegative(value: number, label: string) {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

export async function priceUsageEventsByIds(ids: string[]) {
  for (const id of new Set(ids.filter(Boolean))) await priceUsageEvent(id);
}

export async function priceRecentUnpricedUsage(organizationIds?: string[]) {
  const conditions = [isNull(schema.organizationCostEntries.id)];
  if (organizationIds?.length) {
    conditions.push(
      inArray(schema.organizationUsageEvents.organizationId, organizationIds)
    );
  }
  const events = await knowledgeDb
    .select({ id: schema.organizationUsageEvents.id })
    .from(schema.organizationUsageEvents)
    .leftJoin(
      schema.organizationCostEntries,
      and(
        eq(
          schema.organizationCostEntries.usageEventId,
          schema.organizationUsageEvents.id
        ),
        eq(schema.organizationCostEntries.isCurrent, true)
      )
    )
    .where(and(...conditions))
    .orderBy(desc(schema.organizationUsageEvents.updatedAt))
    .limit(5000);
  await priceUsageEventsByIds(events.map((event) => event.id));
  return events.length;
}

export async function priceRecentlyUpdatedUsage(since: Date) {
  const events = await knowledgeDb
    .select({ id: schema.organizationUsageEvents.id })
    .from(schema.organizationUsageEvents)
    .where(gte(schema.organizationUsageEvents.updatedAt, since))
    .limit(5000);
  await priceUsageEventsByIds(events.map((event) => event.id));
  return events.length;
}

export async function priceAllUsageEvents() {
  let cursor: string | undefined;
  let priced = 0;
  while (true) {
    const events = await knowledgeDb
      .select({ id: schema.organizationUsageEvents.id })
      .from(schema.organizationUsageEvents)
      .where(cursor ? gt(schema.organizationUsageEvents.id, cursor) : undefined)
      .orderBy(schema.organizationUsageEvents.id)
      .limit(1000);
    if (events.length === 0) return priced;
    await priceUsageEventsByIds(events.map((event) => event.id));
    priced += events.length;
    cursor = events.at(-1)?.id;
  }
}
