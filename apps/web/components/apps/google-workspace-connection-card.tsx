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

  const refresh = useCallback(async () => {
    const response = await fetch("/api/apps/google", { cache: "no-store" });
    const body = await readJson<GoogleConnectionStatus & { error?: string }>(
      response,
    );
    if (!response.ok) {
      throw new Error(body.error ?? "Google Workspace status is unavailable.");
    }
    setStatus(body);
  }, []);

  const connect = useCallback(async () => {
    setWorking(true);
    try {
      const response = await fetch("/api/apps/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendar: true }),
      });
      const body = await readJson<{
        connected?: boolean;
        url?: string | null;
        error?: string;
      }>(response);
      if (!response.ok) {
        throw new Error(body.error ?? "Google Workspace could not be connected.");
      }
      if (body.url) {
        window.location.assign(body.url);
        return;
      }
      await refresh();
      toast.success("Google Workspace connected.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Workspace could not be connected.",
      );
    } finally {
      setWorking(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Google status unavailable.",
      ),
    );
    const result = new URLSearchParams(window.location.search).get("google");
    if (result) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("google");
      window.history.replaceState({}, "", cleanUrl);
    }
    if (result === "error") {
      toast.error("Google authorization was not completed.");
    } else if (result === "linked") {
      if (installed) {
        void connect();
      } else {
        toast.error(
          "An organization admin must install Google Workspace before it can be connected.",
        );
      }
    }
  }, [connect, installed, refresh]);

  async function disconnect() {
    setWorking(true);
    try {
      const response = await fetch("/api/apps/google", { method: "DELETE" });
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(body.error ?? "Google Workspace could not be disconnected.");
      }
      await refresh();
      toast.success("Google Workspace disconnected", {
        description: "It was also removed from your Projects in this organization.",
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
      description="Connect Calendar once, then choose which Projects may use it and what availability they may share."
      title="Google Workspace"
    >
      <div className="flex flex-wrap items-center gap-3 py-3">
        <div className="mr-auto">
          <Badge variant={status?.connected ? "default" : "outline"}>
            {status?.connected
              ? "Connected"
              : status?.status === "degraded"
                ? "Reconnect required"
                : "Not connected"}
          </Badge>
          {status?.label ? (
            <p className="mt-2 text-muted-foreground text-sm">
              {status.label}
            </p>
          ) : null}
        </div>
        {status?.connected ? (
          <Button disabled={working} onClick={() => void disconnect()} variant="outline">
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
      {status?.configured === false ? (
        <p className="text-destructive text-sm">
          Google OAuth is not configured for this Kestrel deployment.
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
