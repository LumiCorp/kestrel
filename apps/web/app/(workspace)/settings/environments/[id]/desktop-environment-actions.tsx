"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function DesktopEnvironmentActions({
  environmentId,
  revoked,
}: {
  environmentId: string;
  revoked: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/desktop`,
        { method: "DELETE" },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Desktop Environment could not be revoked.");
      }
      toast.success(
        "Desktop Environment revoked. Local files and credentials were not changed.",
      );
      window.location.reload();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Desktop Environment could not be revoked.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      disabled={busy || revoked}
      onClick={() => void disconnect()}
      variant="destructive"
    >
      {revoked ? "Disconnected" : busy ? "Disconnecting…" : "Revoke Environment"}
    </Button>
  );
}
