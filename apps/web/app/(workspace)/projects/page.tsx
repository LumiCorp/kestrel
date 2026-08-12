import { Archive, Plus } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
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
  const createHref = mobileReturnTo
    ? `/projects/new?source=mobile&returnTo=${encodeURIComponent(mobileReturnTo)}`
    : "/projects/new";
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
    <AppPage>
      <PageHeader
        actions={
          <>
            <Button asChild variant="outline">
              <Link
                href={showArchived ? "/projects" : "/projects?archived=true"}
              >
                <Archive className="size-4" />
                {showArchived ? "Active" : "Archived"}
              </Link>
            </Button>
            {showArchived ? null : (
              <Button asChild>
                <Link href={createHref}>
                  <Plus className="size-4" /> New Project
                </Link>
              </Button>
            )}
          </>
        }
        description="Shared workspaces with revisioned instructions, private files, and collaborative Threads."
        title="Projects"
      />
      <ProjectsIndexClient
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
