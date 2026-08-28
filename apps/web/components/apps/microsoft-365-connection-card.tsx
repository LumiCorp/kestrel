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
  availablePacks: Microsoft365Pack[];
  packs: Microsoft365Pack[];
  grantedScopes: string[];
  health: {
    status: "connected" | "degraded" | "disconnected";
    reconnectRequired: boolean;
    failureCode: string | null;
    registrationRevision: number;
  } | null;
};

const HOSTED_PACKS = ["outlook", "teams"] as const;
type HostedMicrosoft365Pack = (typeof HOSTED_PACKS)[number];

function isHostedMicrosoft365Pack(
  pack: Microsoft365Pack,
): pack is HostedMicrosoft365Pack {
  return pack === "outlook" || pack === "teams";
}

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
  const [selectedPacks, setSelectedPacks] = useState<HostedMicrosoft365Pack[]>([]);
  const availablePacks = status
    ? status.availablePacks.filter(isHostedMicrosoft365Pack)
    : [];

  useEffect(() => {
    let active = true;
    void fetch("/api/apps/microsoft-365")
      .then((response) => readJson<Status>(response))
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setSelectedPacks(
          next.packs.filter(isHostedMicrosoft365Pack),
        );
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
          body: JSON.stringify({ packs: selectedPacks }),
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
    [selectedPacks],
  );

  function togglePack(pack: HostedMicrosoft365Pack, checked: boolean) {
    setSelectedPacks((current) => {
      const next = checked
        ? [...current, pack]
        : current.filter((candidate) => candidate !== pack);
      return HOSTED_PACKS.filter((candidate) => next.includes(candidate));
    });
  }

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
      description="Connect a work or school Microsoft account for Outlook mail and calendar access, Teams chat reads, and approved sends."
      title="Microsoft 365 connection"
    >
      <div className="space-y-4 py-3">
        {availablePacks.map((pack) => (
          <label
            className="flex items-start gap-3"
            htmlFor={`microsoft-365-${pack}`}
            key={pack}
          >
            <Checkbox
              checked={selectedPacks.includes(pack)}
              disabled={working || status?.connected === true}
              id={`microsoft-365-${pack}`}
              onCheckedChange={(checked) => togglePack(pack, checked === true)}
            />
            <span className="min-w-0">
              <span className="block font-medium text-sm">
                {MICROSOFT_365_PACKS[pack].name}
              </span>
              <span className="mt-1 block text-muted-foreground text-sm">
                {MICROSOFT_365_PACKS[pack].description}
              </span>
            </span>
          </label>
        ))}
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
                !status ||
                status?.configured === false ||
                selectedPacks.length === 0
              }
              onClick={() => void connect()}
            >
              {working
                  ? "Connecting…"
                  : status?.connected
                    ? "Reconnect Microsoft 365"
                    : "Connect Microsoft 365"}
            </Button>
          </div>
        </div>
        {status?.configured === false ? (
          <p className="text-destructive text-sm">
            Microsoft 365 has not been configured by this Platform Admin.
          </p>
        ) : null}
        {status?.connected ? (
          <div className="space-y-1 text-muted-foreground text-sm">
            <p>
              Granted Microsoft permissions: {status.grantedScopes
                .filter((scope) =>
                  [
                    "Mail.Read",
                    "Mail.Send",
                    "Calendars.Read",
                    "Chat.Read",
                    "ChatMessage.Send",
                  ].includes(scope),
                )
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
              <p>Reconnect Microsoft 365 to restore this connection.</p>
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
