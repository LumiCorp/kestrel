import { CostsUsageAdminClient } from "@/components/settings/usage-client";
import { getOrganizationDashboardSnapshot } from "@/lib/costs/dashboard";
import { listCostRateCards } from "@/lib/costs/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";

export default async function OrganizationUsageSettingsPage() {
  const { organizationId, session } = await requireOrganizationAdmin();
  const organization = await knowledgeDb.query.organizations.findFirst({
    where: (table, { eq }) => eq(table.id, organizationId),
    columns: { id: true, name: true },
  });
  if (!organization) throw new Error("Organization not found.");
  const [snapshot, rates] = await Promise.all([
    getOrganizationDashboardSnapshot({
      organization,
      userId: session.user.id,
      isOrganizationAdmin: true,
      range: "mtd",
    }),
    listCostRateCards(organizationId),
  ]);
  return (
    <CostsUsageAdminClient
      initialRates={rates.map((rate) => ({
        id: rate.id,
        organizationId: rate.organizationId,
        category: rate.category,
        provider: rate.provider,
        service: rate.service,
        meter: rate.meter,
        unit: rate.unit,
        rateKind: rate.rateKind,
        unitPriceUsd: rate.unitPriceUsd,
        provenance: rate.provenance,
        sourceUrl: rate.sourceUrl,
        effectiveFrom: rate.effectiveFrom.toISOString(),
        effectiveTo: rate.effectiveTo?.toISOString() ?? null,
      }))}
      initialSnapshot={snapshot}
    />
  );
}
