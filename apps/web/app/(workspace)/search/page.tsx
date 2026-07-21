import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { searchWorkspace } from "@/lib/search";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; projectId?: string }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const projectId = params.projectId?.trim() || undefined;
  const { organizationId, session } = await requireActiveOrganization();
  const results = await searchWorkspace({
    organizationId,
    userId: session.user.id,
    query,
    projectId,
  });

  return (
    <AppPage className="max-w-5xl">
      <header>
        <h1 className="font-semibold text-3xl">Search</h1>
        <p className="mt-1 text-muted-foreground">
          {projectId
            ? "Results are scoped to the active Project."
            : "Authorized Projects, Threads, and message text are ranked within their own groups."}
        </p>
        {projectId ? (
          <Link
            className="mt-2 inline-block text-sm underline-offset-4 hover:underline"
            href={query ? `/search?q=${encodeURIComponent(query)}` : "/search"}
          >
            Search all Projects
          </Link>
        ) : null}
      </header>
      <form>
        {projectId ? (
          <input name="projectId" type="hidden" value={projectId} />
        ) : null}
        <Input
          aria-label="Search workspace"
          autoFocus
          defaultValue={query}
          name="q"
          placeholder="Search your workspace"
        />
      </form>
      {query && (
        <div className="grid gap-6">
          <section>
            <h2 className="mb-2 font-semibold text-lg">Projects</h2>
            <div className="grid gap-2">
              {results.projects.map((project) => (
                <Link
                  href={`/projects/${String(project.id)}`}
                  key={String(project.id)}
                >
                  <Card className="hover:bg-muted/40">
                    <CardHeader>
                      <CardTitle className="text-base">
                        {String(project.name)}
                      </CardTitle>
                    </CardHeader>
                    {Boolean(project.description) && (
                      <CardContent className="text-muted-foreground text-sm">
                        {String(project.description)}
                      </CardContent>
                    )}
                  </Card>
                </Link>
              ))}
              {!results.projects.length && (
                <p className="text-muted-foreground text-sm">
                  No matching Projects.
                </p>
              )}
            </div>
          </section>
          <section>
            <h2 className="mb-2 font-semibold text-lg">Threads</h2>
            <div className="grid gap-2">
              {results.threads.map((thread) => (
                <Link
                  href={`/threads/${String(thread.id)}`}
                  key={String(thread.id)}
                >
                  <Card className="hover:bg-muted/40">
                    <CardContent className="py-4 font-medium">
                      {String(thread.title || "New thread")}
                    </CardContent>
                  </Card>
                </Link>
              ))}
              {!results.threads.length && (
                <p className="text-muted-foreground text-sm">
                  No matching Threads.
                </p>
              )}
            </div>
          </section>
          <section>
            <h2 className="mb-2 font-semibold text-lg">Messages</h2>
            <div className="grid gap-2">
              {results.messages.map((message) => (
                <Link
                  href={`/threads/${String(message.threadId)}#message-${String(message.id)}`}
                  key={String(message.id)}
                >
                  <Card className="hover:bg-muted/40">
                    <CardContent className="space-y-1 py-4">
                      <p className="font-medium">
                        {String(message.threadTitle || "New thread")}
                      </p>
                      <p className="line-clamp-3 text-muted-foreground text-sm">
                        {String(message.searchText || "")}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
              {!results.messages.length && (
                <p className="text-muted-foreground text-sm">
                  No matching messages.
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </AppPage>
  );
}
