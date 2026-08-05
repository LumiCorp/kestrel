"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { WorkspaceBackup } from "@/drizzle/schema";
import { Button } from "@/components/ui/button";

type WorkspaceBackupActionsProps = {
  environmentId: string;
  workspaceId: string;
  workspaceStatus: string;
};

type ProtectedWorkspaceBackup = WorkspaceBackup & {
  protectionReasons: string[];
  retainedUntil: string;
  archiveRecoveryAvailable: boolean;
  snapshotRecoveryAvailable: boolean;
  failure: {
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
};

async function responseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error ?? fallback;
}

export function WorkspaceBackupActions({
  environmentId,
  workspaceId,
  workspaceStatus,
}: WorkspaceBackupActionsProps) {
  const router = useRouter();
  const [backups, setBackups] = useState<ProtectedWorkspaceBackup[]>([]);
  const [busy, setBusy] = useState<"backup" | "restore" | "retry" | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState<string | null>(
    null,
  );

  const refreshBackups = useCallback(async () => {
    const response = await fetch(
      `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/backups`,
    );
    if (!response.ok) {
      throw new Error(
        await responseError(response, "Workspace backups could not be loaded."),
      );
    }
    const payload = (await response.json()) as {
      backups?: ProtectedWorkspaceBackup[];
    };
    setBackups(payload.backups ?? []);
  }, [environmentId, workspaceId]);

  useEffect(() => {
    void refreshBackups().catch(() => {
      // Actions remain available even if the initial count cannot be loaded.
    });
  }, [refreshBackups]);

  const availableBackups = backups.filter(
    (backup) => backup.status === "available",
  );
  const latestBackup = availableBackups[0];
  const failedDailyBackup = backups.find(
    (backup) => backup.reason === "daily" && backup.status === "failed",
  );

  async function createBackup() {
    setBusy("backup");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/backups`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "checkpoint" }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Workspace backup failed."),
        );
      }
      await refreshBackups();
      toast.success(
        "Backup check queued; unchanged content will reuse its protected revision.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workspace backup failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function restoreLatestBackup() {
    if (!latestBackup) return;
    if (restoreConfirmation !== latestBackup.id) {
      setRestoreConfirmation(latestBackup.id);
      toast.warning(
        "Select Confirm restore to continue. Kestrel creates a pre-restore backup first.",
      );
      return;
    }

    setBusy("restore");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/backups/${latestBackup.id}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Workspace restore failed."),
        );
      }
      setRestoreConfirmation(null);
      toast.success("Workspace restored from backup.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workspace restore failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function retryProvisioning() {
    setBusy("retry");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/retry`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Workspace provisioning retry failed."),
        );
      }
      toast.success("Workspace provisioning retry queued.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Workspace provisioning retry failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function retryDailyBackup() {
    if (!failedDailyBackup) return;
    setBusy("retry");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/backups/${failedDailyBackup.id}/retry`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Daily Workspace backup retry failed."),
        );
      }
      await refreshBackups();
      toast.success("Daily Workspace backup retry queued.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Daily Workspace backup retry failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-muted-foreground text-xs tabular-nums">
        {availableBackups.length}{" "}
        {availableBackups.length === 1 ? "backup" : "backups"}
      </span>
      {latestBackup ? (
        <span className="basis-full text-right text-muted-foreground text-xs">
          {formatBytes(latestBackup.sizeBytes)} ·{" "}
          {latestBackup.protectionReasons.join(", ")} · retained until{" "}
          {new Date(latestBackup.retainedUntil).toLocaleDateString()} · archive{" "}
          {latestBackup.archiveRecoveryAvailable ? "ready" : "unavailable"} ·
          snapshot{" "}
          {latestBackup.snapshotRecoveryAvailable ? "ready" : "unavailable"}
        </span>
      ) : null}
      {backups.find((backup) => backup.status === "failed")?.failure
        ?.errorMessage ? (
        <span className="basis-full text-right text-destructive text-xs">
          {
            backups.find((backup) => backup.status === "failed")?.failure
              ?.errorMessage
          }
        </span>
      ) : null}
      {workspaceStatus === "failed" ? (
        <Button
          disabled={busy !== null}
          onClick={() => void retryProvisioning()}
          size="sm"
          variant="outline"
        >
          {busy === "retry" ? "Retrying…" : "Retry provisioning"}
        </Button>
      ) : null}
      <Button
        disabled={workspaceStatus !== "ready" || busy !== null}
        onClick={() => void createBackup()}
        size="sm"
        variant="outline"
      >
        {busy === "backup" ? "Backing up…" : "Back up"}
      </Button>
      {failedDailyBackup ? (
        <Button
          disabled={busy !== null}
          onClick={() => void retryDailyBackup()}
          size="sm"
          variant="outline"
        >
          {busy === "retry" ? "Retrying…" : "Retry daily backup"}
        </Button>
      ) : null}
      {latestBackup ? (
        <Button
          disabled={busy !== null}
          onClick={() => void restoreLatestBackup()}
          size="sm"
          variant="outline"
        >
          {busy === "restore"
            ? "Restoring…"
            : restoreConfirmation === latestBackup.id
              ? "Confirm restore"
              : "Restore latest"}
        </Button>
      ) : null}
    </div>
  );
}

function formatBytes(value: number | null) {
  if (value === null) return "size unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
