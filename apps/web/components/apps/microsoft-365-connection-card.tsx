"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppSettingsSection } from "@/components/apps/app-settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Microsoft365Pack } from "@/lib/integrations/microsoft-365-contract";
import { MICROSOFT_365_PACKS } from "@/lib/integrations/microsoft-365-contract";

type Status = {
  configured: boolean;
  linked: boolean;
  connected: boolean;
  status: "connected" | "degraded" | "disconnected" | null;
  label: string | null;
  packs: Microsoft365Pack[];
};

const PACK_KEYS = Object.keys(MICROSOFT_365_PACKS) as Microsoft365Pack[];

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export function Microsoft365ConnectionCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [packs, setPacks] = useState<Microsoft365Pack[]>(["outlook"]);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/apps/microsoft-365")
      .then((response) => readJson<Status>(response))
      .then((next) => {
        if (!active) return;
        setStatus(next);
        if (next.packs.length) setPacks(next.packs);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("microsoft365") !== "linked") return;
    const callbackPacks = query
      .get("packs")
      ?.split(",")
      .filter((pack): pack is Microsoft365Pack =>
        PACK_KEYS.includes(pack as Microsoft365Pack)
      );
    if (!callbackPacks?.length) return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("microsoft365");
    cleanUrl.searchParams.delete("packs");
    window.history.replaceState({}, "", cleanUrl);
    void connect(callbackPacks);
  }, []);

  function togglePack(pack: Microsoft365Pack, enabled: boolean) {
    setPacks((current) =>
      enabled
        ? [...new Set([...current, pack])]
        : current.filter((candidate) => candidate !== pack)
    );
  }

  async function connect(nextPacks = packs) {
    setWorking(true);
    try {
      const response = await fetch("/api/apps/microsoft-365", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packs: nextPacks }),
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
      if (!body.connected) throw new Error("Microsoft 365 connection was incomplete.");
      const nextStatus = await readJson<Status>(
        await fetch("/api/apps/microsoft-365")
      );
      setStatus(nextStatus);
      setPacks(body.packs ?? nextPacks);
      toast.success("Microsoft 365 is connected", {
        description: "Only the selected capability packs were authorized.",
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Microsoft 365 could not be connected."
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <AppSettingsSection
      description="Choose the Microsoft 365 services Kestrel may use. Adding another service extends the same connection."
      title="Microsoft 365 connection"
    >
      <div className="space-y-4 py-3">
        {PACK_KEYS.map((pack) => {
          const definition = MICROSOFT_365_PACKS[pack];
          return (
            <label
              className="flex cursor-pointer items-start gap-3"
              htmlFor={`microsoft-365-${pack}`}
              key={pack}
            >
              <Checkbox
                checked={packs.includes(pack)}
                disabled={working}
                id={`microsoft-365-${pack}`}
                onCheckedChange={(checked) => togglePack(pack, checked === true)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-sm">{definition.name}</span>
                <span className="mt-1 block text-muted-foreground text-sm">
                  {definition.description}
                </span>
              </span>
            </label>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={status?.connected ? "default" : "outline"}>
              {status?.connected ? "Connected" : "Not connected"}
            </Badge>
            {status?.label ? <span className="text-muted-foreground">{status.label}</span> : null}
          </div>
          <Button
            disabled={working || packs.length === 0 || status?.configured === false}
            onClick={() => void connect()}
          >
            {working
              ? "Connecting…"
              : status?.connected
                ? "Update capabilities"
                : "Connect Microsoft 365"}
          </Button>
        </div>
        {status?.configured === false ? (
          <p className="text-destructive text-sm">
            Microsoft 365 has not been configured for this Kestrel deployment.
          </p>
        ) : null}
      </div>
    </AppSettingsSection>
  );
}
