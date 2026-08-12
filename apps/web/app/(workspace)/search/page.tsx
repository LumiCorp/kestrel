import { X } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimeText } from "@/components/ui/time-text";
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
  const resultCount =
    results.projects.length + results.threads.length + results.messages.length;
  const clearScopeHref = query
    ? `/search?q=${encodeURIComponent(query)}`
    : "/search";

  return (
    <AppPage className="max-w-5xl">
      <PageHeader
        description="Find authorized Projects, Threads, and messages. Results stay grouped by resource type."
        status={
          projectId ? (
            <Button asChild size="sm" variant="secondary">
              <Link aria-label="Clear Project scope" href={clearScopeHref}>
                Project scoped
                <X className="size-3.5" />
              </Link>
            </Button>
          ) : undefined
        }
        title="Search"
      />
      <form className="max-w-3xl">
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
      {query ? (
        resultCount > 0 ? (
          <div className="space-y-8">
            {results.projects.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-semibold text-base">
                  Projects{" "}
                  <span className="text-muted-foreground">
                    {results.projects.length}
                  </span>
                </h2>
                <ResourceList>
                  {results.projects.map((project) => (
                    <ResourceRow
                      description={
                        project.description
                          ? String(project.description)
                          : undefined
                      }
                      href={`/projects/${String(project.id)}`}
                      key={String(project.id)}
                      metadata={
                        <>
                          <span className="capitalize">
                            {String(project.role)}
                          </span>
                          <span aria-hidden="true"> · </span>
                          Updated{" "}
                          <TimeText
                            mode="relative"
                            value={String(project.updatedAt)}
                          />
                        </>
                      }
                      title={String(project.name)}
                    />
                  ))}
                </ResourceList>
              </section>
            ) : null}
            {results.threads.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-semibold text-base">
                  Threads{" "}
                  <span className="text-muted-foreground">
                    {results.threads.length}
                  </span>
                </h2>
                <ResourceList>
                  {results.threads.map((thread) => (
                    <ResourceRow
                      href={`/threads/${String(thread.id)}`}
                      key={String(thread.id)}
                      metadata={
                        <>
                          Updated{" "}
                          <TimeText
                            mode="relative"
                            value={String(thread.updatedAt)}
                          />
                        </>
                      }
                      title={String(thread.title || "New thread")}
                    />
                  ))}
                </ResourceList>
              </section>
            ) : null}
            {results.messages.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-semibold text-base">
                  Messages{" "}
                  <span className="text-muted-foreground">
                    {results.messages.length}
                  </span>
                </h2>
                <ResourceList>
                  {results.messages.map((message) => (
                    <ResourceRow
                      description={
                        <span className="line-clamp-3">
                          {String(message.searchText || "")}
                        </span>
                      }
                      href={`/threads/${String(message.threadId)}#message-${String(message.id)}`}
                      key={String(message.id)}
                      metadata={
                        <>
                          Sent{" "}
                          <TimeText
                            mode="relative"
                            value={String(message.createdAt)}
                          />
                        </>
                      }
                      title={String(message.threadTitle || "New thread")}
                    />
                  ))}
                </ResourceList>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="border-y">
            <ResourceEmpty
              description={
                projectId
                  ? "Try a broader term or clear the Project scope."
                  : "Try a broader term."
              }
              title={`No results for “${query}”`}
            />
          </div>
        )
      ) : null}
    </AppPage>
  );
}
