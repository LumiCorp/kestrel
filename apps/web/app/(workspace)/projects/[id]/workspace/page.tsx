import { notFound } from "next/navigation";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectAccess } from "@/lib/projects/access";
import { ProjectWorkspaceClient } from "./workspace-client";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organizationId, session } = await requireActiveOrganization();
  const access = await getProjectAccess({
    projectId: id,
    organizationId,
    userId: session.user.id,
  });
  if (!access) notFound();
  return (
    <ProjectWorkspaceClient
      canEdit={access.role === "owner" || access.role === "editor"}
      projectId={id}
      projectName={access.project.name}
    />
  );
}
