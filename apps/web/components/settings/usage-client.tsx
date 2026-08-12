"use client";

import { useState } from "react";
import {
  SettingsDisclosure,
  SettingsMetric,
  SettingsMetricStrip,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  CostVisibility,
  OrganizationDashboardSnapshot,
} from "@/lib/costs/contracts";

type RateRow = {
  id: string;
  organizationId: string | null;
  category: "models" | "environments" | "managed_compute" | "services";
  provider: string;
  service: string;
  meter: string;
  unit: string;
  rateKind: "unit" | "monthly" | "annual";
  unitPriceUsd: string;
  provenance: "published" | "contract" | "assumption";
  sourceUrl: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export function CostsUsageAdminClient({
  initialSnapshot,
  initialRates,
}: {
  initialSnapshot: OrganizationDashboardSnapshot;
  initialRates: RateRow[];
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [rates, setRates] = useState(initialRates);
  const [visibility, setVisibility] = useState<CostVisibility>(
    initialSnapshot.costVisibility
  );
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveVisibility(checked: boolean) {
    const next = checked ? "admins_only" : "all_members";
    setSaving(true);
    setStatus("");
    const response = await fetch("/api/organization/costs/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ costVisibility: next }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setVisibility(body.costVisibility);
      setStatus("Cost visibility updated.");
    } else setStatus(body.error ?? "Unable to save cost visibility.");
    setSaving(false);
  }

  async function refreshSnapshot(range = "mtd") {
    setStatus("Refreshing costs…");
    const response = await fetch(`/api/organization/costs?range=${range}`, {
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setSnapshot(body);
      setStatus("");
    } else setStatus(body.error ?? "Unable to refresh costs.");
  }

  async function createRate(formData: FormData) {
    setSaving(true);
    setStatus("");
    const response = await fetch("/api/organization/costs/rates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: formData.get("category"),
        provider: formData.get("provider"),
        service: formData.get("service"),
        meter: formData.get("meter"),
        unit: formData.get("unit"),
        rateKind: formData.get("rateKind"),
        unitPriceUsd: formData.get("unitPriceUsd"),
        provenance: formData.get("provenance"),
        sourceUrl: formData.get("sourceUrl") || undefined,
        effectiveFrom: formData.get("effectiveFrom"),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const refreshed = await fetch("/api/organization/costs/rates", {
        cache: "no-store",
      });
      const refreshedBody = await refreshed.json();
      setRates(refreshedBody.rates);
      setStatus("Rate override created and matching usage repriced.");
      await refreshSnapshot();
    } else setStatus(body.error ?? "Unable to create rate override.");
    setSaving(false);
  }

  async function endRate(id: string) {
    setSaving(true);
    setStatus("");
    const response = await fetch("/api/organization/costs/rates", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, effectiveTo: new Date().toISOString() }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setRates((current) =>
        current.map((rate) =>
          rate.id === id
            ? { ...rate, effectiveTo: body.rate.effectiveTo }
            : rate
        )
      );
      setStatus("Rate override ended. Historical entries remain unchanged.");
      await refreshSnapshot();
    } else {
      setStatus(body.error ?? "Unable to end rate override.");
    }
    setSaving(false);
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Inspect attributed operating cost, manage visibility, and maintain organization-specific rate assumptions."
        eyebrow="Organization"
        title="Costs & usage"
      />

      {status ? <SettingsStatusNotice title={status} /> : null}

      <SettingsSection
        description="Choose the reporting period without changing the underlying attribution."
        title="Reporting period"
      >
        <div className="flex flex-wrap gap-2">
          {(["mtd", "7d", "30d", "90d"] as const).map((range) => (
            <Button
              key={range}
              onClick={() => void refreshSnapshot(range)}
              size="sm"
              variant={snapshot.period.range === range ? "default" : "outline"}
            >
              {range === "mtd" ? "Month to date" : range}
            </Button>
          ))}
        </div>
      </SettingsSection>

      <SettingsMetricStrip>
        <SettingsMetric
          label="Attributed cost"
          value={formatUsd(snapshot.totals.amountUsd ?? 0)}
        />
        <SettingsMetric label="Runs" value={formatNumber(snapshot.totals.runs)} />
        <SettingsMetric
          label="Failed"
          value={formatNumber(snapshot.totals.failedRuns)}
        />
        <SettingsMetric
          label="Active members"
          value={formatNumber(snapshot.totals.activeMembers)}
        />
      </SettingsMetricStrip>

      <SettingsSection
        description="All members see organization dollar totals by default. Turn this on to remove all amounts, deltas, and cost breakdowns from member responses."
        title="Cost visibility"
      >
        <div className="flex items-center justify-between gap-6 border-y py-4">
          <div>
            <div className="font-medium text-sm">Restrict dollars to owners and admins</div>
            <div className="mt-1 text-muted-foreground text-xs">
              Members still see tokens, runs, service counts, and their own activity.
            </div>
          </div>
          <Switch
            checked={visibility === "admins_only"}
            disabled={saving}
            onCheckedChange={(checked) => void saveVisibility(checked)}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        description="Organization totals and admin-only attribution for the selected period."
        title="Attribution"
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <AttributionTable
            rows={snapshot.people.map((row) => ({
              id: row.userId,
              label: row.name,
              runs: row.runs,
              amount: row.attributedCostUsd,
            }))}
            title="Members"
          />
          <AttributionTable
            rows={snapshot.projects.map((row) => ({
              id: row.projectId,
              label: row.name,
              runs: row.runs,
              amount: row.attributedCostUsd,
            }))}
            title="Projects"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        description="Attributed totals by operating category."
        title="Categories"
      >
        <SettingsRows>
          {snapshot.categories.map((category) => (
            <SettingsRow
              key={category.category}
              label={category.category.replace("_", " ")}
            >
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="font-medium tabular-nums">
                  {formatUsd(category.amountUsd ?? 0)}
                </span>
                <span className="text-muted-foreground">
                  {formatNumber(category.usageQuantity)} {category.usageUnit}
                </span>
              </div>
            </SettingsRow>
          ))}
        </SettingsRows>
      </SettingsSection>

      <SettingsDisclosure
        description="Pricing coverage, versioned rate cards, and organization overrides."
        title="Advanced pricing"
      >
        <div className="space-y-8">
          <div>
            <h3 className="font-medium text-sm">Pricing coverage</h3>
            <p className="mt-1 text-muted-foreground text-xs/5">
              {snapshot.pricingCoverage.pricedMeters} of{" "}
              {snapshot.pricingCoverage.activeMeters} active meters are priced.
              Unknown dollars are never estimated.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {snapshot.pricingCoverage.unpricedServices.map((item) => (
                <Badge
                  key={`${item.provider}/${item.service}/${item.meter}`}
                  variant="outline"
                >
                  {item.provider} · {item.service} · {item.meter} (
                  {item.eventCount})
                </Badge>
              ))}
              {snapshot.pricingCoverage.unpricedServices.length === 0 ? (
                <span className="text-muted-foreground text-sm">
                  No unpriced active providers.
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <h3 className="font-medium text-sm">Rate cards</h3>
            <div className="mt-3 divide-y border-y">
              {rates.map((rate) => (
                <div
                  className="grid gap-2 py-3 text-sm md:grid-cols-[1fr_1fr_auto_auto]"
                  key={rate.id}
                >
                  <div>
                    <div className="font-medium">
                      {rate.provider} · {rate.service}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {rate.meter} / {rate.unit}
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {rate.organizationId
                      ? "Organization override"
                      : "Platform default"}{" "}
                    · {rate.provenance}
                    <br />
                    {rate.effectiveTo
                      ? `Ended ${new Date(rate.effectiveTo).toLocaleDateString()}`
                      : new Date(rate.effectiveFrom) > new Date()
                        ? `Scheduled ${new Date(rate.effectiveFrom).toLocaleDateString()}`
                        : `Active since ${new Date(rate.effectiveFrom).toLocaleDateString()}`}
                  </div>
                  <div className="font-mono tabular-nums">
                    {formatUsd(Number(rate.unitPriceUsd))}/
                    {rate.rateKind === "unit" ? rate.unit : rate.rateKind}
                  </div>
                  {rate.organizationId && !rate.effectiveTo ? (
                    <Button
                      disabled={saving}
                      onClick={() => void endRate(rate.id)}
                      size="sm"
                      variant="ghost"
                    >
                      End rate
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="font-medium text-sm">Create rate override</h3>
            <p className="mt-1 text-muted-foreground text-xs/5">
              Add a contract or explicit assumption for an unpriced provider.
              New effective versions never rewrite history.
            </p>
          <form action={createRate} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <select className="h-9 rounded-md border bg-transparent px-3 text-sm" defaultValue="services" name="category">
              <option value="models">Models</option>
              <option value="environments">Environments</option>
              <option value="managed_compute">Managed compute</option>
              <option value="services">Services</option>
            </select>
            <Input name="provider" placeholder="Provider (for example tavily)" required />
            <Input name="service" placeholder="Service" required />
            <Input name="meter" placeholder="Meter (for example search)" required />
            <Input name="unit" placeholder="Unit (for example request)" required />
            <Input min="0" name="unitPriceUsd" placeholder="USD rate" required step="any" type="number" />
            <select className="h-9 rounded-md border bg-transparent px-3 text-sm" defaultValue="unit" name="rateKind">
              <option value="unit">Per unit</option>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
            <select className="h-9 rounded-md border bg-transparent px-3 text-sm" defaultValue="contract" name="provenance">
              <option value="contract">Contract</option>
              <option value="assumption">Assumption</option>
            </select>
            <Input defaultValue={new Date().toISOString().slice(0, 10)} name="effectiveFrom" required type="date" />
            <Input className="xl:col-span-3" name="sourceUrl" placeholder="Provenance URL (optional)" type="url" />
            <Button disabled={saving} type="submit">Create override</Button>
          </form>
          </div>
        </div>
      </SettingsDisclosure>
    </SettingsPage>
  );
}

function AttributionTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; label: string; runs: number; amount: number | null }>;
}) {
  return (
    <div>
      <h3 className="mb-2 font-medium text-sm">{title}</h3>
      <div className="divide-y rounded-lg border">
        {rows.map((row) => (
          <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm" key={row.id}>
            <div>
              <div className="font-medium">{row.label}</div>
              <div className="text-muted-foreground text-xs">{formatNumber(row.runs)} runs</div>
            </div>
            <div className="font-mono">{formatUsd(row.amount ?? 0)}</div>
          </div>
        ))}
        {rows.length === 0 ? <div className="p-4 text-center text-muted-foreground text-sm">No activity</div> : null}
      </div>
    </div>
  );
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
