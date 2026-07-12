import { notFound } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  ProjectHomeClient,
  type ProjectHomeData,
} from "@/components/projects/project-home-client";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectDetail } from "@/lib/projects/store";
import { listThreadsForUser } from "@/lib/threads/store";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organizationId, session } = await requireActiveOrganization();
  const detail = await getProjectDetail({
    projectId: id,
    organizationId,
    userId: session.user.id,
    includeArchived: true,
  }).catch(() => null);
  if (!detail) notFound();
  const threads = await listThreadsForUser(session.user.id, organizationId, {
    projectId: id,
    includeArchived: true,
    limit: 100,
  });
  const initial: ProjectHomeData = {
    project: {
      ...detail.project,
      archivedAt: detail.project.archivedAt?.toISOString() ?? null,
    },
    role: detail.role,
    contextRevision: detail.contextRevision
      ? { instructions: detail.contextRevision.instructions }
      : null,
    documents: detail.documents,
    organizationDocuments: detail.organizationDocuments,
    members: detail.members,
    organizationMembers: detail.organizationMembers,
    threads: threads.map((thread) => ({
      id: thread.id,
      title: thread.title || "New thread",
      updatedAt: thread.updatedAt.toISOString(),
      archivedAt: thread.archivedAt?.toISOString() ?? null,
    })),
  };
  return (
    <AppPage className="mx-auto w-full max-w-6xl p-6">
      <header>
        <p className="text-muted-foreground text-sm capitalize">
          {detail.role} · context revision{" "}
          {detail.project.currentContextRevision}
        </p>
        <h1 className="font-semibold text-3xl">{detail.project.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {detail.project.description || "Shared Project workspace"}
        </p>
      </header>
      <ProjectHomeClient initial={initial} />
    </AppPage>
  );
}
