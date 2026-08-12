import type { ProjectRole } from "./access";

export function getProjectSurfaceAccess(input: {
  role: ProjectRole;
  archivedAt: string | null;
}) {
  const isOwner = input.role === "owner";
  const canEdit = isOwner || input.role === "editor";
  const isArchived = input.archivedAt !== null;

  return {
    canEdit,
    canCreateThread: !isArchived,
    canConfigureWorkspace: canEdit && !isArchived,
    canArchive: isOwner && !isArchived,
    canRestore: isOwner && isArchived,
    canDelete: isOwner && isArchived,
    hasProjectActions: isOwner || (canEdit && !isArchived),
  };
}

export function partitionProjectThreads<
  Thread extends { archivedAt: string | null },
>(threads: readonly Thread[]) {
  return {
    activeThreads: threads.filter((thread) => thread.archivedAt === null),
    archivedThreads: threads.filter((thread) => thread.archivedAt !== null),
  };
}

export function getProjectSavePresentation(input: {
  canEdit: boolean;
  saving: boolean;
  name: string;
  revision: number;
}) {
  return {
    disabled: !input.canEdit || input.saving || !input.name.trim(),
    label: input.saving
      ? "Saving…"
      : `Save revision ${input.revision + 1}`,
  };
}
