import {
  Activity,
  Boxes,
  Bot,
  Cpu,
  DollarSign,
  ExternalLink,
  Server,
  Users,
} from "lucide-react";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganizationDashboardSnapshot } from "@/lib/costs/dashboard";
import {
  type CostCategory,
  parseDashboardRange,
} from "@/lib/costs/contracts";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";
import { CostTrendChart } from "./cost-trend-chart";

const CATEGORY_COPY: Record<
  CostCategory,
  { label: string; description: string; icon: typeof Bot }
> = {
  models: {
    label: "Models",
    description: "Token and model API usage",
    icon: Bot,
  },
  environments: {
    label: "Environments",
    description: "Fly compute, storage, and network",
    icon: Server,
  },
  managed_compute: {
    label: "Managed compute",
    description: "RunPod endpoints and storage",
    icon: Cpu,
  },
  services: {
    label: "Services",
    description: "Apps, MCP, email, and tunnels",
    icon: Boxes,
  },
};

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
    <AppPage>
      <AdminPageHeader
        actions={
          <div className="flex flex-wrap gap-2">
            {(["mtd", "7d", "30d", "90d"] as const).map((option) => (
              <Button
                asChild
                key={option}
                size="sm"
                variant={range === option ? "default" : "outline"}
              >
                <Link href={`/dashboard?range=${option}`}>
                  {option === "mtd" ? "Month to date" : option.replace("d", " days")}
                </Link>
              </Button>
            ))}
          </div>
        }
        description={`Attributed operating cost and activity for ${snapshot.organization.name}. As of ${formatDateTime(snapshot.asOf)}.`}
        eyebrow="Organization pulse"
        title="Costs and activity"
      />

      {snapshot.costsVisible ? null : (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          Your organization limits dollar amounts to owners and admins. Usage and
          activity remain visible.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HeadlineMetric
          icon={DollarSign}
          label="Attributed operating cost"
          value={formatOptionalUsd(snapshot.totals.amountUsd)}
        />
        <HeadlineMetric
          icon={Users}
          label="Active members"
          value={formatNumber(snapshot.totals.activeMembers)}
        />
        <HeadlineMetric
          icon={Activity}
          label="Runs"
          value={formatNumber(snapshot.totals.runs)}
        />
        <HeadlineMetric
          icon={Bot}
          label="Model tokens"
          value={formatCompact(snapshot.totals.modelTokens)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {snapshot.categories.map((category) => {
          const copy = CATEGORY_COPY[category.category];
          const Icon = copy.icon;
          return (
            <Card key={category.category}>
              <CardHeader className="space-y-1 pb-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{copy.label}</CardTitle>
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-xs">{copy.description}</p>
              </CardHeader>
              <CardContent>
                <div className="font-semibold text-2xl tabular-nums">
                  {formatOptionalUsd(category.amountUsd)}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <span>
                    {formatCompact(category.usageQuantity)} {category.usageUnit}
                  </span>
                  {category.deltaPercent == null ? null : (
                    <Badge variant="secondary">
                      {formatDelta(category.deltaPercent)} vs prior
                    </Badge>
                  )}
                </div>
                {category.basisBreakdown.length ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {category.basisBreakdown.map((basis) => (
                      <Badge key={basis.basis} variant="outline">
                        {formatBasis(basis.basis)} {formatUsd(basis.amountUsd)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily attributed cost</CardTitle>
          <p className="text-muted-foreground text-sm">
            Stacked by cost category. This is operating cost, not a Kestrel invoice.
          </p>
        </CardHeader>
        <CardContent>
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
            <div className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
              {snapshot.sourceFreshness.map((source) => (
                <div className="text-xs" key={source.source}>
                  <div className="font-medium">{source.source}</div>
                  <div className="text-muted-foreground">
                    Updated {formatDateTime(source.lastUpdatedAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organization activity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            <ActivityValue label="Runs" value={snapshot.activity.organization.runs} />
            <ActivityValue
              label="Completed"
              value={snapshot.activity.organization.completedRuns}
            />
            <ActivityValue
              label="Failed"
              value={snapshot.activity.organization.failedRuns}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Your activity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            <ActivityValue label="Runs" value={snapshot.activity.currentUser.runs} />
            <ActivityValue
              label="Model tokens"
              value={snapshot.activity.currentUser.modelTokens}
            />
            <ActivityValue
              label="Attributed cost"
              value={formatOptionalUsd(snapshot.activity.currentUser.attributedCostUsd)}
            />
          </CardContent>
        </Card>
      </div>

      {canManageActiveOrganization ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Team and project attribution</CardTitle>
              <p className="mt-1 text-muted-foreground text-sm">
                Admin-only detail for this period.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/organization/usage">
                Open explorer <ExternalLink className="ml-1 size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
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
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Pricing coverage</CardTitle>
            <Badge variant={snapshot.pricingCoverage.complete ? "secondary" : "outline"}>
              {snapshot.pricingCoverage.pricedMeters} of {snapshot.pricingCoverage.activeMeters}{" "}
              active meters priced
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {snapshot.pricingCoverage.unpricedServices.length ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">
                These providers have usage but no applicable rate. Missing dollars are
                not estimated, and period deltas are suppressed.
              </p>
              <div className="flex flex-wrap gap-2">
                {snapshot.pricingCoverage.unpricedServices.map((item) => (
                  <Badge key={`${item.provider}/${item.service}/${item.meter}`} variant="outline">
                    {item.provider} · {item.service} · {item.meter} ({item.eventCount})
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              All active meters in this period have a price. Calculated amounts may
              still exclude credits, taxes, discounts, or invoice adjustments.
            </p>
          )}
        </CardContent>
      </Card>
    </AppPage>
  );
}

function HeadlineMetric({ icon: Icon, label, value }: { icon: typeof Bot; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between gap-3 text-muted-foreground text-sm">
          <span>{label}</span>
          <Icon className="size-4" />
        </div>
        <div className="mt-2 font-semibold text-3xl tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function ActivityValue({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-semibold text-xl tabular-nums">
        {typeof value === "number" ? formatCompact(value) : value}
      </div>
    </div>
  );
}

function AttributionList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; name: string; runs: number; amount: number | null }>;
}) {
  return (
    <div>
      <h3 className="mb-2 font-medium text-sm">{title}</h3>
      <div className="divide-y rounded-md border">
        {rows.slice(0, 8).map((row) => (
          <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm" key={row.id}>
            <div className="min-w-0">
              <div className="truncate font-medium">{row.name}</div>
              <div className="text-muted-foreground text-xs">{formatNumber(row.runs)} runs</div>
            </div>
            <div className="font-mono tabular-nums">{formatOptionalUsd(row.amount)}</div>
          </div>
        ))}
        {rows.length === 0 ? (
          <div className="px-3 py-5 text-center text-muted-foreground text-sm">No activity</div>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="flex h-[220px] items-center justify-center text-muted-foreground text-sm">{message}</div>;
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
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
