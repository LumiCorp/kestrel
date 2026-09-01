import { AppPage } from "@/components/app-page";
import { type WorkflowSummary, WorkflowsClient } from "@/components/workflows/workflows-client";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { listProjectsForUser } from "@/lib/projects/store";
import { listProjectWorkflowsForUser } from "@/lib/workflows/store";

export default async function WorkflowsPage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [rows, projects] = await Promise.all([
    listProjectWorkflowsForUser({ organizationId, userId: session.user.id }),
    listProjectsForUser({ organizationId, userId: session.user.id }),
  ]);
  const workflows: WorkflowSummary[] = rows.map((workflow) => ({
    id: workflow.id,
    project: workflow.project,
    title: workflow.title,
    description: workflow.description,
    modelId: workflow.modelId,
    currentVersion: workflow.currentVersion,
    state: workflow.state,
    hasDraft: workflow.hasDraft,
    attentionMessage: workflow.attentionMessage,
    enabled: workflow.enabled,
    cronExpression: workflow.cronExpression,
    timeZone: workflow.timeZone,
    nextRunAt: workflow.nextRunAt?.toISOString() ?? null,
    definition: workflow.definition,
    permissions: workflow.permissions,
    latestRun: workflow.latestRun
      ? { id: workflow.latestRun.id, status: workflow.latestRun.status, createdAt: workflow.latestRun.createdAt.toISOString() }
      : null,
  }));
  return <AppPage><WorkflowsClient canCreate={projects.some(({ role }) => role === "owner" || role === "editor")} workflows={workflows} /></AppPage>;
}
