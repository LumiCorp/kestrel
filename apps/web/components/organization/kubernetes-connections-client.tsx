"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsRows,
  SettingsRow,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  KubernetesConnectionConfiguration,
  type KubernetesConnectionConfigurationValue,
} from "./kubernetes-connection-configuration";

type ConnectionSummary = {
  id: string;
  displayName: string;
  isDefault: boolean;
  status: string;
  supportStatus: string;
  presence: string;
  activeEnvironmentCount: number;
  revocationReady: boolean;
  connector: null | { version: string; compatible: boolean };
  configuration: null | {
    configured: boolean;
    frozen: boolean;
    value: KubernetesConnectionConfigurationValue;
  };
  qualification: null | { status: string; expiresAt: string };
  failure: null | { code: string | null; message: string | null };
};

export function KubernetesConnectionsClient() {
  const [enabled, setEnabled] = useState(false);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, connectionsResponse] = await Promise.all([
        fetch("/api/organization/infrastructure/kubernetes/settings", { cache: "no-store" }),
        fetch("/api/organization/infrastructure/kubernetes/connections", { cache: "no-store" }),
      ]);
      const settings = await settingsResponse.json();
      const list = await connectionsResponse.json();
      if (!(settingsResponse.ok && connectionsResponse.ok)) {
        throw new Error(settings.error ?? list.error ?? "Kubernetes connections could not be loaded.");
      }
      setEnabled(settings.organizationEnabled === true);
      setConnections(list.connections ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kubernetes connections could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function updateOptIn(next: boolean) {
    setBusy("settings");
    try {
      const response = await fetch("/api/organization/infrastructure/kubernetes/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Kubernetes BYOC setting could not be updated.");
      setEnabled(payload.organizationEnabled === true);
      toast.success(next ? "Kubernetes BYOC enabled." : "New Kubernetes BYOC admission disabled.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kubernetes BYOC setting could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  async function action(connectionId: string, kind: "qualify" | "revoke") {
    setBusy(`${kind}:${connectionId}`);
    try {
      const response = await fetch(
        `/api/organization/infrastructure/kubernetes/connections/${connectionId}/${kind}`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `Connection ${kind} failed.`);
      toast.success(kind === "qualify" ? "Qualification started." : "Connection revoked.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Connection ${kind} failed.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      description="Customer-owned Kubernetes clusters connected through an outbound-only connector. This feature is pre-release."
      title="Infrastructure connections"
    >
      <SettingsRows>
        <SettingsRow label="Kubernetes BYOC">
          <div className="flex items-center gap-3">
            <SettingsStatusSummary status={enabled ? "Enabled" : "Off"} tone={enabled ? "positive" : "neutral"} />
            <Button disabled={busy === "settings"} onClick={() => void updateOptIn(!enabled)} size="sm" variant="outline">
              {enabled ? "Disable new admission" : "Enable pre-release"}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label="Install">
          <p className="max-w-2xl text-muted-foreground text-sm">
            Install the digest-pinned Kestrel connector Helm chart in the customer cluster, then open the verification path printed by Helm and approve the displayed fingerprint. Upgrades remain manual and digest-pinned.
          </p>
        </SettingsRow>
      </SettingsRows>
      {loading ? <p className="py-5 text-muted-foreground text-sm">Loading infrastructure connections…</p> : null}
      {!loading && connections.length === 0 ? (
        <SettingsStatusNotice description="Install a connector to receive a fingerprint verification path. No Kubernetes API endpoint is exposed to Kestrel." title="No Kubernetes connections" tone="info" />
      ) : null}
      {connections.map((connection) => (
        <div className="mt-5 border-t pt-5" key={connection.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-sm">{connection.displayName}</h3>
                {connection.isDefault ? <Badge variant="secondary">Default</Badge> : null}
                <Badge variant="outline">{connection.supportStatus}</Badge>
              </div>
              <p className="mt-1 text-muted-foreground text-xs">
                {connection.presence} · {connection.status} · {connection.activeEnvironmentCount} active Environments
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={`/api/organization/infrastructure/kubernetes/connections/${connection.id}/diagnostics`}>Diagnostics</a>
              </Button>
              <Button disabled={!(enabled && connection.connector?.compatible && connection.configuration?.configured) || busy !== null} onClick={() => void action(connection.id, "qualify")} size="sm" variant="outline">Qualify</Button>
              <Button disabled={!connection.revocationReady || busy !== null} onClick={() => void action(connection.id, "revoke")} size="sm" variant="destructive">Revoke</Button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <span>Connector: {connection.connector?.version ?? "not enrolled"}</span>
            <span>Contracts: {connection.connector?.compatible ? "compatible" : "incompatible"}</span>
            <span>Configuration: {connection.configuration?.configured ? connection.configuration.frozen ? "frozen by active binding" : "editable" : "required"}</span>
            <span>Qualification: {connection.qualification?.status ?? "not run"}</span>
          </div>
          {connection.failure?.message ? (
            <SettingsStatusNotice description={connection.failure.message} title={connection.failure.code ?? "Connection failure"} tone="warning" />
          ) : null}
          {connection.configuration ? (
            <KubernetesConnectionConfiguration
              connectionId={connection.id}
              featureEnabled={enabled}
              frozen={connection.configuration.frozen}
              onSaved={load}
              value={connection.configuration.value}
            />
          ) : null}
        </div>
      ))}
    </SettingsSection>
  );
}
