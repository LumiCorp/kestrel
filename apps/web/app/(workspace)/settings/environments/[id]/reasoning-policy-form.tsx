"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RequestMode = "off" | "summary" | "provider_visible";
type Effort = "low" | "medium" | "high";
type RetentionMode = "live_only" | "provider_visible";

export function ReasoningPolicyForm(props: {
  environmentId: string;
  initial: {
    requestMode: RequestMode;
    effort?: Effort | undefined;
    retentionMode: RetentionMode;
    retentionDays: number;
  };
}) {
  const [requestMode, setRequestMode] = useState(props.initial.requestMode);
  const [effort, setEffort] = useState<Effort | "">(props.initial.effort ?? "");
  const [retentionMode, setRetentionMode] = useState(props.initial.retentionMode);
  const [retentionDays, setRetentionDays] = useState(props.initial.retentionDays);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus(undefined);
    try {
      const response = await fetch(`/api/admin/environments/${props.environmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reasoning: {
            request: { mode: requestMode, ...(effort ? { effort } : {}) },
            retention: { mode: retentionMode, days: retentionDays },
          },
        }),
      });
      if (!response.ok) throw new Error("Could not update the reasoning policy.");
      setStatus("Reasoning policy saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the reasoning policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="reasoning-request-mode">Provider reasoning shown live</Label>
        <select
          id="reasoning-request-mode"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={requestMode}
          onChange={(event) => setRequestMode(event.target.value as RequestMode)}
        >
          <option value="off">Off</option>
          <option value="summary">Provider-returned summary</option>
          <option value="provider_visible">Provider-visible thinking or reasoning</option>
        </select>
        <p className="text-muted-foreground text-xs">
          The format is labeled in the run UI. Kestrel never claims or exposes unavailable raw reasoning.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reasoning-effort">Reasoning effort</Label>
        <select
          id="reasoning-effort"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={effort}
          onChange={(event) => setEffort(event.target.value as Effort | "")}
        >
          <option value="">Provider default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reasoning-retention-mode">Provider-visible reasoning retention</Label>
        <select
          id="reasoning-retention-mode"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={retentionMode}
          onChange={(event) => setRetentionMode(event.target.value as RetentionMode)}
        >
          <option value="live_only">Live only (recommended)</option>
          <option value="provider_visible">Retain encrypted provider-visible content</option>
        </select>
        <p className="text-muted-foreground text-xs">
          Encrypted provider continuation state is never rendered or included in retained content. Retained content is available only to organization administrators through run inspection.
          Hosted runtime activation fails closed unless the runtime advertises a valid reasoning encryption key.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reasoning-retention-days">Retention period (1–30 days)</Label>
        <Input
          id="reasoning-retention-days"
          type="number"
          min={1}
          max={30}
          value={retentionDays}
          disabled={retentionMode === "live_only"}
          onChange={(event) => setRetentionDays(Number(event.target.value))}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" disabled={saving || retentionDays < 1 || retentionDays > 30} onClick={save}>
          {saving ? "Saving…" : "Save reasoning policy"}
        </Button>
        {status ? <span className="text-muted-foreground text-sm">{status}</span> : null}
      </div>
    </div>
  );
}
