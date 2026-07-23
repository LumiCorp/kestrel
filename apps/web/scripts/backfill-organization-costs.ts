import { backfillAuthoritativeUsage } from "@/lib/costs/metering";
import { accrueOrganizationFixedRates } from "@/lib/costs/metering";
import { priceAllUsageEvents } from "@/lib/costs/store";

async function main() {
  const backfill = await backfillAuthoritativeUsage();
  const fixedAccruals = await accrueOrganizationFixedRates();
  const usageEventsPriced = await priceAllUsageEvents();
  console.info(
    JSON.stringify({ backfill, fixedAccruals, usageEventsPriced }, null, 2)
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
