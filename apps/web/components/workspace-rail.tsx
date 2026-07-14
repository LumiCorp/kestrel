"use client";

import {
  Activity,
  BookOpenText,
  ChevronDown,
  FolderOpen,
  House,
  MessageSquare,
  Plus,
  Search,
  Users,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
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
  const searchParams = useSearchParams();
  const routeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const routeThreadId = pathname.match(/^\/threads\/([^/]+)/)?.[1];
  const { data: projects } = useSWR<ProjectsResponse>("/api/projects", fetcher);
  const { data: threads } = useSWR<ThreadsResponse>(
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
  const visibleThreads = activeProjectId
    ? threads?.threads.filter((thread) => thread.projectId === activeProjectId)
    : [];
  const newThreadHref = activeProjectId
    ? `/projects/${activeProjectId}/threads/new`
    : "/projects";

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

  const projectSwitcher = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-10 w-full justify-start gap-2 px-2 font-medium"
          variant="ghost"
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeProject?.name ?? "Choose a Project"}
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
      <aside className="hidden h-dvh w-72 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="border-b p-3">{projectSwitcher}</div>
        <div className="space-y-3 border-b p-3">
          <Button asChild className="w-full justify-start">
            <Link href={newThreadHref}>
              <Plus className="size-4" /> New Thread
            </Link>
          </Button>
          <div className="relative">
            <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search this Project"
              className="pl-8"
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const query = event.currentTarget.value.trim();
                if (!query) return;
                const projectScope = activeProjectId
                  ? `&projectId=${encodeURIComponent(activeProjectId)}`
                  : "";
                window.location.assign(
                  `/search?q=${encodeURIComponent(query)}${projectScope}`
                );
              }}
              placeholder="Search threads"
            />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <section className="space-y-1 p-3">
            <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-wide">
              Recent Threads
            </div>
            {visibleThreads?.length ? (
              visibleThreads.map((thread) => (
                <Link
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent",
                    pathname === `/threads/${thread.id}` &&
                      "bg-sidebar-accent text-sidebar-accent-foreground"
                  )}
                  href={`/threads/${thread.id}`}
                  key={thread.id}
                >
                  <MessageSquare className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {thread.title || "New thread"}
                  </span>
                </Link>
              ))
            ) : (
              <p className="px-2 py-2 text-muted-foreground text-sm">
                {activeProjectId
                  ? "No Threads in this Project yet."
                  : "Choose a Project to see its Threads."}
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
