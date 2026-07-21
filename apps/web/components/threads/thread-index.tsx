"use client";

import { Archive, ArrowDownUp, MessageSquare, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  filterAndSortThreads,
  type ThreadListItem,
  type ThreadSort,
} from "./thread-list-model";

export function ThreadIndex({
  threads,
  archived,
}: {
  threads: ThreadListItem[];
  archived: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ThreadSort>("recent");
  const visibleThreads = useMemo(
    () => filterAndSortThreads(threads, query, sort),
    [query, sort, threads]
  );

  async function setArchived(threadId: string, nextArchived: boolean) {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: nextArchived }),
    });
    if (!response.ok) {
      toast.error(`Thread could not be ${nextArchived ? "archived" : "restored"}`);
      return;
    }
    toast.success(nextArchived ? "Thread archived" : "Thread restored");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Filter threads"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title"
            value={query}
          />
        </div>
        <label className="flex items-center gap-2">
          <ArrowDownUp className="size-4 text-muted-foreground" />
          <span className="sr-only">Sort threads</span>
          <select
            aria-label="Sort threads"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setSort(event.target.value as ThreadSort)}
            value={sort}
          >
            <option value="recent">Recently updated</option>
            <option value="unread">Unread first</option>
            <option value="title">Title</option>
            <option value="oldest">Oldest updated</option>
          </select>
        </label>
      </div>

      <div className="divide-y border-y">
        {visibleThreads.map((thread) => (
          <div className="flex items-center gap-3 py-3" key={thread.id}>
            <Link
              className="group flex min-w-0 flex-1 items-center gap-3"
              href={`/threads/${thread.id}`}
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium text-sm group-hover:text-primary">
                {thread.title}
              </span>
              {!archived && thread.unreadCount > 0 ? (
                <span className="rounded-full bg-primary px-2 py-0.5 font-semibold text-[10px] text-primary-foreground tabular-nums">
                  {thread.unreadCount} unread
                </span>
              ) : null}
              <time className="hidden shrink-0 text-muted-foreground text-xs sm:block">
                {new Date(thread.updatedAt).toLocaleString()}
              </time>
            </Link>
            <Button
              aria-label={`${archived ? "Restore" : "Archive"} ${thread.title}`}
              onClick={() => void setArchived(thread.id, !archived)}
              size="sm"
              variant="ghost"
            >
              <Archive className="size-4" />
              {archived ? "Restore" : "Archive"}
            </Button>
          </div>
        ))}
        {visibleThreads.length === 0 ? (
          <p className="py-12 text-center text-muted-foreground text-sm">
            {query
              ? "No Threads match this filter."
              : archived
                ? "No archived standalone Threads."
                : "Start a standalone Thread, or open a Project to work with shared context."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
