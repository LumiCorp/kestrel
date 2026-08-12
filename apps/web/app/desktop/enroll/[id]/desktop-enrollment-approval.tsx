"use client";

import { Check, CheckCircle2, Copy, Monitor, ShieldCheck } from "lucide-react";
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
  const [showFingerprint, setShowFingerprint] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyFingerprint() {
    await navigator.clipboard.writeText(props.fingerprint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

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
      <div className="mx-auto max-w-lg space-y-5 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
        <div>
          <h1 className="font-semibold text-2xl">
            Desktop Environment approved
          </h1>
          <p className="mt-2 text-muted-foreground">
            You can return to Kestrel Desktop. It will connect automatically and
            begin synchronizing its registered projects.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-muted p-3">
          <Monitor className="size-6" />
        </div>
        <div>
          <h1 className="font-semibold text-2xl">
            Approve Desktop Environment
          </h1>
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
      <div className="border-y py-4">
        <div className="flex items-center gap-2 font-medium text-sm">
          <ShieldCheck className="size-4" /> Identity fingerprint
        </div>
        <code className="mt-2 block break-all text-xs">
          {showFingerprint
            ? props.fingerprint
            : `${props.fingerprint.slice(0, 12)}…${props.fingerprint.slice(-8)}`}
        </code>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() => setShowFingerprint((current) => !current)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {showFingerprint ? "Hide full" : "Show full"}
          </Button>
          <Button
            onClick={() => void copyFingerprint()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          onClick={() => window.history.back()}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => void approve()}>
          {busy ? "Approving…" : "Approve Desktop Environment"}
        </Button>
      </div>
    </div>
  );
}
