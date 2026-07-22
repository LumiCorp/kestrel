"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionGroup,
  SettingsExpandableRegion,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FlyConnection = {
  status: string;
  hasApiToken: boolean;
  organizationSlug: string;
} | null;

export function FlyWorkspaceProviderClient() {
  const [connection, setConnection] = useState<FlyConnection>(null);
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(
      "/api/organization/infrastructure/connections/fly",
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Fly connection is unavailable.");
    }
    setConnection(payload.connection ?? null);
    setOrganizationSlug(payload.connection?.organizationSlug ?? "");
    setError(null);
  }, []);

  useEffect(() => {
    refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    );
  }, [refresh]);

  async function act(action: "configure" | "test") {
    setBusy(action);
    try {
      const response = await fetch(
        "/api/organization/infrastructure/connections/fly",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "configure"
              ? {
                  action,
                  organizationSlug,
                  apiToken: apiToken || null,
                  enabled: true,
                }
              : { action }
          ),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error ?? `Fly ${action} failed.`);
      }
      await refresh();
      if (action === "configure") {
        setApiToken("");
        setEditing(false);
      }
      toast.success(
        action === "configure"
          ? "Workspace provider saved."
          : "Fly connection verified."
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      description="Fly supplies the CPU workspace runtimes where agents execute and persistent workspaces live."
      title="Workspace provider"
    >
      <SettingsRows>
        <SettingsRow label="Fly connection">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SettingsStatusSummary
              detail={
                connection?.hasApiToken
                  ? "Encrypted credential stored"
                  : "No credential"
              }
              status={connection?.status ?? "Not configured"}
              tone={connection?.status === "ready" ? "positive" : "neutral"}
            />
            <SettingsActionGroup>
              <Button
                disabled={Boolean(busy)}
                onClick={() => setEditing((current) => !current)}
                size="sm"
                variant="outline"
              >
                {editing ? "Cancel" : "Configure"}
              </Button>
              <Button
                disabled={Boolean(busy) || !connection?.hasApiToken}
                onClick={() => void act("test")}
                size="sm"
                variant="outline"
              >
                {busy === "test" ? "Testing…" : "Test"}
              </Button>
            </SettingsActionGroup>
          </div>
        </SettingsRow>
        <SettingsRow label="Organization slug">
          <span className="text-sm">
            {connection?.organizationSlug || "Not configured"}
          </span>
        </SettingsRow>
        {error ? <div className="py-3 text-destructive text-sm">{error}</div> : null}
        {editing ? (
          <SettingsExpandableRegion>
            <div className="grid max-w-2xl gap-4">
              <div className="space-y-2">
                <Label htmlFor="fly-organization-slug">Fly organization slug</Label>
                <Input
                  id="fly-organization-slug"
                  onChange={(event) => setOrganizationSlug(event.target.value)}
                  value={organizationSlug}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fly-api-token">Fly API token</Label>
                <Input
                  autoComplete="off"
                  id="fly-api-token"
                  onChange={(event) => setApiToken(event.target.value)}
                  placeholder="Leave empty to keep the stored token"
                  type="password"
                  value={apiToken}
                />
              </div>
              <SettingsActionGroup>
                <Button
                  disabled={Boolean(busy) || !organizationSlug.trim()}
                  onClick={() => void act("configure")}
                  size="sm"
                >
                  {busy === "configure" ? "Saving…" : "Save"}
                </Button>
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setApiToken("");
                    setOrganizationSlug(connection?.organizationSlug ?? "");
                    setEditing(false);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </SettingsActionGroup>
            </div>
          </SettingsExpandableRegion>
        ) : null}
      </SettingsRows>
    </SettingsSection>
  );
}
