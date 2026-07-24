import { notFound } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  ProjectHomeClient,
  type ProjectHomeData,
} from "@/components/projects/project-home-client";
import { listOrganizationEnvironments } from "@/lib/environments/store";
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
  const [threads, environments] = await Promise.all([
    listThreadsForUser(session.user.id, organizationId, {
      projectId: id,
      includeArchived: true,
      limit: 100,
    }),
    listOrganizationEnvironments(organizationId),
  ]);
  const initial: ProjectHomeData = {
    project: {
      ...detail.project,
      archivedAt: detail.project.archivedAt?.toISOString() ?? null,
    },
    environments: environments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      region: environment.region,
      status: environment.status,
    })),
    role: detail.role,
    contextRevision: detail.contextRevision
      ? { instructions: detail.contextRevision.instructions }
      : null,
    documents: detail.documents,
    organizationDocuments: detail.organizationDocuments,
    members: detail.members,
    organizationMembers: detail.organizationMembers,
    auditEvents: detail.auditEvents.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      createdAt: event.createdAt.toISOString(),
    })),
    threads: threads.map((thread) => ({
      id: thread.id,
      title: thread.title || "New thread",
      updatedAt: thread.updatedAt.toISOString(),
      archivedAt: thread.archivedAt?.toISOString() ?? null,
      canManage:
        detail.role === "owner" ||
        detail.role === "editor" ||
        thread.createdByUserId === session.user.id,
    })),
  };
  return (
    <AppPage>
      <ProjectHomeClient initial={initial} />
    </AppPage>
  );
}
