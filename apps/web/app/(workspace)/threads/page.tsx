import { Archive, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { listThreadsForUser } from "@/lib/threads/store";

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

  return (
    <AppPage className="mx-auto w-full max-w-5xl p-6">
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
      {threads.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {threads.map((thread) => (
            <Link href={`/threads/${thread.id}`} key={thread.id}>
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <MessageSquare className="size-4" />
                    {thread.title || "New thread"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground text-sm">
                  Updated {thread.updatedAt.toLocaleString()}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {showArchived
              ? "No archived standalone Threads."
              : "Start a standalone Thread, or open a Project to work with shared context."}
          </CardContent>
        </Card>
      )}
    </AppPage>
  );
}
