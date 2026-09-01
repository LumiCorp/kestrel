import { AppPage } from "@/components/app-page";
import { type WorkflowRunView, WorkflowRunClient } from "@/components/workflows/workflow-run-client";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectWorkflowRunForUser } from "@/lib/workflows/store";

export default async function WorkflowRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { organizationId, session } = await requireActiveOrganization();
  const row = await getProjectWorkflowRunForUser({ runId, organizationId, userId: session.user.id });
  const run: WorkflowRunView = {
    id: row.id,
    status: row.status,
    output: row.output,
    failureMessage: row.failureMessage,
    definition: row.definition,
    workflow: row.workflow,
    steps: row.steps.map((step) => ({
      id: step.id,
      nodeId: step.nodeId,
      status: step.status,
      input: step.input,
      output: step.output,
      threadId: step.threadId,
      failureMessage: step.failureMessage,
      turnFailureMessage: step.turnFailureMessage,
    })),
  };
  return <AppPage><WorkflowRunClient initialRun={run} /></AppPage>;
}
