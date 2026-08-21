"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function EnvironmentReconcileAction({ environmentId }: { environmentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function reconcile() {
    setBusy(true);
    try {
      const response = await fetch(`/api/organization/environments/${environmentId}/reconcile`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Reconciliation could not be queued.");
      toast.success("Environment reconciliation queued.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reconciliation could not be queued.");
    } finally {
      setBusy(false);
    }
  }
  return <Button disabled={busy} onClick={() => void reconcile()} size="sm" variant="outline">{busy ? "Queueing…" : "Reconcile now"}</Button>;
}
