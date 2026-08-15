"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";

type Version = {
  id: string;
  runtimeImage: string;
  routerImage: string;
};

export function RuntimeChannelClient({
  channel,
  canaries,
}: {
  channel: {
    generation: number;
    canaryEnvironmentId: string | null;
    currentVersion: Version | null;
    previousVersion: Version | null;
  };
  canaries: Array<{
    id: string;
    name: string;
    organizationName: string;
    status: string;
  }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(channel.canaryEnvironmentId ?? "");
  const [pending, setPending] = useState(false);
  async function saveCanary() {
    if (!selected) return;
    setPending(true);
    try {
      const response = await fetch("/api/admin/runtime-channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: selected }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "Canary selection failed.");
      }
      toast.success("Production canary updated.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Canary selection failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsSection
      description="Pointer promotion changes the default for new Environments; it never updates the fleet."
      title="Production channel"
    >
      <SettingsRows>
        <SettingsRow label="Generation">{channel.generation}</SettingsRow>
        <SettingsRow label="Current version">
          <DigestPair version={channel.currentVersion} />
        </SettingsRow>
        <SettingsRow label="Previous version">
          <DigestPair version={channel.previousVersion} />
        </SettingsRow>
        <SettingsRow label="Canary Environment">
          <div className="flex w-full max-w-xl gap-2">
            <select
              aria-label="Production canary Environment"
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
              onChange={(event) => setSelected(event.target.value)}
              value={selected}
            >
              <option value="">Select a canary</option>
              {canaries.map((canary) => (
                <option key={canary.id} value={canary.id}>
                  {canary.organizationName} / {canary.name} ({canary.status})
                </option>
              ))}
            </select>
            <Button
              disabled={!selected || pending}
              onClick={() => void saveCanary()}
              type="button"
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}

function DigestPair({ version }: { version: Version | null }) {
  if (!version) return <span>No version selected</span>;
  return (
    <div className="space-y-1 font-mono text-xs">
      <div>{version.id}</div>
      <div className="break-all">Workspace: {version.runtimeImage}</div>
      <div className="break-all">Router: {version.routerImage}</div>
    </div>
  );
}
