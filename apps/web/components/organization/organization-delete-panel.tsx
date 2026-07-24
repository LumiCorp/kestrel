"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function OrganizationDeletePanel({
  organizationName,
  operation,
}: {
  organizationName: string;
  operation: {
    status: string;
    stage: string;
    errorMessage: string | null;
    inventory: Record<string, unknown> | null;
  } | null;
}) {
  const router = useRouter();
  const [confirmationName, setConfirmationName] = useState("");
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationName }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ?? "Organization deletion could not start.",
        );
      toast.success(
        "Organization teardown requested. You will be returned to your Personal workspace when it completes.",
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Organization deletion could not start.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/deletion", {
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ?? "Organization deletion retry failed.",
        );
      toast.success("Organization teardown retry requested.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Organization deletion retry failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (operation) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/40 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Deletion operation</p>
            <p className="text-muted-foreground text-sm">{operation.stage}</p>
          </div>
          <Badge
            variant={operation.status === "failed" ? "destructive" : "outline"}
          >
            {operation.status}
          </Badge>
        </div>
        {operation.errorMessage ? (
          <p className="text-destructive text-sm">{operation.errorMessage}</p>
        ) : null}
        {operation.inventory ? (
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
            {JSON.stringify(operation.inventory, null, 2)}
          </pre>
        ) : null}
        {operation.status === "failed" ? (
          <Button
            disabled={busy}
            onClick={() => void retry()}
            variant="outline"
          >
            {busy ? "Retrying…" : "Retry teardown"}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-lg border border-destructive/40 p-5">
      <div>
        <h2 className="font-semibold text-lg">Delete organization</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          This permanently removes every Environment, its Workspace machines and
          volumes, managed compute, and organization data. Cancel any paid
          subscription in Billing before continuing.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="organization-delete-confirmation">
          Type {organizationName} to confirm
        </Label>
        <Input
          id="organization-delete-confirmation"
          onChange={(event) => setConfirmationName(event.target.value)}
          value={confirmationName}
        />
      </div>
      <Button
        disabled={busy || confirmationName !== organizationName}
        onClick={() => void remove()}
        variant="destructive"
      >
        {busy ? "Requesting…" : "Delete organization"}
      </Button>
    </div>
  );
}
