import type { PricingBasis } from "./contracts";

export type PriceableRate = {
  rateKind: "unit" | "monthly" | "annual";
  unitPriceUsd: number;
  provenance: "published" | "contract" | "assumption";
};

export function calculateRateAmount(input: {
  quantity: number;
  occurredAt: Date;
  rate: PriceableRate;
}) {
  const divisor =
    input.rate.rateKind === "monthly"
      ? daysInUtcMonth(input.occurredAt)
      : input.rate.rateKind === "annual"
        ? daysInUtcYear(input.occurredAt)
        : 1;
  return (input.quantity * input.rate.unitPriceUsd) / divisor;
}

export function pricingBasisForRate(rate: PriceableRate): PricingBasis {
  if (rate.rateKind !== "unit") return "allocated_fixed";
  return rate.provenance === "assumption" ? "assumed" : "measured_at_rate";
}

function daysInUtcMonth(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
}

function daysInUtcYear(date: Date) {
  const year = date.getUTCFullYear();
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
}
