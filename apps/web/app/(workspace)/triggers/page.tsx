import { AppPage } from "@/components/app-page";
import {
  EmailTriggersClient,
  type EmailTriggerProjectOption,
  type EmailTriggerSummary,
} from "@/components/email-triggers/email-triggers-client";
import { listProjectEmailTriggersForUser } from "@/lib/email-triggers/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { listProjectsForUser } from "@/lib/projects/store";

export default async function EmailTriggersPage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [triggers, projectRows] = await Promise.all([
    listProjectEmailTriggersForUser({
      organizationId,
      userId: session.user.id,
    }),
    listProjectsForUser({ organizationId, userId: session.user.id }),
  ]);
  const projects: EmailTriggerProjectOption[] = projectRows.map(
    ({ project, role }) => ({
      id: project.id,
      name: project.name,
      role,
      canCreateTrigger: role === "owner" || role === "editor",
    }),
  );
  const serialized: EmailTriggerSummary[] = triggers.map((trigger) => ({
    ...trigger,
    rotatedAt: trigger.rotatedAt?.toISOString() ?? null,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  }));
  return (
    <AppPage>
      <EmailTriggersClient projects={projects} triggers={serialized} />
    </AppPage>
  );
}
