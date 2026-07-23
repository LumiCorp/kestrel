"use client";

import {
  Archive,
  FolderCode,
  FolderInput,
  Pencil,
  RotateCcw,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { SidebarToggle } from "@/components/chatbot/sidebar-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/chatbot/ui/alert-dialog";
import { Button } from "@/components/chatbot/ui/button";
import { Input } from "@/components/chatbot/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/chatbot/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/chatbot/ui/tooltip";
import { PlusIcon } from "./icons";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  archived,
  canManage,
  threadId,
  threadTitle,
  project,
  projects,
  selectedVisibilityType,
  isReadonly,
}: {
  archived: boolean;
  canManage: boolean;
  threadId: string;
  threadTitle?: string;
  project?: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string }>;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const initialTitle = threadTitle || "New Thread";
  const [displayTitle, setDisplayTitle] = useState(initialTitle);
  const [draftTitle, setDraftTitle] = useState(initialTitle);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const renamePendingRef = useRef(false);
  const cancelTitleSaveRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const saveTitleRef = useRef<(value: string) => void>(() => {});

  useEffect(() => {
    setDisplayTitle(initialTitle);
    setDraftTitle(initialTitle);
    setIsEditingTitle(false);
    cancelTitleSaveRef.current = false;
  }, [initialTitle, threadId]);

  async function patchThread(body: Record<string, unknown>) {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(result.error || "Thread update failed.");
    }
  }

  async function refreshThreadCaches() {
    await Promise.all([
      mutate(`/api/threads/${threadId}`),
      mutate("/api/threads?limit=30"),
      mutate("/api/threads?limit=100"),
      mutate("/api/projects"),
    ]);
  }

  async function saveTitle(value = draftTitle) {
    if (cancelTitleSaveRef.current || renamePendingRef.current) return;

    const nextTitle = value.trim();
    if (!nextTitle) {
      setDraftTitle(displayTitle);
      setIsEditingTitle(false);
      toast.error("Thread title cannot be empty");
      return;
    }
    if (nextTitle === displayTitle) {
      setIsEditingTitle(false);
      return;
    }

    const previousTitle = displayTitle;
    renamePendingRef.current = true;
    setIsRenaming(true);
    setDisplayTitle(nextTitle);
    setDraftTitle(nextTitle);
    setIsEditingTitle(false);

    try {
      await patchThread({ title: nextTitle });
      await refreshThreadCaches();
      toast.success("Thread renamed");
      router.refresh();
    } catch (error) {
      setDisplayTitle(previousTitle);
      setDraftTitle(previousTitle);
      toast.error(
        error instanceof Error ? error.message : "Thread update failed."
      );
    } finally {
      renamePendingRef.current = false;
      setIsRenaming(false);
    }
  }

  async function setArchived(nextArchived: boolean) {
    if (isArchiving || isRestoring) return;
    const setPending = nextArchived ? setIsArchiving : setIsRestoring;
    setPending(true);
    try {
      await patchThread({ archived: nextArchived });
      await refreshThreadCaches();
      toast.success(nextArchived ? "Thread archived" : "Thread restored");
      if (nextArchived) {
        router.replace(project ? `/projects/${project.id}` : "/threads");
      }
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Thread lifecycle update failed."
      );
    } finally {
      setPending(false);
    }
  }

  async function assignToProject() {
    if (!projectId || isAssigning) return;
    setIsAssigning(true);
    try {
      await patchThread({
        projectId,
        disclosureAccepted: true,
      });
      await refreshThreadCaches();
      setAssignmentDialogOpen(false);
      toast.success("Thread moved into Project");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Thread assignment failed."
      );
    } finally {
      setIsAssigning(false);
    }
  }

  async function permanentlyDeleteThread() {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/threads/${threadId}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "Thread could not be deleted.");
      }
      await refreshThreadCaches();
      toast.success("Thread permanently deleted");
      router.replace(project ? `/projects/${project.id}` : "/threads");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Thread could not be deleted."
      );
      setIsDeleting(false);
    }
  }

  saveTitleRef.current = (value) => {
    void saveTitle(value);
  };

  useEffect(() => {
    if (!isEditingTitle) return;

    const saveOnOutsidePointer = (event: PointerEvent) => {
      const input = titleInputRef.current;
      if (
        !(input && event.target instanceof Node) ||
        input.contains(event.target)
      ) {
        return;
      }
      saveTitleRef.current(input.value);
    };

    document.addEventListener("pointerdown", saveOnOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", saveOnOutsidePointer, true);
    };
  }, [isEditingTitle]);

  return (
    <TooltipProvider delayDuration={300}>
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-5">
        <SidebarToggle className="md:hidden" />
        <div className="group/title flex min-w-0 items-center gap-1">
          {isEditingTitle ? (
            <form
              className="w-[min(28rem,55vw)] min-w-0"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTitle();
              }}
            >
              <Input
                aria-label="Thread title"
                autoFocus
                className="h-9 min-w-0 max-w-[min(28rem,55vw)] font-semibold text-lg"
                onBlur={(event) => {
                  void saveTitle(event.currentTarget.value);
                }}
                onChange={(event) => setDraftTitle(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void saveTitle(event.currentTarget.value);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleSaveRef.current = true;
                    setDraftTitle(displayTitle);
                    setIsEditingTitle(false);
                  }
                }}
                ref={titleInputRef}
                value={draftTitle}
              />
            </form>
          ) : (
            <h1 className="truncate font-semibold text-lg">{displayTitle}</h1>
          )}
          {canManage && !archived ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Rename Thread"
                  className="size-8 shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/title:opacity-100 sm:group-focus-within/title:opacity-100"
                  disabled={isRenaming}
                  onClick={() => {
                    cancelTitleSaveRef.current = false;
                    setDraftTitle(displayTitle);
                    setIsEditingTitle(true);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <Pencil className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Rename Thread</TooltipContent>
            </Tooltip>
          ) : null}
          {project ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={`Shared Project: ${project.name}`}
                  className="hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground sm:flex"
                >
                  <Users className="size-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Shared Project: {project.name}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            className="h-8 px-2 md:hidden"
            onClick={() => {
              router.push(
                project
                  ? `/projects/${project.id}/threads/new`
                  : "/threads/new"
              );
            }}
            variant="outline"
          >
            <PlusIcon />
            <span className="sr-only">New Thread</span>
          </Button>
          {!isReadonly && (
            <VisibilitySelector
              selectedVisibilityType={selectedVisibilityType}
              threadId={threadId}
            />
          )}
          {!isReadonly && (
            <Button
              className="h-8 px-2"
              onClick={() => router.push(`/threads/${threadId}/workspace`)}
              variant="outline"
            >
              <FolderCode className="size-4" />
              <span className="hidden sm:inline">Workspace</span>
            </Button>
          )}
          {canManage && !project && !archived && projects.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Move Thread to Project"
                  className="size-8"
                  onClick={() => {
                    setProjectId("");
                    setAssignmentDialogOpen(true);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <FolderInput className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move Thread to Project</TooltipContent>
            </Tooltip>
          ) : null}
          {canManage && archived ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Restore Thread"
                    className="size-8"
                    disabled={isRestoring || isDeleting}
                    onClick={() => void setArchived(false)}
                    size="icon"
                    variant="ghost"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Restore Thread</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Delete Thread permanently"
                    className="size-8 text-destructive hover:text-destructive"
                    disabled={isRestoring || isDeleting}
                    onClick={() => setDeleteDialogOpen(true)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete Thread permanently</TooltipContent>
              </Tooltip>
            </>
          ) : canManage ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Archive Thread"
                  className="size-8"
                  disabled={isArchiving}
                  onClick={() => void setArchived(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Archive className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Archive Thread</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <AlertDialog
        onOpenChange={setAssignmentDialogOpen}
        open={assignmentDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move this Thread into a Project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every Project member will be able to read and continue it. Public
              sharing will be turned off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Select onValueChange={setProjectId} value={projectId}>
            <SelectTrigger aria-label="Project">
              <SelectValue placeholder="Choose a Project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isAssigning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!projectId || isAssigning}
              onClick={(event) => {
                event.preventDefault();
                void assignToProject();
              }}
            >
              {isAssigning ? "Moving…" : "Move Thread"}
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
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void permanentlyDeleteThread();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

export const ChatHeader = memo(
  PureChatHeader,
  (prevProps, nextProps) =>
    prevProps.archived === nextProps.archived &&
    prevProps.canManage === nextProps.canManage &&
    prevProps.threadId === nextProps.threadId &&
    prevProps.threadTitle === nextProps.threadTitle &&
    prevProps.project?.id === nextProps.project?.id &&
    prevProps.project?.name === nextProps.project?.name &&
    prevProps.projects === nextProps.projects &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
);
