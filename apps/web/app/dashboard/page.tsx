import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { getOrganizationDashboardSnapshot } from "@/lib/costs/dashboard";
import { parseDashboardRange } from "@/lib/costs/contracts";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";
import { CostTrendChart } from "./cost-trend-chart";
import { DashboardRangeSelect } from "./dashboard-range-select";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { activeOrganization, canManageActiveOrganization, session } =
    await requireAuthenticatedShell({ requireActiveOrganization: true });
  if (!activeOrganization) throw new Error("Active organization required.");
  const range = parseDashboardRange((await searchParams).range);
  const snapshot = await getOrganizationDashboardSnapshot({
    organization: {
      id: activeOrganization.id,
      name: activeOrganization.name,
    },
    userId: session.user.id,
    isOrganizationAdmin: canManageActiveOrganization,
    range,
  });
  const hasUsage = snapshot.pricingCoverage.activeMeters > 0;
  const hasPricedUsage = snapshot.pricingCoverage.pricedMeters > 0;

  return (
    <AppPage className="space-y-5">
      <AdminPageHeader
        actions={<DashboardRangeSelect value={range} />}
        description={`As of ${formatDateTime(snapshot.asOf)}`}
        title="Operating overview"
      />

      {snapshot.costsVisible ? null : (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          Your organization limits dollar amounts to owners and admins. Usage
          and activity remain visible.
        </div>
      )}

      <MetricGrid>
        <Metric
          label="Attributed operating cost"
          value={formatOptionalUsd(snapshot.totals.amountUsd)}
        />
        <Metric label="Runs" value={formatNumber(snapshot.totals.runs)} />
        <Metric
          label="Failed"
          value={formatNumber(snapshot.totals.failedRuns)}
        />
        <Metric
          label="Active members"
          value={formatNumber(snapshot.totals.activeMembers)}
        />
      </MetricGrid>

      <section className="border-b pb-5">
        <h2 className="font-medium text-sm">Daily attributed cost</h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Operating cost, not a Kestrel invoice.
        </p>
        <div className="mt-3">
          {snapshot.costsVisible && hasPricedUsage ? (
            <CostTrendChart data={snapshot.daily} />
          ) : (
            <EmptyState
              message={
                snapshot.costsVisible
                  ? hasUsage
                    ? "Usage exists, but its active meters are unpriced."
                    : "No metered usage has been recorded in this period."
                  : "Cost amounts are hidden by your organization."
              }
            />
          )}
          {snapshot.sourceFreshness.length ? (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Data sources ({snapshot.sourceFreshness.length})
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {snapshot.sourceFreshness.map((source) => (
                  <div className="text-xs" key={source.source}>
                    <div className="font-medium">{source.source}</div>
                    <div className="text-muted-foreground">
                      Updated {formatDateTime(source.lastUpdatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </section>

      <section className="border-b pb-5">
        <h2 className="mb-3 font-medium text-sm">Cost by category</h2>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          {snapshot.categories.map((category) => (
            <div className="min-w-0" key={category.category}>
              <div className="text-muted-foreground text-xs capitalize">
                {category.category.replace("_", " ")}
              </div>
              <div className="mt-1 font-semibold text-lg tabular-nums">
                {formatOptionalUsd(category.amountUsd)}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
                <span>
                  {formatCompact(category.usageQuantity)} {category.usageUnit}
                </span>
                {category.deltaPercent == null ? null : (
                  <span>{formatDelta(category.deltaPercent)} vs prior</span>
                )}
                {category.basisBreakdown.length ? (
                  <span>
                    {category.basisBreakdown
                      .map((basis) => formatBasis(basis.basis))
                      .join(", ")}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {canManageActiveOrganization ? (
        <section className="border-b pb-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-medium text-sm">Attribution</h2>
            <Button asChild size="sm" variant="outline">
              <Link href="/organization/usage">
                Open explorer <ExternalLink className="ml-1 size-3.5" />
              </Link>
            </Button>
          </div>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <AttributionList
              rows={snapshot.people.map((row) => ({
                id: row.userId,
                name: row.name,
                runs: row.runs,
                amount: row.attributedCostUsd,
              }))}
              title="Members"
            />
            <AttributionList
              rows={snapshot.projects.map((row) => ({
                id: row.projectId,
                name: row.name,
                runs: row.runs,
                amount: row.attributedCostUsd,
              }))}
              title="Projects"
            />
          </div>
        </section>
      ) : null}

      {snapshot.pricingCoverage.complete ? null : (
        <section className="border-amber-500/50 border-l-2 pl-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium text-sm">Pricing needs attention</h2>
            {canManageActiveOrganization ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/organization/usage">Review pricing</Link>
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-muted-foreground text-xs/5">
            {snapshot.pricingCoverage.pricedMeters} of{" "}
            {snapshot.pricingCoverage.activeMeters} active meters are priced.
          </p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Unpriced services (
              {snapshot.pricingCoverage.unpricedServices.length})
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              {snapshot.pricingCoverage.unpricedServices.map((item) => (
                <div key={`${item.provider}/${item.service}/${item.meter}`}>
                  {item.provider} · {item.service} · {item.meter} (
                  {item.eventCount})
                </div>
              ))}
            </div>
          </details>
        </section>
      )}
    </AppPage>
  );
}

function MetricGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-2 xl:grid-cols-4">
      {children}
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-semibold text-xl tabular-nums">{value}</dd>
    </div>
  );
}

function AttributionList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    id: string;
    name: string;
    runs: number;
    amount: number | null;
  }>;
}) {
  return (
    <div>
      <h3 className="mb-2 font-medium text-sm">{title}</h3>
      <div className="divide-y border-y">
        {rows.slice(0, 8).map((row) => (
          <div
            className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
            key={row.id}
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{row.name}</div>
              <div className="text-muted-foreground text-xs">
                {formatNumber(row.runs)} runs
              </div>
            </div>
            <div className="font-mono tabular-nums">
              {formatOptionalUsd(row.amount)}
            </div>
          </div>
        ))}
        {rows.length === 0 ? (
          <div className="px-3 py-5 text-center text-muted-foreground text-sm">
            No activity
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-muted-foreground text-sm">
      {message}
    </div>
  );
}

function formatOptionalUsd(value: number | null) {
  return value == null ? "Hidden" : formatUsd(value);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDelta(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatBasis(value: string) {
  return value
    .replace("provider_reported", "reported")
    .replace("measured_at_rate", "calculated")
    .replace("allocated_fixed", "allocated");
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
