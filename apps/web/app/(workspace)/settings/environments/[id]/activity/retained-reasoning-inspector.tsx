"use client";

import { useState } from "react";
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

type Entry = {
  provider: string;
  model: string;
  format: string;
  text: string;
  createdAt: string;
  expiresAt: string;
};

export function RetainedReasoningInspector({ runId }: { runId: string }) {
  const [entries, setEntries] = useState<Entry[]>();
  const [status, setStatus] = useState<string>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  async function read() {
    setStatus("Loading…");
    const response = await fetch(`/api/organization/runs/${runId}/reasoning`, { cache: "no-store" });
    const payload = await response.json() as { entries?: Entry[]; error?: string };
    if (!response.ok) {
      setStatus(payload.error ?? "Retained reasoning is unavailable.");
      return;
    }
    setEntries(payload.entries ?? []);
    setStatus(undefined);
  }

  async function remove() {
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      const response = await fetch(
        `/api/organization/runs/${runId}/reasoning`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setDeleteError(
          payload.error ?? "Could not delete retained reasoning.",
        );
        return;
      }
      setEntries([]);
      setStatus("Retained reasoning deleted.");
      setDeleteDialogOpen(false);
    } catch {
      setDeleteError("Could not delete retained reasoning.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" type="button" onClick={read}>Inspect retained reasoning</Button>
        {entries && entries.length > 0 ? (
          <Button
            onClick={() => {
              setDeleteError(undefined);
              setDeleteDialogOpen(true);
            }}
            size="sm"
            type="button"
            variant="destructive"
          >
            Delete retained reasoning
          </Button>
        ) : null}
      </div>
      {status ? <p className="text-muted-foreground text-xs">{status}</p> : null}
      {entries?.map((entry, index) => (
        <div className="rounded-md border bg-muted/30 p-3 text-sm" key={`${entry.createdAt}-${index}`}>
          <div className="mb-2 font-medium text-muted-foreground text-xs">
            {formatLabel(entry.format)} · {entry.provider}/{entry.model}
          </div>
          <div className="whitespace-pre-wrap">{entry.text}</div>
          <div className="mt-2 text-muted-foreground text-xs">Expires {new Date(entry.expiresAt).toLocaleString()}</div>
        </div>
      ))}
      <AlertDialog
        onOpenChange={(open) => {
          if (deleteBusy) return;
          setDeleteDialogOpen(open);
          if (!open) setDeleteError(undefined);
        }}
        open={deleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete retained reasoning for this run?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the provider-visible reasoning retained
              for inspection. Run evidence and output remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-destructive text-sm" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={deleteBusy}
              onClick={() => void remove()}
              variant="destructive"
            >
              {deleteBusy ? "Deleting…" : "Delete permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatLabel(format: string) {
  if (format === "summary") return "Provider reasoning summary";
  if (format === "provider_thinking") return "Provider-visible thinking";
  return "Provider reasoning";
}
