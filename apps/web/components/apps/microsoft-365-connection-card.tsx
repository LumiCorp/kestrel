"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Microsoft365Pack } from "@/lib/integrations/microsoft-365-contract";
import {
  MICROSOFT_365_PACKS,
  microsoft365TeamsSendEligibility,
} from "@/lib/integrations/microsoft-365-contract";

type Status = {
  configured: boolean;
  linked: boolean;
  connected: boolean;
  status: "connected" | "degraded" | "disconnected" | null;
  label: string | null;
  packs: Microsoft365Pack[];
  grantedScopes: string[];
  health: {
    status: "connected" | "degraded" | "disconnected";
    reconnectRequired: boolean;
    failureCode: string | null;
    registrationRevision: number;
  } | null;
};

const TEAMS_PACKS: Microsoft365Pack[] = ["teams"];

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export function Microsoft365ConnectionCard({
  installed,
}: {
  installed: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/apps/microsoft-365")
      .then((response) => readJson<Status>(response))
      .then((next) => {
        if (!active) return;
        setStatus(next);
      });
    return () => {
      active = false;
    };
  }, []);

  const connect = useCallback(
    async () => {
      setWorking(true);
      try {
        const response = await fetch("/api/apps/microsoft-365", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ packs: TEAMS_PACKS }),
        });
        const body = await readJson<{
          connected?: boolean;
          packs?: Microsoft365Pack[];
          url?: string;
          error?: string | { message?: string };
        }>(response);
        if (!response.ok) {
          const error =
            typeof body.error === "string"
              ? body.error
              : body.error?.message ?? "Microsoft 365 could not be connected.";
          throw new Error(error);
        }
        if (body.url) {
          window.location.assign(body.url);
          return;
        }
        if (!body.connected) {
          throw new Error("Microsoft 365 connection was incomplete.");
        }
        const nextStatus = await readJson<Status>(
          await fetch("/api/apps/microsoft-365"),
        );
        setStatus(nextStatus);
        toast.success("Microsoft 365 is connected", {
          description: "Only the selected capability packs were authorized.",
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Microsoft 365 could not be connected.",
        );
      } finally {
        setWorking(false);
      }
    },
    [],
  );

  async function disconnect() {
    setWorking(true);
    try {
      const response = await fetch("/api/apps/microsoft-365", {
        method: "DELETE",
      });
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(body.error ?? "Microsoft 365 could not be disconnected.");
      }
      setStatus((current) =>
        current
          ? { ...current, connected: false, status: "disconnected" }
          : current,
      );
      toast.success("Microsoft 365 disconnected.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Microsoft 365 could not be disconnected.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <SettingsSection
      description="Connect a work or school Microsoft account for Teams chat reads and approved sends."
      title="Microsoft Teams connection"
    >
      <div className="space-y-4 py-3">
        <div className="flex items-start gap-3">
          <Checkbox checked disabled id="microsoft-365-teams" />
          <span className="min-w-0">
            <span className="block font-medium text-sm">
              {MICROSOFT_365_PACKS.teams.name}
            </span>
            <span className="mt-1 block text-muted-foreground text-sm">
              {MICROSOFT_365_PACKS.teams.description}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={status?.connected ? "default" : "outline"}>
              {status?.connected ? "Connected" : "Not connected"}
            </Badge>
            {status?.label ? <span className="text-muted-foreground">{status.label}</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {status?.connected ? (
              <Button disabled={working} onClick={() => void disconnect()} variant="outline">
                Disconnect
              </Button>
            ) : null}
            <Button
              disabled={
                working ||
                !installed ||
                status?.configured === false
              }
              onClick={() => void connect()}
            >
              {working
                ? "Connecting…"
                : status?.connected
                  ? "Reconnect Teams"
                  : "Connect Teams"}
            </Button>
          </div>
        </div>
        {status?.configured === false ? (
          <p className="text-destructive text-sm">
            Teams has not been configured by this Platform Admin.
          </p>
        ) : null}
        {status?.connected ? (
          <div className="space-y-1 text-muted-foreground text-sm">
            <p>
              Granted Teams permissions: {status.grantedScopes
                .filter((scope) => scope === "Chat.Read" || scope === "ChatMessage.Send")
                .join(", ") || "none"}.
            </p>
            {status.grantedScopes.includes("Chat.Read") &&
            microsoft365TeamsSendEligibility(status.grantedScopes) ===
              "tenant_admin_consent_required" ? (
              <p>
                Sending needs Microsoft tenant-admin approval; Teams reads remain available.
              </p>
            ) : null}
            {status.health?.reconnectRequired ? (
              <p>Reconnect Teams to restore this connection.</p>
            ) : null}
          </div>
        ) : null}
        {installed ? null : (
          <p className="text-muted-foreground text-sm">
            An organization admin must install Microsoft 365 before you can
            connect or update capabilities.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
