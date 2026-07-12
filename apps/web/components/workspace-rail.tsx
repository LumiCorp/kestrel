"use client";

import { FolderOpen, MessageSquare, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
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

export function WorkspaceRail() {
  const pathname = usePathname();
  const routeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const routeThreadId = pathname.match(/^\/threads\/([^/]+)/)?.[1];
  const { data: projects } = useSWR<ProjectsResponse>("/api/projects", fetcher);
  const { data: threads } = useSWR<ThreadsResponse>(
    "/api/threads?limit=30",
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
  const visibleThreads = activeProjectId
    ? threads?.threads.filter((thread) => thread.projectId === activeProjectId)
    : threads?.threads.filter((thread) => thread.projectId === null);

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
        <Button asChild size="sm" variant="outline">
          <Link
            href={
              activeProjectId
                ? `/projects/${activeProjectId}/threads/new`
                : "/threads/new"
            }
          >
            <Plus className="size-4" /> New Thread
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/projects">Projects</Link>
        </Button>
      </div>
      <aside className="hidden h-dvh w-72 shrink-0 flex-col border-r bg-muted/20 md:flex">
        <div className="space-y-3 border-b p-3">
          <Button asChild className="w-full justify-start">
            <Link
              href={
                activeProjectId
                  ? `/projects/${activeProjectId}/threads/new`
                  : "/threads/new"
              }
            >
              <Plus className="size-4" /> New Thread
            </Link>
          </Button>
          <div className="relative">
            <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search workspace"
              className="pl-8"
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.currentTarget.value.trim()) {
                  window.location.assign(
                    `/search?q=${encodeURIComponent(event.currentTarget.value.trim())}`
                  );
                }
              }}
              placeholder="Search"
            />
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-6 p-3">
            <section className="space-y-1">
              <div className="flex items-center justify-between px-2 text-muted-foreground text-xs uppercase tracking-wide">
                <span>Projects</span>
                <Button asChild size="icon" variant="ghost">
                  <Link href="/projects">
                    <Plus className="size-3.5" />
                    <span className="sr-only">Projects</span>
                  </Link>
                </Button>
              </div>
              {projects?.projects.map(({ project }) => (
                <Link
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                    activeProjectId === project.id && "bg-accent"
                  )}
                  href={`/projects/${project.id}`}
                  key={project.id}
                >
                  <FolderOpen className="size-4 shrink-0" />
                  <span className="truncate">{project.name}</span>
                </Link>
              ))}
            </section>
            <section className="space-y-1">
              <div className="px-2 text-muted-foreground text-xs uppercase tracking-wide">
                {activeProjectId ? "Project Threads" : "Standalone Threads"}
              </div>
              {visibleThreads?.length ? (
                visibleThreads.map((thread) => (
                  <Link
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      pathname === `/threads/${thread.id}` && "bg-accent"
                    )}
                    href={`/threads/${thread.id}`}
                    key={thread.id}
                  >
                    <MessageSquare className="size-4 shrink-0" />
                    <span className="truncate">{thread.title}</span>
                  </Link>
                ))
              ) : (
                <p className="px-2 py-2 text-muted-foreground text-sm">
                  No threads yet.
                </p>
              )}
            </section>
          </div>
        </ScrollArea>
      </aside>
    </>
  );
}
