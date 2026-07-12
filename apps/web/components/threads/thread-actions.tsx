"use client";

import { Archive, FolderInput, RotateCcw, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ThreadActions({
  threadId,
  initialTitle,
  project,
  projects,
  archived,
  canManage,
}: {
  threadId: string;
  initialTitle: string;
  project: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string }>;
  archived: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [title, setTitle] = useState(initialTitle);
  const [projectId, setProjectId] = useState("");
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  async function patch(body: Record<string, unknown>) {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error || "Thread update failed.");
  }

  async function rename() {
    try {
      await patch({ title });
      await refreshThreadCaches();
      toast.success("Thread renamed");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Thread update failed."
      );
    }
  }

  async function setArchived(nextArchived: boolean) {
    try {
      await patch({ archived: nextArchived });
      await refreshThreadCaches();
      toast.success(nextArchived ? "Thread archived" : "Thread restored");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Thread lifecycle update failed."
      );
    }
  }

  async function assignToProject() {
    if (!projectId) return;
    try {
      await patch({ projectId, disclosureAccepted: true });
      await refreshThreadCaches();
      toast.success("Thread moved into Project");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Thread assignment failed."
      );
    }
  }

  async function permanentlyDelete() {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      toast.error(result.error || "Thread could not be deleted.");
      return;
    }
    toast.success("Thread permanently deleted");
    router.push(project ? `/projects/${project.id}` : "/threads");
    router.refresh();
  }

  async function refreshThreadCaches() {
    await Promise.all([
      mutate(`/api/threads/${threadId}`),
      mutate("/api/threads?limit=30"),
      mutate("/api/projects"),
    ]);
  }

  return (
    <>
      <aside className="fixed top-2 right-3 z-40 hidden max-w-[min(46rem,calc(100vw-20rem))] items-center gap-2 rounded-lg border bg-background/95 p-1.5 shadow-sm backdrop-blur lg:flex">
        {project && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/projects/${project.id}`}>{project.name}</Link>
          </Button>
        )}
        {canManage && (
          <>
            <Input
              aria-label="Thread title"
              className="h-8 w-48"
              disabled={archived}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
            <Button
              aria-label="Save Thread title"
              disabled={archived || !title.trim() || title === initialTitle}
              onClick={() => void rename()}
              size="icon"
              variant="ghost"
            >
              <Save className="size-4" />
            </Button>
          </>
        )}
        {canManage && !project && !archived && projects.length > 0 && (
          <>
            <Select onValueChange={setProjectId} value={projectId}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue placeholder="Move to Project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              aria-label="Move Thread to Project"
              disabled={!projectId}
              onClick={() => setAssignmentDialogOpen(true)}
              size="icon"
              variant="ghost"
            >
              <FolderInput className="size-4" />
            </Button>
          </>
        )}
        {canManage &&
          (archived ? (
            <>
              <Button
                onClick={() => void setArchived(false)}
                size="sm"
                variant="outline"
              >
                <RotateCcw className="size-4" /> Restore
              </Button>
              <Button
                onClick={() => setDeleteDialogOpen(true)}
                size="sm"
                variant="destructive"
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            </>
          ) : (
            <Button
              aria-label="Archive Thread"
              onClick={() => void setArchived(true)}
              size="icon"
              variant="ghost"
            >
              <Archive className="size-4" />
            </Button>
          ))}
      </aside>
      <AlertDialog
        onOpenChange={setAssignmentDialogOpen}
        open={assignmentDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move this Thread into the Project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every Project member will be able to read and continue it. Public
              sharing will be turned off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void assignToProject()}>
              Move Thread
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete this Thread?</AlertDialogTitle>
            <AlertDialogDescription>
              This archived Thread and its transcript will be removed. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void permanentlyDelete()}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
