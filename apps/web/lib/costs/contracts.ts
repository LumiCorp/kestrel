import { z } from "zod";

export const costCategorySchema = z.enum([
  "models",
  "environments",
  "managed_compute",
  "services",
]);
export type CostCategory = z.infer<typeof costCategorySchema>;

export const pricingBasisSchema = z.enum([
  "provider_reported",
  "measured_at_rate",
  "allocated_fixed",
  "assumed",
]);
export type PricingBasis = z.infer<typeof pricingBasisSchema>;

export const dashboardRangeSchema = z.enum(["mtd", "7d", "30d", "90d"]);
export type DashboardRange = z.infer<typeof dashboardRangeSchema>;

export const costVisibilitySchema = z.enum(["all_members", "admins_only"]);
export type CostVisibility = z.infer<typeof costVisibilitySchema>;

export const rateCardInputSchema = z
  .object({
    category: costCategorySchema,
    provider: z.string().trim().min(1).max(120),
    service: z.string().trim().min(1).max(180),
    meter: z.string().trim().min(1).max(180),
    unit: z.string().trim().min(1).max(80),
    rateKind: z.enum(["unit", "monthly", "annual"]).default("unit"),
    unitPriceUsd: z.coerce.number().finite().min(0).max(1_000_000_000),
    provenance: z.enum(["contract", "assumption"]),
    sourceUrl: z.string().url().max(2000).optional(),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().optional(),
  })
  .strict()
  .refine(
    (value) => !value.effectiveTo || value.effectiveTo > value.effectiveFrom,
    { path: ["effectiveTo"], message: "Effective end must follow effective start." }
  );
export type RateCardInput = z.infer<typeof rateCardInputSchema>;

export type DashboardPeriod = {
  range: DashboardRange;
  startedAt: Date;
  endedAt: Date;
  comparisonStartedAt: Date;
  comparisonEndedAt: Date;
};

export type DashboardCostAmount = {
  amountUsd: number | null;
  previousAmountUsd: number | null;
  deltaPercent: number | null;
};

export type OrganizationDashboardSnapshot = {
  organization: { id: string; name: string };
  period: {
    range: DashboardRange;
    startedAt: string;
    endedAt: string;
    comparisonStartedAt: string;
    comparisonEndedAt: string;
  };
  costVisibility: CostVisibility;
  costsVisible: boolean;
  asOf: string;
  sourceFreshness: Array<{
    source: string;
    lastUpdatedAt: string;
    lagSeconds: number;
  }>;
  totals: DashboardCostAmount & {
    activeMembers: number;
    runs: number;
    completedRuns: number;
    failedRuns: number;
    modelTokens: number;
    serviceInvocations: number;
  };
  categories: Array<
    DashboardCostAmount & {
      category: CostCategory;
      usageQuantity: number;
      usageUnit: string;
      basisBreakdown: Array<{ basis: PricingBasis; amountUsd: number }>;
    }
  >;
  basisBreakdown: Array<{ basis: PricingBasis; amountUsd: number }>;
  pricingCoverage: {
    activeMeters: number;
    pricedMeters: number;
    complete: boolean;
    unpricedServices: Array<{
      provider: string;
      service: string;
      meter: string;
      eventCount: number;
    }>;
  };
  daily: Array<{
    date: string;
    models: number | null;
    environments: number | null;
    managedCompute: number | null;
    services: number | null;
  }>;
  activity: {
    organization: { runs: number; completedRuns: number; failedRuns: number };
    currentUser: {
      runs: number;
      completedRuns: number;
      failedRuns: number;
      modelTokens: number;
      attributedCostUsd: number | null;
    };
  };
  people: Array<{
    userId: string;
    name: string;
    runs: number;
    attributedCostUsd: number | null;
  }>;
  projects: Array<{
    projectId: string;
    name: string;
    runs: number;
    attributedCostUsd: number | null;
  }>;
};

export function parseDashboardRange(value: unknown): DashboardRange {
  const parsed = dashboardRangeSchema.safeParse(value);
  return parsed.success ? parsed.data : "mtd";
}

export function resolveDashboardPeriod(
  range: DashboardRange,
  now = new Date()
): DashboardPeriod {
  const endedAt = new Date(now);
  if (range === "mtd") {
    const startedAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const comparisonStartedAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    );
    const previousMonthEndedAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const elapsed = endedAt.getTime() - startedAt.getTime();
    const comparisonEndedAt = new Date(
      Math.min(
        previousMonthEndedAt.getTime(),
        comparisonStartedAt.getTime() + elapsed
      )
    );
    return {
      range,
      startedAt,
      endedAt,
      comparisonStartedAt,
      comparisonEndedAt,
    };
  }

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const durationMs = days * 24 * 60 * 60 * 1000;
  const startedAt = new Date(endedAt.getTime() - durationMs);
  return {
    range,
    startedAt,
    endedAt,
    comparisonStartedAt: new Date(startedAt.getTime() - durationMs),
    comparisonEndedAt: startedAt,
  };
}
