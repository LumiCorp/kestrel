"use client";

import { useEffect, useState } from "react";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsMetric,
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
  SettingsPanelTitle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StatsResponse = {
  days: number;
  totalMessages: number;
  previousMessages: number;
  totals: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
  };
  bySource: Array<{
    source: string;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }>;
  availableSources: string[];
  availableModels: string[];
};

export function StatsAdminClient() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState("Loading stats...");
  const [sourceFilter, setSourceFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  async function load(days = 30) {
    setStatus("Loading stats...");
    const search = new URLSearchParams({ days: String(days) });
    if (sourceFilter) {
      search.set("sources", sourceFilter);
    }
    if (modelFilter) {
      search.set("models", modelFilter);
    }
    const response = await fetch(`/api/stats?${search.toString()}`, {
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus(json.error || "Failed to load stats");
      return;
    }
    setStats(json);
    setStatus("");
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Review org-scoped usage totals, token consumption, and source/model activity."
        eyebrow="Usage"
        title="Usage"
      />

      <div className="grid gap-3 border-border/70 border-y py-4 md:grid-cols-2">
        <Input
          onChange={(event) => setSourceFilter(event.target.value)}
          placeholder="Filter sources (comma-separated)"
          value={sourceFilter}
        />
        <Input
          onChange={(event) => setModelFilter(event.target.value)}
          placeholder="Filter models (comma-separated)"
          value={modelFilter}
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={() => void load(7)} size="sm" variant="outline">
          7 days
        </Button>
        <Button onClick={() => void load(30)} size="sm" variant="outline">
          30 days
        </Button>
        <Button onClick={() => void load(90)} size="sm" variant="outline">
          90 days
        </Button>
      </div>

      {status ? (
        <div className="text-muted-foreground text-sm">{status}</div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <SettingsMetric
          label="Total messages"
          value={stats?.totalMessages ?? 0}
        />
        <SettingsMetric
          label="Previous window"
          value={stats?.previousMessages ?? 0}
        />
        <SettingsMetric
          label="Input tokens"
          value={stats?.totals.totalInputTokens ?? 0}
        />
        <SettingsMetric
          label="Output tokens"
          value={stats?.totals.totalOutputTokens ?? 0}
        />
      </div>

      <SettingsPanel>
        <SettingsPanelHeader>
          <SettingsPanelTitle>Usage events</SettingsPanelTitle>
        </SettingsPanelHeader>
        <SettingsPanelContent className="divide-y">
          {(stats?.bySource ?? []).map((row, index) => (
            <div
              className="py-3"
              key={`${row.source}-${index}`}
            >
              <div className="font-medium">{row.source}</div>
              <div className="text-muted-foreground text-sm">
                {row.model || "unknown model"} · input {row.inputTokens ?? 0} ·
                output {row.outputTokens ?? 0}
              </div>
            </div>
          ))}
        </SettingsPanelContent>
      </SettingsPanel>
    </SettingsPage>
  );
}
