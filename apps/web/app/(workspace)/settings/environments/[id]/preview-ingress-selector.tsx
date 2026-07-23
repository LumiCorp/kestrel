"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Provider = "ngrok" | "kestrel_edge";

export function PreviewIngressSelector(input: {
  environmentId: string;
  initialProvider: Provider;
}) {
  const [provider, setProvider] = useState<Provider>(input.initialProvider);
  const [busy, setBusy] = useState(false);
  async function change(next: Provider) {
    const previous = provider;
    setProvider(next);
    setBusy(true);
    try {
      const response = await fetch(`/api/organization/environments/${input.environmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewIngressProvider: next }),
      });
      if (!response.ok) throw new Error("Preview ingress update failed.");
      toast.success(`${next === "kestrel_edge" ? "Kestrel Edge" : "ngrok"} will be used for new previews.`);
    } catch (error) {
      setProvider(previous);
      toast.error(error instanceof Error ? error.message : "Preview ingress update failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Select disabled={busy} onValueChange={(value) => void change(value as Provider)} value={provider}>
      <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="ngrok">ngrok (legacy)</SelectItem>
        <SelectItem value="kestrel_edge">Kestrel Edge</SelectItem>
      </SelectContent>
    </Select>
  );
}
