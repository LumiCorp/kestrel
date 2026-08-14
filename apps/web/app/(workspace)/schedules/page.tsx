import { AppPage } from "@/components/app-page";
import {
  SchedulesClient,
  type ScheduleProjectOption,
  type ScheduleSummary,
} from "@/components/schedules/schedules-client";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { listProjectsForUser } from "@/lib/projects/store";
import { listProjectPromptSchedulesForUser } from "@/lib/schedules/store";

export default async function SchedulesPage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [schedules, projectRows] = await Promise.all([
    listProjectPromptSchedulesForUser({
      organizationId,
      userId: session.user.id,
    }),
    listProjectsForUser({ organizationId, userId: session.user.id }),
  ]);
  const projects: ScheduleProjectOption[] = projectRows.map(
    ({ project, role }) => ({
      id: project.id,
      name: project.name,
      role,
      canCreateSchedule: role === "owner" || role === "editor",
    }),
  );
  const serialized: ScheduleSummary[] = schedules.map((schedule) => ({
    ...schedule,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
    latestRun: schedule.latestRun
      ? {
          ...schedule.latestRun,
          scheduledFor: schedule.latestRun.scheduledFor.toISOString(),
          catchUpFrom: schedule.latestRun.catchUpFrom?.toISOString() ?? null,
        }
      : null,
  }));
  return (
    <AppPage>
      <SchedulesClient projects={projects} schedules={serialized} />
    </AppPage>
  );
}
