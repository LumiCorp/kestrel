"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { readJson } from "@/components/admin/admin-client-utils";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimeText } from "@/components/ui/time-text";

type AdminEvent = {
  id: string;
  level: string;
  category: string;
  action: string;
  message: string;
  createdAt: string;
};

type LogStats = {
  totalCount: number;
  oldestLog: string | null;
  newestLog: string | null;
  levelBreakdown: Array<{ level: string; count: number }>;
  dailyVolume: Array<{ day: string; count: number }>;
};

export function LogsAdminClient({
  initialEvents,
  initialStats,
}: {
  initialEvents: AdminEvent[];
  initialStats: LogStats;
}) {
  const router = useRouter();
  const [stats, setStats] = useState<LogStats | null>(initialStats);
  const [events, setEvents] = useState(initialEvents);
  const [before, setBefore] = useState("");
  const [level, setLevel] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function loadStats() {
    setStatus("Loading log stats...");
    const response = await fetch("/api/admin/logs/stats", {
      cache: "no-store",
    });
    const json = await readJson<LogStats | { error?: string }>(response);
    if (!(response.ok && "levelBreakdown" in json)) {
      setStatus(
        "error" in json
          ? json.error || "Failed to load logs"
          : "Failed to load logs"
      );
      return;
    }
    setStats(json);
    setStatus("");
  }

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    setStats(initialStats);
  }, [initialStats]);

  const levelSummary = useMemo(
    () =>
      new Map(
        (stats?.levelBreakdown ?? []).map((entry) => [entry.level, entry.count])
      ),
    [stats]
  );

  async function previewDelete() {
    if (!before) {
      toast.error("Choose a cutoff date first.");
      return;
    }
    setBusy(true);
    const query = new URLSearchParams({
      before: new Date(before).toISOString(),
    });
    if (level) {
      query.set("level", level);
    }
    const response = await fetch(`/api/admin/logs/count?${query.toString()}`);
    const json = await readJson<{ count?: number; error?: string }>(response);
    setBusy(false);
    if (!response.ok) {
      toast.error(json.error || "Failed to count log rows");
      return;
    }
    setPreviewCount(json.count ?? 0);
  }

  async function deleteLogs() {
    if (!before) {
      toast.error("Choose a cutoff date first.");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/admin/logs", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        before: new Date(before).toISOString(),
        level: level || undefined,
      }),
    });
    const json = await readJson<{ deletedCount?: number; error?: string }>(
      response
    );
    setBusy(false);
    if (!response.ok) {
      toast.error(json.error || "Failed to delete logs");
      return;
    }
    toast.success(`Deleted ${json.deletedCount ?? 0} log row(s).`);
    const cutoff = new Date(before).getTime();
    setEvents((current) =>
      current.filter((event) => {
        const isBeforeCutoff = new Date(event.createdAt).getTime() < cutoff;
        const levelMatches = !level || event.level === level;
        return !(isBeforeCutoff && levelMatches);
      })
    );
    setPreviewCount(null);
    await loadStats();
    router.refresh();
  }

  async function investigateInAdminChat() {
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: chatId,
        mode: "admin",
        message: {
          id: messageId,
          role: "user",
          parts: [
            {
              type: "text",
              text: "Investigate the latest admin logs and summarize the highest-risk operational issues.",
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const json = await readJson<{ error?: string }>(response);
      toast.error(json.error || "Failed to create admin chat");
      return;
    }

    router.push(`/chat/${chatId}`);
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <Button
            onClick={() => void investigateInAdminChat()}
            variant="outline"
          >
            Investigate In Admin Chat
          </Button>
        }
        description="Track structured admin activity, inspect error-level events, and prune old audit rows safely."
        eyebrow="Audit"
        title="Logs"
      />

      {status ? (
        <div className="text-muted-foreground text-sm">{status}</div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <AdminStatCard title="Total Logs" value={stats?.totalCount ?? 0} />
        <AdminStatCard title="Warnings" value={levelSummary.get("warn") ?? 0} />
        <AdminStatCard title="Errors" value={levelSummary.get("error") ?? 0} />
      </div>

      <div className="border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_180px_auto_auto]">
          <Input
            onChange={(event) => setBefore(event.target.value)}
            type="datetime-local"
            value={before}
          />
          <Select
            onValueChange={(value) => setLevel(value === "all" ? "" : value)}
            value={level || "all"}
          >
            <SelectTrigger>
              <SelectValue placeholder="All levels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={busy}
            onClick={() => void previewDelete()}
            variant="outline"
          >
            Preview Delete
          </Button>
          <Button
            disabled={busy}
            onClick={() => void deleteLogs()}
            variant="destructive"
          >
            Delete Matching Logs
          </Button>
        </div>
        <div className="mt-3 text-muted-foreground text-sm">
          {previewCount === null
            ? "Choose a cutoff date to preview affected log rows."
            : `${previewCount} log row(s) will be removed by the current filter.`}
        </div>
      </div>

      <AdminDataTable
        columns={[
          { key: "event", label: "Event" },
          { key: "category", label: "Category" },
          { key: "time", label: "Time" },
        ]}
        empty={
          <AdminEmptyState
            description="No admin events have been recorded for this organization yet."
            title="No audit activity"
          />
        }
        rows={events.map((event) => ({
          event: (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{event.level}</Badge>
                <span className="font-medium text-sm">{event.message}</span>
              </div>
              <div className="text-muted-foreground text-sm">
                {event.action}
              </div>
            </div>
          ),
          category: <span className="text-sm">{event.category}</span>,
          time: (
            <span className="text-muted-foreground text-sm">
              <TimeText mode="relative" value={event.createdAt} />
            </span>
          ),
        }))}
      />
    </div>
  );
}
