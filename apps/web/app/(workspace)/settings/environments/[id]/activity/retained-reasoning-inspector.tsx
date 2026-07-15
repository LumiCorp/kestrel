"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Entry = {
  provider: string;
  model: string;
  format: string;
  text: string;
  createdAt: string;
  expiresAt: string;
};

export function RetainedReasoningInspector({ runId }: { runId: string }) {
  const [entries, setEntries] = useState<Entry[]>();
  const [status, setStatus] = useState<string>();

  async function read() {
    setStatus("Loading…");
    const response = await fetch(`/api/admin/runs/${runId}/reasoning`, { cache: "no-store" });
    const payload = await response.json() as { entries?: Entry[]; error?: string };
    if (!response.ok) {
      setStatus(payload.error ?? "Retained reasoning is unavailable.");
      return;
    }
    setEntries(payload.entries ?? []);
    setStatus(undefined);
  }

  async function remove() {
    const response = await fetch(`/api/admin/runs/${runId}/reasoning`, { method: "DELETE" });
    if (!response.ok) {
      setStatus("Could not delete retained reasoning.");
      return;
    }
    setEntries([]);
    setStatus("Retained reasoning deleted.");
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" type="button" onClick={read}>Inspect retained reasoning</Button>
        {entries && entries.length > 0 ? (
          <Button size="sm" variant="destructive" type="button" onClick={remove}>Delete retained reasoning</Button>
        ) : null}
      </div>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      {entries?.map((entry, index) => (
        <div className="rounded-md border bg-muted/30 p-3 text-sm" key={`${entry.createdAt}-${index}`}>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {formatLabel(entry.format)} · {entry.provider}/{entry.model}
          </div>
          <div className="whitespace-pre-wrap">{entry.text}</div>
          <div className="mt-2 text-xs text-muted-foreground">Expires {new Date(entry.expiresAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function formatLabel(format: string) {
  if (format === "summary") return "Provider reasoning summary";
  if (format === "provider_thinking") return "Provider-visible thinking";
  return "Provider reasoning";
}
