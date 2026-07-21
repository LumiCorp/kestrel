"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function EnvironmentOverviewActions({
  environmentId,
  initialIsDefault,
}: {
  environmentId: string;
  initialIsDefault: boolean;
}) {
  const [isDefault, setIsDefault] = useState(initialIsDefault);
  const [busy, setBusy] = useState(false);

  async function makeDefault() {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/environments/${environmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Default Environment update failed.");
      }
      setIsDefault(true);
      toast.success("Default Environment updated.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Default Environment update failed."
      );
    } finally {
      setBusy(false);
    }
  }

  return isDefault ? (
    <Badge>Default</Badge>
  ) : (
    <Button disabled={busy} onClick={() => void makeDefault()} size="sm" variant="outline">
      {busy ? "Updating…" : "Make default"}
    </Button>
  );
}
