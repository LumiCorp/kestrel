"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function EnvironmentDeleteAction({
  environmentId,
  environmentName,
  isDefault,
  status,
}: {
  environmentId: string;
  environmentName: string;
  isDefault: boolean;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const [busy, setBusy] = useState(false);
  const deleting = status === "deleting";

  async function requestDeletion() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmationName }),
        }
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Environment deletion could not be requested.");
      }
      toast.success("Environment deletion requested.");
      setOpen(false);
      router.push("/settings/organization/environments");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Environment deletion could not be requested."
      );
    } finally {
      setBusy(false);
    }
  }

  if (isDefault) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Create another Environment, wait for it to be ready, and make it the
          default before deleting this one.
        </p>
        <Button disabled size="sm" variant="destructive">
          <Trash2 className="size-4" /> Delete Environment
        </Button>
      </div>
    );
  }

  if (deleting) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Deletion is in progress. The Environment will disappear once its Fly
          resources have been removed.
        </p>
        <Button disabled size="sm" variant="destructive">
          Deletion requested
        </Button>
      </div>
    );
  }

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Permanently remove this execution plane and its persistent
          Workspaces.
        </p>
        <Button onClick={() => setOpen(true)} size="sm" variant="destructive">
          <Trash2 className="size-4" /> Delete Environment
        </Button>
      </div>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Permanently delete {environmentName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the Fly app and every Workspace volume for this
            Environment. No automatic backup is created, and this cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="environment-delete-confirmation">
            Type <span className="font-medium text-foreground">{environmentName}</span> to confirm
          </Label>
          <Input
            autoComplete="off"
            id="environment-delete-confirmation"
            onChange={(event) => setConfirmationName(event.target.value)}
            value={confirmationName}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            disabled={busy || confirmationName !== environmentName}
            onClick={() => void requestDeletion()}
            variant="destructive"
          >
            {busy ? "Requesting…" : "Delete permanently"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
