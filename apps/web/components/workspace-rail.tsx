"use client";

import {
  Activity,
  Archive,
  ArrowDownUp,
  BookOpenText,
  BookMarked,
  ChevronDown,
  Circle,
  FolderOpen,
  House,
  MoreHorizontal,
  Plus,
  Search,
  Users,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  filterAndSortThreads,
  type ThreadSort,
} from "@/components/threads/thread-list-model";
import { cn, fetcher } from "@/lib/utils";

type ProjectsResponse = {
  projects: Array<{
    project: { id: string; name: string; updatedAt: string };
    role: "owner" | "editor" | "member";
  }>;
};

type ThreadsResponse = {
  threads: Array<{
    id: string;
    title: string;
    projectId: string | null;
    updatedAt: string;
    unreadCount: number;
  }>;
};

type ThreadDetailResponse = {
  id: string;
  projectId: string | null;
};

const projectSections = [
  { label: "Overview", tab: null, icon: House },
  { label: "Context", tab: "context", icon: BookOpenText },
  { label: "Apps", tab: "apps", icon: Waypoints },
  { label: "Skills", tab: "skills", icon: BookMarked },
  { label: "Members", tab: "members", icon: Users },
  { label: "Activity", tab: "activity", icon: Activity },
] as const;

function isWorkPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/threads") ||
    pathname.startsWith("/projects") ||
    pathname.startsWith("/search")
  );
}

