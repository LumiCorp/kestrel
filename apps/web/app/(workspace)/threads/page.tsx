import { Plus } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { ThreadIndex } from "@/components/threads/thread-index";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      <PageHeader
        actions={
          <Button asChild>
            <Link href="/threads/new">
              <Plus className="size-4" /> New Thread
            </Link>
          </Button>
        }
        description="Standalone conversations. Project conversations stay with their shared workspace."
        status={
          <span className="text-muted-foreground text-xs">
            {threads.length} {showArchived ? "archived" : "active"}
          </span>
        }
        title="Threads"
      />
      <Tabs value={showArchived ? "archived" : "active"}>
        <TabsList>
          <TabsTrigger asChild value="active">
            <Link href="/threads">Active</Link>
          </TabsTrigger>
          <TabsTrigger asChild value="archived">
            <Link href="/threads?archived=true">Archived</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
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
