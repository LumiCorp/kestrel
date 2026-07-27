"use client";

import { CheckCircle2, Monitor, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DesktopEnrollmentApproval(props: {
  requestId: string;
  desktopName: string;
  fingerprint: string;
}) {
  const [name, setName] = useState(props.desktopName);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string>();

  async function approve() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/organization/desktop-enrollments/${props.requestId}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ desktopName: name }),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Desktop approval failed.");
      }
      setApproved(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Desktop approval failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (approved) {
    return (
      <div className="mx-auto max-w-lg space-y-5 rounded-xl border bg-card p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
        <div>
          <h1 className="font-semibold text-2xl">Desktop Environment approved</h1>
          <p className="mt-2 text-muted-foreground">
            You can return to Kestrel Desktop. It will connect automatically and
            begin synchronizing its registered projects.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 rounded-xl border bg-card p-8 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-muted p-3">
          <Monitor className="size-6" />
        </div>
        <div>
          <h1 className="font-semibold text-2xl">Approve Desktop Environment</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            This is a one-time organization approval. Project members will not
            be asked for approval each time they run work here.
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="desktop-enrollment-name">Environment name</Label>
        <Input
          id="desktop-enrollment-name"
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
      <div className="rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-2 font-medium text-sm">
          <ShieldCheck className="size-4" /> Identity fingerprint
        </div>
        <code className="mt-2 block break-all text-xs">
          {props.fingerprint}
        </code>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Button
        className="w-full"
        disabled={busy || !name.trim()}
        onClick={() => void approve()}
      >
        {busy ? "Approving…" : "Approve Desktop Environment"}
      </Button>
    </div>
  );
}
