import { notFound } from "next/navigation";
import { PageContainer } from "@/components/app-page";
import { type EditableWorkflow, WorkflowEditor } from "@/components/workflows/workflow-editor";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { ProjectAccessError } from "@/lib/projects/access";
import { listProjectsForUser } from "@/lib/projects/store";
import { getProjectWorkflowForUser } from "@/lib/workflows/store";

export default async function WorkflowEditorPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params;
  const { organizationId, session } = await requireActiveOrganization();
  const [projectRows, row] = await Promise.all([
    listProjectsForUser({ organizationId, userId: session.user.id }),
    workflowId === "new"
      ? Promise.resolve(null)
      : getProjectWorkflowForUser({
          organizationId,
          userId: session.user.id,
          workflowId,
        }).catch((error: unknown) => {
          if (
            error instanceof ProjectAccessError &&
            error.code === "PROJECT_NOT_FOUND"
          ) {
            return null;
          }
          throw error;
        }),
  ]);
  if (workflowId !== "new" && !row) notFound();
  const initialWorkflow: EditableWorkflow | null = row ? {
    id: row.id,
    project: row.project,
    title: row.title,
    description: row.description,
    modelId: row.modelId,
    enabled: row.enabled,
    currentVersion: row.currentVersion,
    definition: row.definition,
    permissions: row.permissions,
  } : null;
  const projects = projectRows.map(({ project, role }) => ({
    id: project.id,
    name: project.name,
    canCreateWorkflow: role === "owner" || role === "editor",
  }));
  return (
    <PageContainer
      className="h-full p-0 sm:p-0 lg:p-0"
      contentClassName="h-full max-w-none"
    >
      <WorkflowEditor initialWorkflow={initialWorkflow} projects={projects} />
    </PageContainer>
  );
}
