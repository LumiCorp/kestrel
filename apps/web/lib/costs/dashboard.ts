import "server-only";

import { and, eq, gte, lt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type CostCategory,
  type DashboardCostAmount,
  type DashboardPeriod,
  type DashboardRange,
  type OrganizationDashboardSnapshot,
  type PricingBasis,
  resolveDashboardPeriod,
} from "./contracts";
import { getOrganizationDashboardSettings } from "./store";

const CATEGORIES: CostCategory[] = [
  "models",
  "environments",
  "managed_compute",
  "services",
];

type CostRow = Awaited<ReturnType<typeof loadCostRows>>[number];

export async function getOrganizationDashboardSnapshot(input: {
  organization: { id: string; name: string };
  userId: string;
  isOrganizationAdmin: boolean;
  range: DashboardRange;
  now?: Date;
}): Promise<OrganizationDashboardSnapshot> {
  const period = resolveDashboardPeriod(input.range, input.now);
  const now = input.now ?? new Date();
  const [settings, currentRows, previousRows, turnRows, members, projects] =
    await Promise.all([
      getOrganizationDashboardSettings(input.organization.id),
      loadCostRows(
        input.organization.id,
        period.startedAt,
        period.endedAt
      ),
      loadCostRows(
        input.organization.id,
        period.comparisonStartedAt,
        period.comparisonEndedAt
      ),
      loadTurnRows(input.organization.id, period),
      knowledgeDb
        .select({
          userId: schema.members.userId,
          name: schema.users.name,
        })
        .from(schema.members)
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .where(eq(schema.members.organizationId, input.organization.id)),
      knowledgeDb
        .select({ id: schema.projects.id, name: schema.projects.name })
        .from(schema.projects)
        .where(eq(schema.projects.organizationId, input.organization.id)),
    ]);

  const costsVisible =
    settings.costVisibility === "all_members" || input.isOrganizationAdmin;
  const current = aggregateCostRows(currentRows);
  const previous = aggregateCostRows(previousRows);
  const turns = summarizeTurns(turnRows);
  const totalCost = costAmount(
    current.total,
    previous.total,
    costsVisible,
    current.complete && previous.complete
  );
  const asOf = newestDate([
    ...currentRows.map(
      (row) => row.event.intervalEndedAt ?? row.event.occurredAt
    ),
    ...turnRows.map((row) => row.createdAt),
  ], period.endedAt);

  const memberNames = new Map(members.map((member) => [member.userId, member.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const people = input.isOrganizationAdmin
    ? buildPeople(currentRows, turnRows, memberNames, costsVisible)
    : [];
  const projectRows = input.isOrganizationAdmin
    ? buildProjects(currentRows, turnRows, projectNames, costsVisible)
    : [];
  const currentUserCost = currentRows.reduce(
    (sum, row) =>
      row.event.actorUserId === input.userId && row.cost
        ? sum + Number(row.cost.amountUsd)
        : sum,
    0
  );
  const currentUserTurns = turnRows.filter(
    (row) => row.authorUserId === input.userId
  );
  const currentUserTokens = currentUserTurns.reduce(
    (sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    0
  );

  return {
    organization: input.organization,
    period: serializePeriod(period),
    costVisibility: settings.costVisibility,
    costsVisible,
    asOf: asOf.toISOString(),
    sourceFreshness: buildSourceFreshness(currentRows, turnRows, now),
    totals: {
      ...totalCost,
      activeMembers: turns.activeMembers.size,
      runs: turns.runs,
      completedRuns: turns.completed,
      failedRuns: turns.failed,
      modelTokens: turns.modelTokens,
      serviceInvocations: currentRows.reduce(
        (sum, row) =>
          row.event.category === "services" && row.event.unit === "invocation"
            ? sum + Number(row.event.quantity)
            : sum,
        0
      ),
    },
    categories: CATEGORIES.map((category) => {
      const usage = current.usageByCategory.get(category);
      return {
        category,
        ...costAmount(
          current.byCategory.get(category) ?? 0,
          previous.byCategory.get(category) ?? 0,
          costsVisible,
          current.complete && previous.complete
        ),
        usageQuantity: usage?.quantity ?? 0,
        usageUnit:
          usage && usage.units.size === 1
            ? [...usage.units][0] ?? "units"
            : "metered units",
        basisBreakdown: costsVisible
          ? [...(current.byCategoryBasis.get(category) ?? new Map()).entries()].map(
              ([basis, amountUsd]) => ({
                basis,
                amountUsd: roundMoney(amountUsd),
              })
            )
          : [],
      };
    }),
    basisBreakdown: costsVisible
      ? [...current.byBasis.entries()].map(([basis, amountUsd]) => ({
          basis,
          amountUsd: roundMoney(amountUsd),
        }))
      : [],
    pricingCoverage: {
      activeMeters: current.activeMeters.size,
      pricedMeters: [...current.activeMeters].filter(
        (meter) => !current.unpricedMeterKeys.has(meter)
      ).length,
      complete: current.complete,
      unpricedServices: [...current.unpriced.values()].sort((a, b) =>
        `${a.provider}/${a.service}/${a.meter}`.localeCompare(
          `${b.provider}/${b.service}/${b.meter}`
        )
      ),
    },
    daily: buildDailySeries(currentRows, period, costsVisible),
    activity: {
      organization: {
        runs: turns.runs,
        completedRuns: turns.completed,
        failedRuns: turns.failed,
      },
      currentUser: {
        runs: currentUserTurns.length,
        completedRuns: currentUserTurns.filter(
          (row) => row.status === "completed"
        ).length,
        failedRuns: currentUserTurns.filter((row) => row.status === "failed")
          .length,
        modelTokens: currentUserTokens,
        attributedCostUsd: costsVisible ? roundMoney(currentUserCost) : null,
      },
    },
    people,
    projects: projectRows,
  };
}

async function loadCostRows(
  organizationId: string,
  startedAt: Date,
  endedAt: Date
) {
  return knowledgeDb
    .select({
      event: schema.organizationUsageEvents,
      cost: schema.organizationCostEntries,
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
        gte(schema.organizationUsageEvents.occurredAt, startedAt),
        lt(schema.organizationUsageEvents.occurredAt, endedAt)
      )
    );
}

async function loadTurnRows(
  organizationId: string,
  period: DashboardPeriod
) {
  return knowledgeDb
    .select({
      id: schema.threadTurns.id,
      authorUserId: schema.threadTurns.authorUserId,
      status: schema.threadTurns.status,
      projectId: schema.threads.projectId,
      inputTokens: schema.threadMessages.inputTokens,
      outputTokens: schema.threadMessages.outputTokens,
      createdAt: schema.threadTurns.createdAt,
    })
    .from(schema.threadTurns)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadTurns.threadId))
    .leftJoin(
      schema.threadMessages,
      eq(schema.threadMessages.id, schema.threadTurns.outputMessageId)
    )
    .where(
      and(
        eq(schema.threadTurns.organizationId, organizationId),
        gte(schema.threadTurns.createdAt, period.startedAt),
        lt(schema.threadTurns.createdAt, period.endedAt)
      )
    );
}

function aggregateCostRows(rows: CostRow[]) {
  const byCategory = new Map<CostCategory, number>();
  const byBasis = new Map<PricingBasis, number>();
  const byCategoryBasis = new Map<
    CostCategory,
    Map<PricingBasis, number>
  >();
  const activeMeters = new Set<string>();
  const pricedMeters = new Set<string>();
  const unpriced = new Map<
    string,
    { provider: string; service: string; meter: string; eventCount: number }
  >();
  const unpricedMeterKeys = new Set<string>();
  const usageByCategory = new Map<
    CostCategory,
    { quantity: number; units: Set<string> }
  >();
  let total = 0;

  for (const row of rows) {
    const meterKey = `${row.event.provider}/${row.event.service}/${row.event.meter}/${row.event.unit}`;
    activeMeters.add(meterKey);
    const usage = usageByCategory.get(row.event.category) ?? {
      quantity: 0,
      units: new Set<string>(),
    };
    usage.quantity += Number(row.event.quantity);
    usage.units.add(row.event.unit);
    usageByCategory.set(row.event.category, usage);

    if (!row.cost) {
      unpricedMeterKeys.add(meterKey);
      const key = `${row.event.provider}/${row.event.service}/${row.event.meter}`;
      const existing = unpriced.get(key);
      unpriced.set(key, {
        provider: row.event.provider,
        service: row.event.service,
        meter: row.event.meter,
        eventCount: (existing?.eventCount ?? 0) + 1,
      });
      continue;
    }
    pricedMeters.add(meterKey);
    const amount = Number(row.cost.amountUsd);
    total += amount;
    byCategory.set(
      row.event.category,
      (byCategory.get(row.event.category) ?? 0) + amount
    );
    byBasis.set(
      row.cost.pricingBasis,
      (byBasis.get(row.cost.pricingBasis) ?? 0) + amount
    );
    const categoryBasis = byCategoryBasis.get(row.event.category) ?? new Map();
    categoryBasis.set(
      row.cost.pricingBasis,
      (categoryBasis.get(row.cost.pricingBasis) ?? 0) + amount
    );
    byCategoryBasis.set(row.event.category, categoryBasis);
  }

  return {
    total,
    byCategory,
    byBasis,
    byCategoryBasis,
    activeMeters,
    pricedMeters,
    unpriced,
    unpricedMeterKeys,
    usageByCategory,
    complete: unpriced.size === 0,
  };
}

function summarizeTurns(
  rows: Awaited<ReturnType<typeof loadTurnRows>>
) {
  const activeMembers = new Set<string>();
  let completed = 0;
  let failed = 0;
  let modelTokens = 0;
  for (const row of rows) {
    activeMembers.add(row.authorUserId);
    if (row.status === "completed") completed += 1;
    if (row.status === "failed") failed += 1;
    modelTokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  }
  return { runs: rows.length, completed, failed, modelTokens, activeMembers };
}

function buildDailySeries(
  rows: CostRow[],
  period: DashboardPeriod,
  visible: boolean
): OrganizationDashboardSnapshot["daily"] {
  const days = new Map<
    string,
    { models: number; environments: number; managedCompute: number; services: number }
  >();
  for (
    let cursor = Date.UTC(
      period.startedAt.getUTCFullYear(),
      period.startedAt.getUTCMonth(),
      period.startedAt.getUTCDate()
    );
    cursor < period.endedAt.getTime();
    cursor += 86_400_000
  ) {
    days.set(new Date(cursor).toISOString().slice(0, 10), emptyDay());
  }
  for (const row of rows) {
    if (!row.cost) continue;
    const key = row.event.occurredAt.toISOString().slice(0, 10);
    const day = days.get(key) ?? emptyDay();
    const amount = Number(row.cost.amountUsd);
    if (row.event.category === "models") day.models += amount;
    if (row.event.category === "environments") day.environments += amount;
    if (row.event.category === "managed_compute") day.managedCompute += amount;
    if (row.event.category === "services") day.services += amount;
    days.set(key, day);
  }
  return [...days.entries()].map(([date, values]) => ({
    date,
    models: visible ? roundMoney(values.models) : null,
    environments: visible ? roundMoney(values.environments) : null,
    managedCompute: visible ? roundMoney(values.managedCompute) : null,
    services: visible ? roundMoney(values.services) : null,
  }));
}

function buildPeople(
  costRows: CostRow[],
  turnRows: Awaited<ReturnType<typeof loadTurnRows>>,
  names: Map<string, string>,
  visible: boolean
) {
  const people = new Map<string, { runs: number; cost: number }>();
  for (const row of turnRows) {
    const current = people.get(row.authorUserId) ?? { runs: 0, cost: 0 };
    current.runs += 1;
    people.set(row.authorUserId, current);
  }
  for (const row of costRows) {
    if (!(row.event.actorUserId && row.cost)) continue;
    const current = people.get(row.event.actorUserId) ?? { runs: 0, cost: 0 };
    current.cost += Number(row.cost.amountUsd);
    people.set(row.event.actorUserId, current);
  }
  return [...people.entries()]
    .map(([userId, value]) => ({
      userId,
      name: names.get(userId) ?? "Former member",
      runs: value.runs,
      attributedCostUsd: visible ? roundMoney(value.cost) : null,
    }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

function buildProjects(
  costRows: CostRow[],
  turnRows: Awaited<ReturnType<typeof loadTurnRows>>,
  names: Map<string, string>,
  visible: boolean
) {
  const projects = new Map<string, { runs: number; cost: number }>();
  for (const row of turnRows) {
    if (!row.projectId) continue;
    const current = projects.get(row.projectId) ?? { runs: 0, cost: 0 };
    current.runs += 1;
    projects.set(row.projectId, current);
  }
  for (const row of costRows) {
    if (!(row.event.projectId && row.cost)) continue;
    const current = projects.get(row.event.projectId) ?? { runs: 0, cost: 0 };
    current.cost += Number(row.cost.amountUsd);
    projects.set(row.event.projectId, current);
  }
  return [...projects.entries()]
    .map(([projectId, value]) => ({
      projectId,
      name: names.get(projectId) ?? "Deleted project",
      runs: value.runs,
      attributedCostUsd: visible ? roundMoney(value.cost) : null,
    }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

function costAmount(
  amount: number,
  previous: number,
  visible: boolean,
  comparable: boolean
): DashboardCostAmount {
  return {
    amountUsd: visible ? roundMoney(amount) : null,
    previousAmountUsd: visible ? roundMoney(previous) : null,
    deltaPercent:
      visible && comparable && previous > 0
        ? roundMoney(((amount - previous) / previous) * 100)
        : null,
  };
}

function serializePeriod(period: DashboardPeriod) {
  return {
    range: period.range,
    startedAt: period.startedAt.toISOString(),
    endedAt: period.endedAt.toISOString(),
    comparisonStartedAt: period.comparisonStartedAt.toISOString(),
    comparisonEndedAt: period.comparisonEndedAt.toISOString(),
  };
}

function newestDate(dates: Date[], fallback: Date) {
  if (dates.length === 0) return fallback;
  return dates.reduce(
    (latest, date) => (date > latest ? date : latest),
    new Date(0)
  );
}

function buildSourceFreshness(
  rows: CostRow[],
  turns: Awaited<ReturnType<typeof loadTurnRows>>,
  now: Date
): OrganizationDashboardSnapshot["sourceFreshness"] {
  const sources = new Map<string, Date>();
  for (const row of rows) {
    const source = `${row.event.provider} · ${row.event.sourceKind}`;
    const sourceTimestamp =
      row.event.intervalEndedAt ?? row.event.occurredAt;
    const current = sources.get(source);
    if (!current || sourceTimestamp > current) {
      sources.set(source, sourceTimestamp);
    }
  }
  for (const turn of turns) {
    const current = sources.get("Kestrel activity");
    if (!current || turn.createdAt > current) {
      sources.set("Kestrel activity", turn.createdAt);
    }
  }
  return [...sources.entries()]
    .map(([source, lastUpdatedAt]) => ({
      source,
      lastUpdatedAt: lastUpdatedAt.toISOString(),
      lagSeconds: Math.max(
        0,
        Math.round((now.getTime() - lastUpdatedAt.getTime()) / 1000)
      ),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

function emptyDay() {
  return { models: 0, environments: 0, managedCompute: 0, services: 0 };
}