export function WorkspaceRail({ organizationId }: { organizationId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [threadQuery, setThreadQuery] = useState("");
  const [threadSort, setThreadSort] = useState<ThreadSort>("recent");
  const projectRouteSegment = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const routeProjectId =
    projectRouteSegment && projectRouteSegment !== "new"
      ? projectRouteSegment
      : undefined;
  const routeThreadId = pathname.match(/^\/threads\/([^/]+)/)?.[1];
  const { data: projects } = useSWR<ProjectsResponse>("/api/projects", fetcher);
  const { data: threads, mutate: mutateThreads } = useSWR<ThreadsResponse>(
    "/api/threads?limit=100",
    fetcher
  );
  const { data: threadDetail } = useSWR<ThreadDetailResponse>(
    routeThreadId && routeThreadId !== "new"
      ? `/api/threads/${routeThreadId}`
      : null,
    fetcher,
    { errorRetryCount: 5, errorRetryInterval: 500 }
  );
  const threadProjectId =
    threadDetail?.projectId ??
    threads?.threads.find((thread) => thread.id === routeThreadId)?.projectId;
  const activeProjectId = routeProjectId ?? threadProjectId ?? undefined;
  const activeProject = projects?.projects.find(
    ({ project }) => project.id === activeProjectId
  )?.project;
  const projectThreads = useMemo(
    () =>
      activeProjectId
        ? (threads?.threads.filter(
            (thread) => thread.projectId === activeProjectId
          ) ?? [])
        : (threads?.threads.filter((thread) => thread.projectId === null) ?? []),
    [activeProjectId, threads?.threads]
  );
  const visibleThreads = useMemo(
    () => filterAndSortThreads(projectThreads, threadQuery, threadSort),
    [projectThreads, threadQuery, threadSort]
  );
  const newThreadHref = activeProjectId
    ? `/projects/${activeProjectId}/threads/new`
    : "/threads/new";

  useEffect(() => {
    if (!activeProjectId) return;
    void fetch("/api/projects/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: activeProjectId }),
    });
  }, [activeProjectId, organizationId]);

  if (!isWorkPath(pathname)) return null;

  const projectWorkHref = (projectId: string) => {
    const latestThread = threads?.threads.find(
      (thread) => thread.projectId === projectId
    );
    return latestThread
      ? `/threads/${latestThread.id}`
      : `/projects/${projectId}/threads/new`;
  };

  async function archiveThread(threadId: string) {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    if (!response.ok) {
      toast.error("Thread could not be archived");
      return;
    }
    await mutateThreads(
      (current) =>
        current
          ? {
              ...current,
              threads: current.threads.filter(
                (thread) => thread.id !== threadId
              ),
            }
          : current,
      { revalidate: false }
    );
    toast.success("Thread archived");
    if (pathname === `/threads/${threadId}`) {
      router.replace(
        activeProjectId ? `/projects/${activeProjectId}` : "/threads"
      );
    }
  }

  const projectSwitcher = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-10 w-full justify-start gap-2 px-2 font-medium"
          variant="ghost"
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeProject?.name ?? "Standalone Threads"}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        {projects?.projects.map(({ project }) => (
          <DropdownMenuItem asChild key={project.id}>
            <Link href={projectWorkHref(project.id)}>
              <FolderOpen className="size-4" />
              <span className="truncate">{project.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {projects?.projects.length ? null : (
          <DropdownMenuItem disabled>No Projects yet</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/projects">
            <Plus className="size-4" />
            Create or manage Projects
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
        <div className="min-w-0 flex-1">{projectSwitcher}</div>
        <Button asChild size="sm">
          <Link href={newThreadHref}>
            <Plus className="size-4" /> New Thread
          </Link>
        </Button>
      </div>
      <aside className="hidden h-full min-h-0 w-72 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="border-b p-3">{projectSwitcher}</div>
        <div className="space-y-2 border-b p-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="Filter recent threads"
                className="pl-8"
                onChange={(event) => setThreadQuery(event.target.value)}
                placeholder="Filter threads"
                value={threadQuery}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild aria-label="New Thread" size="icon">
                  <Link href={newThreadHref}>
                    <Plus className="size-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">New Thread</TooltipContent>
            </Tooltip>
          </div>
          <label className="flex items-center gap-2 text-muted-foreground text-xs">
            <ArrowDownUp className="size-3.5" />
            <span className="sr-only">Sort threads</span>
            <select
              aria-label="Sort threads"
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) =>
                setThreadSort(event.target.value as ThreadSort)
              }
              value={threadSort}
            >
              <option value="recent">Recently updated</option>
              <option value="unread">Unread first</option>
              <option value="title">Title</option>
              <option value="oldest">Oldest updated</option>
            </select>
          </label>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <section className="space-y-1 p-3">
            <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-wide">
              Recent Threads
            </div>
            {visibleThreads?.length ? (
              visibleThreads.map((thread) => (
                <div
                  className={cn(
                    "group/thread flex items-center rounded-md transition-colors hover:bg-sidebar-accent",
                    pathname === `/threads/${thread.id}` &&
                      "bg-sidebar-accent text-sidebar-accent-foreground"
                  )}
                  key={thread.id}
                >
                  <Link
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm"
                    href={`/threads/${thread.id}`}
                  >
                    <span
                      aria-hidden={thread.unreadCount > 0 ? undefined : true}
                      className="flex size-4 shrink-0 items-center justify-center"
                    >
                      {thread.unreadCount > 0 ? (
                        <>
                          <Circle
                            aria-hidden="true"
                            className="size-2 fill-primary text-primary"
                          />
                          <span className="sr-only">New message</span>
                        </>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        thread.unreadCount > 0 && "font-medium"
                      )}
                    >
                      {thread.title || "New thread"}
                    </span>
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Thread actions for ${thread.title || "New thread"}`}
                        className="mr-1 size-7 opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 data-[state=open]:opacity-100"
                        size="icon"
                        variant="ghost"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="right">
                      <DropdownMenuItem
                        onSelect={() => void archiveThread(thread.id)}
                      >
                        <Archive className="size-4" /> Archive thread
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))
            ) : (
              <p className="px-2 py-2 text-muted-foreground text-sm">
                {threadQuery
                  ? "No Threads match this filter."
                  : activeProjectId
                    ? "No Threads in this Project yet."
                    : "No standalone Threads yet."}
              </p>
            )}
          </section>
        </ScrollArea>
        {activeProjectId ? (
          <section className="space-y-1 border-t p-3">
            <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-wide">
              Project
            </div>
            {projectSections.map((section) => {
              const href = section.tab
                ? `/projects/${activeProjectId}?tab=${section.tab}`
                : `/projects/${activeProjectId}`;
              const isActive =
                pathname === `/projects/${activeProjectId}` &&
                (section.tab === null
                  ? !searchParams.get("tab")
                  : searchParams.get("tab") === section.tab);

              return (
                <Link
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                    isActive &&
                      "bg-sidebar-accent text-sidebar-accent-foreground"
                  )}
                  href={href}
                  key={section.label}
                >
                  <section.icon className="size-4 shrink-0" />
                  <span>{section.label}</span>
                </Link>
              );
            })}
          </section>
        ) : null}
      </aside>
    </>
  );
}
