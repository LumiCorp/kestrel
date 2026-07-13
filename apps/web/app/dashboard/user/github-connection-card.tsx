"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UserToolConnection } from "@/drizzle/schema";

type GithubConnectionStatus = {
  oauthConfigured: boolean;
  linked: boolean;
  connection: UserToolConnection | null;
};

export function GithubConnectionCard() {
  const [status, setStatus] = useState<GithubConnectionStatus | null>(null);
  const [repositoryCount, setRepositoryCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [statusResponse, repositoriesResponse] = await Promise.all([
      fetch("/api/integrations/github"),
      fetch("/api/integrations/github/repositories"),
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
      const response = await fetch("/api/integrations/github/sync", {
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
      const response = await fetch("/api/integrations/github/connect", {
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
      const response = await fetch("/api/integrations/github", {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "GitHub disconnection failed.");
      }
      await refresh();
      toast.success("GitHub disconnected from this organization.");
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
            Link your own GitHub identity for repository reads and controlled
            Kestrel agent branches in this organization.
          </p>
        </div>
        <Badge variant={connected ? "default" : "outline"}>
          {connected ? "Connected" : status?.linked ? "Linked" : "Not linked"}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <div className="mr-auto text-muted-foreground text-sm">
          {connected
            ? `${status?.connection?.providerLogin} · ${repositoryCount} repositories`
            : "GitHub is a linked tool only. It is never used to sign into Kestrel."}
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
              Disconnect from organization
            </Button>
          </>
        ) : (
          <Button
            disabled={busy || status?.oauthConfigured === false}
            onClick={() => void connect()}
          >
            Link GitHub
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
