"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkspaceBackupActions } from "@/app/(workspace)/settings/environments/[id]/workspaces/workspace-backup-actions";

async function requestError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error ?? fallback;
}

export function WorkspaceLifecycleActions({
  environmentId,
  workspace,
}: {
  environmentId: string;
  workspace: {
    id: string;
    name: string;
    status: string;
    machineId: string | null;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"start" | "stop" | "retire" | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");

  async function requestAction(action: "start" | "stop") {
    setBusy(action);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspace.id}/${action}`,
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error(
          await requestError(response, `Workspace ${action} failed.`),
        );
      toast.success(`Workspace ${action} requested.`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Workspace ${action} failed.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function retire() {
    setBusy("retire");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/workspaces/${workspace.id}/retire`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmationName }),
        },
      );
      if (!response.ok)
        throw new Error(
          await requestError(response, "Workspace retirement failed."),
        );
      toast.success("Workspace retirement requested.");
      setConfirmationName("");
      setRetireOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workspace retirement failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {workspace.status === "stopped" && workspace.machineId ? (
        <Button
          disabled={busy !== null}
          onClick={() => void requestAction("start")}
          size="sm"
          variant="outline"
        >
          {busy === "start" ? "Starting…" : "Start"}
        </Button>
      ) : null}
      {workspace.status === "ready" && workspace.machineId ? (
        <Button
          disabled={busy !== null}
          onClick={() => void requestAction("stop")}
          size="sm"
          variant="outline"
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
      <WorkspaceBackupActions
        environmentId={environmentId}
        workspaceId={workspace.id}
        workspaceStatus={workspace.status}
      />
      <Button
        disabled={busy !== null || workspace.status === "deleting"}
        onClick={() => setRetireOpen(true)}
        size="sm"
        variant="destructive"
      >
        Retire
      </Button>
      <Dialog onOpenChange={setRetireOpen} open={retireOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire {workspace.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the Workspace machine and its persistent
              volume. The Project remains, but its execution Workspace must be
              provisioned again before the next run.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`retire-${workspace.id}`}>
              Type {workspace.name} to confirm
            </Label>
            <Input
              id={`retire-${workspace.id}`}
              onChange={(event) => setConfirmationName(event.target.value)}
              value={confirmationName}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={busy !== null || confirmationName !== workspace.name}
              onClick={() => void retire()}
              variant="destructive"
            >
              {busy === "retire" ? "Retiring…" : "Retire Workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
