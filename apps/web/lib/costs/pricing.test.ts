import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRateAmount,
  parseModelCostIdentity,
  pricingBasisForRate,
} from "./pricing";

test("monthly fixed fees accrue against the applicable calendar month", () => {
  assert.equal(
    calculateRateAmount({
      quantity: 1,
      occurredAt: new Date("2026-02-10T00:00:00Z"),
      rate: {
        rateKind: "monthly",
        unitPriceUsd: 28,
        provenance: "contract",
      },
    }),
    1
  );
  assert.equal(
    calculateRateAmount({
      quantity: 1,
      occurredAt: new Date("2026-07-10T00:00:00Z"),
      rate: {
        rateKind: "monthly",
        unitPriceUsd: 31,
        provenance: "contract",
      },
    }),
    1
  );
});

test("annual fixed fees account for leap years", () => {
  assert.equal(
    calculateRateAmount({
      quantity: 1,
      occurredAt: new Date("2024-04-10T00:00:00Z"),
      rate: {
        rateKind: "annual",
        unitPriceUsd: 366,
        provenance: "contract",
      },
    }),
    1
  );
});

test("pricing basis keeps assumptions and allocated fees distinguishable", () => {
  assert.equal(
    pricingBasisForRate({
      rateKind: "unit",
      unitPriceUsd: 1,
      provenance: "assumption",
    }),
    "assumed"
  );
  assert.equal(
    pricingBasisForRate({
      rateKind: "annual",
      unitPriceUsd: 1,
      provenance: "assumption",
    }),
    "allocated_fixed"
  );
});

test("model cost identity separates provider and service", () => {
  assert.deepEqual(parseModelCostIdentity("openai/gpt-5-mini"), {
    provider: "openai",
    service: "gpt-5-mini",
  });
  assert.deepEqual(parseModelCostIdentity("gpt-5-mini"), {
    provider: "unknown",
    service: "gpt-5-mini",
  });
});
