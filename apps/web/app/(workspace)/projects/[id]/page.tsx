import { notFound } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  ProjectHomeClient,
  type ProjectHomeData,
} from "@/components/projects/project-home-client";
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
  const [threads, previews] = await Promise.all([
      listThreadsForUser(session.user.id, organizationId, {
        projectId: id,
        includeArchived: true,
        limit: 100,
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
    ]);
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
