import { notFound } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  ProjectHomeClient,
  type ProjectHomeData,
} from "@/components/projects/project-home-client";
import { listVisibleProjectDesktopWorkspaceCatalog } from "@/lib/environments/desktop";
import { listOrganizationEnvironments } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectDetail } from "@/lib/projects/store";
import { listThreadsForUser } from "@/lib/threads/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { and, eq, gt } from "drizzle-orm";

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
  const [threads, environments, projectWorkspace, previews] = await Promise.all(
    [
      listThreadsForUser(session.user.id, organizationId, {
        projectId: id,
        includeArchived: true,
        limit: 100,
      }),
      listOrganizationEnvironments(organizationId),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, organizationId),
            eq(table.projectId, id),
            eq(table.environmentId, detail.project.environmentId),
            isNull(table.deletedAt),
          ),
      }),
      knowledgeDb.query.workspacePreviewLeases.findMany({
        where: and(
          eq(schema.workspacePreviewLeases.projectId, id),
          eq(schema.workspacePreviewLeases.organizationId, organizationId),
          eq(schema.workspacePreviewLeases.targetProvider, "desktop"),
          eq(schema.workspacePreviewLeases.status, "active"),
          gt(schema.workspacePreviewLeases.expiresAt, new Date()),
        ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      }),
    ],
  );
  const desktopCatalog = await listVisibleProjectDesktopWorkspaceCatalog({
    organizationId,
    role: detail.role,
    desktopCatalogId: projectWorkspace?.desktopCatalogId,
  });
  const initial: ProjectHomeData = {
    project: {
      ...detail.project,
      archivedAt: detail.project.archivedAt?.toISOString() ?? null,
    },
    environments: environments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      region: environment.region,
      provider: environment.provider,
      status: environment.status,
    })),
    desktopCatalog: desktopCatalog.map((workspace) => ({
      id: workspace.id,
      environmentId: workspace.environmentId,
      label: workspace.label,
      availability: workspace.availability,
    })),
    desktopCatalogId: projectWorkspace?.desktopCatalogId ?? null,
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
    previews: previews.map((preview) => ({
      id: preview.id,
      name: preview.name ?? "Desktop preview",
      expiresAt: preview.expiresAt.toISOString(),
    })),
  };
  return (
    <AppPage>
      <ProjectHomeClient initial={initial} />
    </AppPage>
  );
}
