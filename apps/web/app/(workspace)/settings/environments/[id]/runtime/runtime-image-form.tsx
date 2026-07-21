"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RuntimeImageForm({
  environmentId,
  initialRuntimeImage,
}: {
  environmentId: string;
  initialRuntimeImage: string;
}) {
  const [runtimeImage, setRuntimeImage] = useState(initialRuntimeImage);
  const [savedRuntimeImage, setSavedRuntimeImage] =
    useState(initialRuntimeImage);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/environments/${environmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeImage: runtimeImage.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Runtime update failed.");
      }
      setSavedRuntimeImage(runtimeImage.trim());
      toast.success("Runtime update and Workspace rebuilds queued.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Runtime update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        aria-label="Runtime image"
        onChange={(event) => setRuntimeImage(event.target.value)}
        placeholder="registry.fly.io/kestrel-workspace@sha256:…"
        value={runtimeImage}
      />
      <Button
        disabled={
          busy || !runtimeImage.trim() || runtimeImage.trim() === savedRuntimeImage
        }
        onClick={() => void save()}
        variant="outline"
      >
        {busy ? "Saving…" : "Update"}
      </Button>
    </div>
  );
}
