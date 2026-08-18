import { Archive, ChevronDown, FolderPlus, MoreHorizontal, Plus, Search, X } from "lucide-react";
import React, { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { keepFocusInsideDialog } from "./dialogFocus";
import {
  MAX_RENDERER_THREAD_TITLE_LENGTH,
  type RendererThread,
} from "./state";
import {
  projectDesktopWorkNavigator,
  type DesktopThreadNavigationState,
} from "./workNavigator";

export function ConversationExplorer(props: {
  threads: readonly RendererThread[];
  activeThreadId: string;
  projects: readonly { path: string; label: string }[];
  navigation: Readonly<Record<string, DesktopThreadNavigationState>>;
  selectedProjectPath?: string | undefined;
  newConversationRequestId: number;
  onSelect: (threadId: string) => void;
  onSelectProject: (projectPath: string) => void;
  onNewConversation: (projectPath: string | null) => void;
  onAddProjectAndCreate: () => Promise<void>;
  onRename: (threadId: string, title: string) => void;
  onArchive: (threadId: string) => Promise<{ status: "archived" } | { status: "blocked"; message: string }>;
  onUndoArchive: (threadId: string, removeReplacement: boolean) => void;
  onRestore: (threadId: string) => void;
  onDelete: (threadId: string, force: boolean) => Promise<{
    status: "deleted" | "requires_force";
    message?: string | undefined;
  }>;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [view, setView] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string>();
  const [renamingThread, setRenamingThread] = useState<RendererThread>();
  const [deletingThread, setDeletingThread] = useState<RendererThread>();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteForceRequired, setDeleteForceRequired] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string>();
  const [renameTitle, setRenameTitle] = useState("");
  const [notice, setNotice] = useState<{ threadId?: string; removeReplacement?: boolean; message: string }>();
  const [archivePendingId, setArchivePendingId] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const menuButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const renameDialogRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const archivedCount = props.threads.filter((thread) => thread.archivedAt !== undefined).length;
  const groups = useMemo(() => projectDesktopWorkNavigator({
    threads: props.threads,
    projects: props.projects,
    navigation: props.navigation ?? {},
    archived: view === "archived",
    query,
  }).groups, [props.threads, props.projects, props.navigation, query, view]);
  const creationProjects = useMemo(() => projectDesktopWorkNavigator({
    threads: props.threads,
    projects: props.projects,
    navigation: props.navigation ?? {},
    archived: false,
  }).groups.filter((group) => group.kind === "project"), [props.threads, props.projects, props.navigation]);

  useEffect(() => {
    if (props.newConversationRequestId > 0) {
      setView("active");
      setProjectPickerOpen(true);
    }
  }, [props.newConversationRequestId]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    projectPickerRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectPickerOpen(false);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(projectPickerRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (items.length > 0 && index >= 0) {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [projectPickerOpen]);

  useEffect(() => {
    if (openMenuId === undefined) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) !== true
        && menuButtons.current[openMenuId]?.contains(event.target as Node) !== true) {
        closeMenu(openMenuId);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(openMenuId);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (items.length > 0 && index >= 0) {
          event.preventDefault();
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (renamingThread === undefined) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRename();
      keepFocusInsideDialog(event, renameDialogRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [renamingThread]);

  function closeMenu(threadId: string): void {
    setOpenMenuId(undefined);
    requestAnimationFrame(() => menuButtons.current[threadId]?.focus());
  }

  function beginRename(thread: RendererThread): void {
    setOpenMenuId(undefined);
    setRenameTitle(thread.title);
    setRenamingThread(thread);
  }

  function closeRename(): void {
    const threadId = renamingThread?.id;
    setRenamingThread(undefined);
    if (threadId !== undefined) requestAnimationFrame(() => menuButtons.current[threadId]?.focus());
  }

  async function archive(thread: RendererThread): Promise<void> {
    if (archivePendingId !== undefined) return;
    setOpenMenuId(undefined);
    setArchivePendingId(thread.id);
    setNotice({ message: `Checking “${thread.title}”…` });
    try {
      const result = await props.onArchive(thread.id);
      if (result.status === "blocked") {
        setNotice({ message: result.message });
        return;
      }
      setNotice({
        threadId: thread.id,
        removeReplacement: props.activeThreadId === thread.id
          && props.threads.filter((candidate) => candidate.archivedAt === undefined).length === 1,
        message: `Archived “${thread.title}”.`,
      });
    } finally {
      setArchivePendingId(undefined);
    }
  }

  return (
    <section className="conversation-explorer" aria-label="Conversation explorer">
      <div className="explorer-heading">
        <div className="explorer-view-navigation" aria-label="Conversation views">
          <button className={view === "active" ? "active" : ""} type="button" onClick={() => setView("active")}>Conversations</button>
          <button className={view === "archived" ? "active" : ""} type="button" onClick={() => setView("archived")}>
            <Archive size={14} aria-hidden="true" />Archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </button>
        </div>
        <div className="explorer-heading-actions">
          <button
            className="icon-button"
            type="button"
            title="New conversation"
            aria-label="New conversation"
            aria-haspopup="menu"
            aria-expanded={projectPickerOpen}
            onClick={() => setProjectPickerOpen((open) => !open)}
          >
            <Plus size={17} />
          </button>
        </div>
      </div>
      {projectPickerOpen ? (
        <div ref={projectPickerRef} className="explorer-project-picker" role="menu" aria-label="Choose a project for the new conversation">
          <strong>New conversation in</strong>
          {creationProjects.map((project) => (
            <button key={project.projectPath} type="button" role="menuitem" onClick={() => {
              setProjectPickerOpen(false);
              props.onNewConversation(project.projectPath!);
            }}>{project.label}</button>
          ))}
          <button type="button" role="menuitem" onClick={() => {
            setProjectPickerOpen(false);
            props.onNewConversation(null);
          }}>No project</button>
          <button className="explorer-add-project" type="button" role="menuitem" onClick={() => {
            setProjectPickerOpen(false);
            void props.onAddProjectAndCreate();
          }}><FolderPlus size={14} aria-hidden="true" />Add Project…</button>
        </div>
      ) : null}
      <label className="explorer-search">
        <Search size={14} aria-hidden="true" />
        <input ref={props.searchInputRef} aria-label="Search conversations" type="search" value={query} placeholder="Search conversations" onChange={(event) => setQuery(event.target.value)} />
        {query.length > 0 ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={13} /></button> : null}
      </label>

      {notice !== undefined ? (
        <div className="explorer-notice" role="status">
          <span>{notice.message}</span>
          {notice.threadId !== undefined ? (
            <button type="button" onClick={() => {
              props.onUndoArchive(notice.threadId!, notice.removeReplacement === true);
              setView("active");
              setNotice(undefined);
            }}>Undo</button>
          ) : null}
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(undefined)}><X size={12} /></button>
        </div>
      ) : null}

      <div className="explorer-groups">
        {groups.map((group) => {
          const collapsed = collapsedGroups.has(group.key) && query.length === 0;
          return (
            <section className="explorer-group" key={group.key}>
              <div className={`explorer-group-heading ${group.projectPath === props.selectedProjectPath ? "selected" : ""}`}>
                <button
                  className="explorer-group-toggle"
                  type="button"
                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                    return next;
                  })}
                ><ChevronDown size={13} aria-hidden="true" /></button>
                {group.projectPath !== undefined ? (
                  <button className="explorer-project-select" type="button" title={group.projectPath} onClick={() => props.onSelectProject(group.projectPath!)}>
                    <span>{group.label}</span>
                    <small>{group.summary.total}</small>
                  </button>
                ) : (
                  <span className="explorer-project-label"><span>{group.label}</span><small>{group.summary.total}</small></span>
                )}
                {view === "active" && group.kind !== "unavailable-project" ? (
                  <button
                    className="explorer-project-create"
                    type="button"
                    title={`New conversation in ${group.label}`}
                    aria-label={`New conversation in ${group.label}`}
                    onClick={() => props.onNewConversation(group.projectPath ?? null)}
                  ><Plus size={14} /></button>
                ) : null}
              </div>
              {!collapsed ? (
                <div className="explorer-thread-list">
                  {group.threads.map(({ thread, status, updatedAt }) => (
                    <div className={`explorer-thread-row ${thread.id === props.activeThreadId ? "active" : ""}`} key={thread.id}>
                      <button className="explorer-thread-select" type="button" title={thread.title} aria-label={`Open conversation: ${thread.title}`} onClick={() => props.onSelect(thread.id)}>
                        <span className={`explorer-thread-status status-${status}`} role="img" aria-label={`Conversation status: ${status}`} />
                        <span className="explorer-thread-copy"><strong>{thread.title}</strong></span>
                        <time>{formatThreadTime(updatedAt)}</time>
                      </button>
                      <button
                        className="explorer-thread-menu-button"
                        ref={(element) => { menuButtons.current[thread.id] = element; }}
                        type="button"
                        aria-label={`Conversation actions for ${thread.title}`}
                        aria-haspopup="menu"
                        aria-expanded={openMenuId === thread.id}
                        onClick={() => setOpenMenuId((current) => current === thread.id ? undefined : thread.id)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {openMenuId === thread.id ? (
                        <div className="explorer-thread-menu" ref={menuRef} role="menu" aria-label={`Actions for ${thread.title}`}>
                          {thread.archivedAt === undefined ? <>
                            <button type="button" role="menuitem" onClick={() => beginRename(thread)}>Rename</button>
                            <button type="button" role="menuitem" disabled={archivePendingId !== undefined} onClick={() => void archive(thread)}>Archive</button>
                          </> : <button type="button" role="menuitem" onClick={() => { setOpenMenuId(undefined); props.onRestore(thread.id); setView("active"); }}>Restore</button>}
                          <button type="button" role="menuitem" onClick={() => { setOpenMenuId(undefined); setDeleteForceRequired(false); setDeleteMessage(undefined); setDeletingThread(thread); }}>Delete conversation</button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
        {groups.length === 0 ? <p className="rail-empty">{query.length > 0 ? "No matching conversations" : view === "archived" ? "No archived conversations" : "No conversations"}</p> : null}
      </div>

      {renamingThread !== undefined ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeRename();
        }}>
          <div className="rename-dialog" ref={renameDialogRef} role="dialog" aria-modal="true" aria-labelledby="rename-conversation-title">
            <h2 id="rename-conversation-title">Rename conversation</h2>
            <form onSubmit={(event) => {
              event.preventDefault();
              if (renameTitle.trim().length === 0) return;
              props.onRename(renamingThread.id, renameTitle);
              closeRename();
            }}>
              <label>Conversation title<input ref={renameInputRef} maxLength={MAX_RENDERER_THREAD_TITLE_LENGTH} value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} /></label>
              {renameTitle.trim().length === 0 ? <p className="field-error">Enter a conversation title.</p> : null}
              <div className="dialog-actions">
                <button type="button" onClick={closeRename}>Cancel</button>
                <button className="primary-button" type="submit" disabled={renameTitle.trim().length === 0}>Save</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {deletingThread !== undefined ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeletingThread(undefined);
        }}>
          <div className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title">
            <h2 id="delete-conversation-title">Delete conversation?</h2>
            <p>This permanently removes “{deletingThread.title}” from Kestrel Desktop. If work is still running, Kestrel stops its authoritative run first. This cannot be undone.</p>
            {deleteMessage !== undefined ? <p className="field-error">{deleteMessage}</p> : null}
            <div className="dialog-actions">
              <button type="button" disabled={deletePending} onClick={() => setDeletingThread(undefined)}>Cancel</button>
              <button className="danger-button" type="button" disabled={deletePending} onClick={() => void (async () => {
                setDeletePending(true);
                try {
                  const result = await props.onDelete(deletingThread.id, deleteForceRequired);
                  if (result.status === "deleted") {
                    setDeletingThread(undefined);
                    return;
                  }
                  setDeleteForceRequired(true);
                  setDeleteMessage(result.message);
                } catch (cause) {
                  setDeleteMessage(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setDeletePending(false);
                }
              })()}>{deleteForceRequired ? "Force remove from Desktop" : "Delete conversation"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatThreadTime(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
