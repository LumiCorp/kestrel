"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type GoogleConnectionStatus = {
  configured: boolean;
  linked: boolean;
  connected: boolean;
  status: "connected" | "degraded" | "disconnected" | null;
  label: string | null;
  selectedPacks: Array<"calendar" | "gmail">;
  packHealth: Record<
    "calendar" | "gmail",
    "not_selected" | "ready" | "missing_scopes"
  >;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export function GoogleWorkspaceConnectionCard({
  installed,
}: {
  installed: boolean;
}) {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [selectedPacks, setSelectedPacks] = useState<
    Array<"calendar" | "gmail">
  >(["calendar"]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/apps/google", { cache: "no-store" });
    const body = await readJson<GoogleConnectionStatus & { error?: string }>(
      response,
    );
    if (!response.ok) {
      throw new Error(body.error ?? "Google Workspace status is unavailable.");
    }
    setStatus(body);
    setSelectedPacks(body.selectedPacks);
  }, []);

  const connect = useCallback(
    async (packs = selectedPacks) => {
      setWorking(true);
      try {
        const response = await fetch("/api/apps/google", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            packs,
          }),
        });
        const body = await readJson<{
          connected?: boolean;
          url?: string | null;
          error?: string;
        }>(response);
        if (!response.ok) {
          throw new Error(
            body.error ?? "Google Workspace could not be connected.",
          );
        }
        if (body.url) {
          window.location.assign(body.url);
          return;
        }
        await refresh();
        toast.success(
          body.connected
            ? "Google Workspace connected."
            : "Google Workspace permissions were updated.",
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Google Workspace could not be connected.",
        );
      } finally {
        setWorking(false);
      }
    },
    [refresh, selectedPacks],
  );

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Google status unavailable.",
      ),
    );
    const query = new URLSearchParams(window.location.search);
    const integration = query.get("integration");
    const result = query.get("status");
    if (integration === "google_workspace" && result) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("integration");
      cleanUrl.searchParams.delete("status");
      window.history.replaceState({}, "", cleanUrl);
    }
    if (result === "error") {
      toast.error("Google authorization was not completed.");
    } else if (integration === "google_workspace" && result === "connected") {
      void refresh();
      toast.success("Google Workspace connected.");
    }
  }, [refresh]);

  function togglePack(pack: "calendar" | "gmail", selected: boolean) {
    setSelectedPacks((current) => {
      const next = selected
        ? [...new Set([...current, pack])]
        : current.filter((candidate) => candidate !== pack);
      return next.length ? next : current;
    });
  }

  async function disconnect() {
    setWorking(true);
    try {
      const response = await fetch("/api/apps/google", { method: "DELETE" });
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(
          body.error ?? "Google Workspace could not be disconnected.",
        );
      }
      await refresh();
      toast.success("Google Workspace disconnected", {
        description:
          "It was also removed from your Projects in this organization.",
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Workspace could not be disconnected.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <SettingsSection
      description="Choose Calendar, Gmail, or both. Projects remain separately authorized."
      title="Google Workspace"
    >
      <div className="flex flex-wrap items-center gap-3 py-3">
        <div className="mr-auto">
          <Badge
            variant={status?.status === "connected" ? "default" : "outline"}
          >
            {status?.status === "connected"
              ? "Connected"
              : status?.status === "degraded"
                ? "Permission update required"
                : "Not connected"}
          </Badge>
          {status?.label ? (
            <p className="mt-2 text-muted-foreground text-sm">{status.label}</p>
          ) : null}
        </div>
        {status?.status && status.status !== "disconnected" ? (
          <Button
            disabled={working}
            onClick={() => void disconnect()}
            variant="outline"
          >
            Disconnect
          </Button>
        ) : null}
        <Button
          disabled={working || !installed || status?.configured === false}
          onClick={() => void connect()}
        >
          {working
            ? "Connecting…"
            : status?.status === "degraded"
              ? "Reconnect Google"
              : status?.connected
                ? "Refresh connection"
                : "Connect Google"}
        </Button>
      </div>
      <fieldset className="space-y-2 border-t py-3">
        <legend className="font-medium text-sm">Google Workspace access</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={selectedPacks.includes("calendar")}
            onChange={(event) => togglePack("calendar", event.target.checked)}
            type="checkbox"
          />
          <span>
            Calendar
            <span className="block text-muted-foreground text-xs">
              Manage the connected account&apos;s Calendar within authorized
              Projects.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={selectedPacks.includes("gmail")}
            onChange={(event) => togglePack("gmail", event.target.checked)}
            type="checkbox"
          />
          <span>
            Gmail
            <span className="block text-muted-foreground text-xs">
              Request read and send consent; mailbox tools remain unavailable
              until their governed operation contracts are enabled.
            </span>
          </span>
        </label>
      </fieldset>
      {selectedPacks.includes("gmail") ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-amber-950 text-sm dark:bg-amber-950/30 dark:text-amber-100">
          Gmail data is used only for the productivity actions you authorize.
          Kestrel requires a qualifying Environment model route before any
          restricted Gmail content can enter a model request; it is not used to
          train generalized models.
        </p>
      ) : null}
      {status?.packHealth.gmail === "missing_scopes" ? (
        <p className="text-muted-foreground text-sm">
          Gmail consent is incomplete. Calendar remains available where its
          scopes are healthy.
        </p>
      ) : null}
      {status?.configured === false ? (
        <p className="text-destructive text-sm">
          Google Workspace is not configured by a Platform Admin.
        </p>
      ) : null}
      {installed ? null : (
        <p className="text-muted-foreground text-sm">
          An organization admin must install Google Workspace before you can
          connect or refresh an account.
        </p>
      )}
    </SettingsSection>
  );
}
