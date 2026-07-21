import { Archive, Plus } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { ThreadIndex } from "@/components/threads/thread-index";
import { Button } from "@/components/ui/button";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  getThreadUnreadCountsForUser,
  listThreadsForUser,
} from "@/lib/threads/store";

export default async function ThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const showArchived = (await searchParams).archived === "true";
  const { organizationId, session } = await requireActiveOrganization();
  const allThreads = await listThreadsForUser(session.user.id, organizationId, {
    projectId: null,
    limit: 100,
    includeArchived: showArchived,
  });
  const threads = showArchived
    ? allThreads.filter((thread) => Boolean(thread.archivedAt))
    : allThreads;
  const unreadCounts = await getThreadUnreadCountsForUser({
    userId: session.user.id,
    organizationId,
    threadIds: threads.map((thread) => thread.id),
  });

  return (
    <AppPage className="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-semibold text-3xl">Threads</h1>
          <p className="mt-1 text-muted-foreground">
            Your standalone conversations. Project conversations stay with their
            shared workspace.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={showArchived ? "/threads" : "/threads?archived=true"}>
              <Archive className="size-4" />
              {showArchived ? "Active" : "Archived"}
            </Link>
          </Button>
          <Button asChild>
            <Link href="/threads/new">
              <Plus className="size-4" /> New Thread
            </Link>
          </Button>
        </div>
      </div>
      <ThreadIndex
        archived={showArchived}
        threads={threads.map((thread) => ({
          id: thread.id,
          title: thread.title || "New thread",
          updatedAt: thread.updatedAt.toISOString(),
          unreadCount: unreadCounts.get(thread.id) ?? 0,
        }))}
      />
    </AppPage>
  );
}
