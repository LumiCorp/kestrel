import { Archive } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { ProjectsIndexClient } from "@/components/projects/projects-index-client";
import { Button } from "@/components/ui/button";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { resolveMobileProjectReturn } from "@/lib/projects/mobile-return";
import { listProjectsForUser } from "@/lib/projects/store";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{
    archived?: string;
    source?: string;
    returnTo?: string;
  }>;
}) {
  const params = await searchParams;
  const showArchived = params.archived === "true";
  const mobileReturnTo = resolveMobileProjectReturn(params);
  const { organizationId, session } = await requireActiveOrganization();
  const rows = await listProjectsForUser({
    organizationId,
    userId: session.user.id,
    includeArchived: showArchived,
  });
  const visibleRows = showArchived
    ? rows.filter(({ project }) => Boolean(project.archivedAt))
    : rows;
  return (
    <AppPage className="mx-auto w-full max-w-6xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-semibold text-3xl">Projects</h1>
          <p className="mt-1 text-muted-foreground">
            Shared workspaces with revisioned instructions, private files, and
            collaborative Threads.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={showArchived ? "/projects" : "/projects?archived=true"}>
            <Archive className="size-4" />
            {showArchived ? "Active" : "Archived"}
          </Link>
        </Button>
      </div>
      <ProjectsIndexClient
        allowCreate={!showArchived}
        mobileReturnTo={mobileReturnTo}
        projects={visibleRows.map(({ project, role }) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          role,
          updatedAt: project.updatedAt.toISOString(),
        }))}
      />
    </AppPage>
  );
}
