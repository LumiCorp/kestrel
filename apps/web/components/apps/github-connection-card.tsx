"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppConnection } from "@/drizzle/schema";

type GithubConnectionStatus = {
  oauthConfigured: boolean;
  linked: boolean;
  connection: AppConnection | null;
};

export function GithubConnectionCard() {
  const [status, setStatus] = useState<GithubConnectionStatus | null>(null);
  const [repositoryCount, setRepositoryCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [statusResponse, repositoriesResponse] = await Promise.all([
      fetch("/api/apps/github"),
      fetch("/api/apps/github/repositories"),
    ]);
    if (!statusResponse.ok) {
      throw new Error("GitHub connection status is unavailable.");
    }
    const nextStatus = (await statusResponse.json()) as GithubConnectionStatus;
    setStatus(nextStatus);
    if (repositoriesResponse.ok) {
      const payload = (await repositoriesResponse.json()) as {
        repositories?: unknown[];
      };
      setRepositoryCount(payload.repositories?.length ?? 0);
    }
  }, []);

  const synchronize = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/apps/github/sync", {
        method: "POST",
      });
      const payload = (await response.json()) as {
        repositoryCount?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "GitHub synchronization failed.");
      }
      setRepositoryCount(payload.repositoryCount ?? 0);
      await refresh();
      toast.success("GitHub repositories synchronized.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "GitHub synchronization failed."
      );
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "GitHub status unavailable."
      )
    );
    const result = new URLSearchParams(window.location.search).get("github");
    if (result === "linked") {
      void synchronize();
    } else if (result === "error") {
      toast.error("GitHub did not complete the account link.");
    }
  }, [refresh, synchronize]);

  async function connect() {
    setBusy(true);
    try {
      const response = await fetch("/api/apps/github/connect", {
        method: "POST",
      });
      const payload = (await response.json()) as {
        linked?: boolean;
        url?: string | null;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "GitHub connection failed.");
      }
      if (payload.url) {
        window.location.assign(payload.url);
        return;
      }
      await synchronize();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "GitHub connection failed."
      );
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/apps/github", {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "GitHub disconnection failed.");
      }
      await refresh();
      toast.success("GitHub disconnected.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "GitHub disconnection failed."
      );
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connection?.status === "connected";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>GitHub</CardTitle>
          <p className="mt-1 text-muted-foreground text-sm">
            Connect your GitHub account for repository reads and controlled
            Kestrel agent branches.
          </p>
        </div>
        <Badge variant={connected ? "default" : "outline"}>
          {connected ? "Connected" : status?.linked ? "Linked" : "Not linked"}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <div className="mr-auto text-muted-foreground text-sm">
          {connected
            ? `${status?.connection?.externalAccountLabel ?? status?.connection?.name} · ${repositoryCount} repositories`
            : "GitHub is connected only for App capabilities. It is never used to sign into Kestrel."}
        </div>
        {connected ? (
          <>
            <Button
              disabled={busy}
              onClick={() => void synchronize()}
              variant="outline"
            >
              Refresh repositories
            </Button>
            <Button
              disabled={busy}
              onClick={() => void disconnect()}
              variant="outline"
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            disabled={busy || status?.oauthConfigured === false}
            onClick={() => void connect()}
          >
            Connect GitHub
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
