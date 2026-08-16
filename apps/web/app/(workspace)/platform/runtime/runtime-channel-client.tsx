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
  desiredOperation,
}: {
  channel: {
    generation: number;
    canaryEnvironmentId: string | null;
    currentVersion: Version | null;
    previousVersion: Version | null;
    desiredVersion: Version | null;
  };
  canaries: Array<{
    id: string;
    name: string;
    organizationName: string;
    status: string;
  }>;
  desiredOperation: {
    id: string;
    status: string;
    stage: string;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(channel.canaryEnvironmentId ?? "");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  async function saveCanary() {
    if (!selected) return;
    await mutateChannel(
      "set-canary",
      { action: "set-canary", environmentId: selected },
      "Production canary updated.",
    );
  }
  async function mutateChannel(
    action: string,
    body: Record<string, string>,
    success: string,
  ) {
    setPendingAction(action);
    try {
      const response = await fetch("/api/admin/runtime-channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "Canary selection failed.");
      }
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Canary selection failed.");
    } finally {
      setPendingAction(null);
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
        <SettingsRow label="Desired version">
          <DigestPair version={channel.desiredVersion} />
        </SettingsRow>
        <SettingsRow label="Desired operation">
          {desiredOperation ? (
            <div className="space-y-1 text-xs">
              <div className="font-mono">{desiredOperation.id}</div>
              <div>
                {desiredOperation.status} / {desiredOperation.stage}
              </div>
              {desiredOperation.errorMessage ? (
                <div className="text-destructive">
                  {desiredOperation.errorCode
                    ? `${desiredOperation.errorCode}: `
                    : ""}
                  {desiredOperation.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <span>No canary operation</span>
          )}
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
              disabled={!selected || pendingAction !== null}
              onClick={() => void saveCanary()}
              type="button"
            >
              {pendingAction === "set-canary" ? "Saving…" : "Save"}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label="Recovery">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!channel.desiredVersion || pendingAction !== null}
              onClick={() =>
                void mutateChannel(
                  "retry-desired",
                  { action: "retry-desired" },
                  "Desired runtime retry queued.",
                )
              }
              type="button"
              variant="outline"
            >
              {pendingAction === "retry-desired" ? "Retrying…" : "Retry desired"}
            </Button>
            <Button
              disabled={!channel.previousVersion || pendingAction !== null}
              onClick={() =>
                void mutateChannel(
                  "select-previous",
                  { action: "select-previous" },
                  "Previous runtime selected for canary.",
                )
              }
              type="button"
              variant="outline"
            >
              {pendingAction === "select-previous"
                ? "Selecting…"
                : "Canary previous version"}
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
