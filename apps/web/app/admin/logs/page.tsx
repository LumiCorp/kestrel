import { getAdminLogStats, listRecentAdminEvents } from "@/lib/admin/logs";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { LogsAdminClient } from "./page-client";

export default async function AdminLogsPage() {
  const { organizationId } = await requireAdminOrganization();
  const recentEvents = (await listRecentAdminEvents(organizationId, 25)).map(
    (event) => ({
      id: event.id,
      level: event.level,
      category: event.category,
      action: event.action,
      message: event.message,
      createdAt: event.createdAt.toISOString(),
    })
  );
  const stats = await getAdminLogStats(organizationId);

  return (
    <LogsAdminClient
      initialEvents={recentEvents}
      initialStats={{
        ...stats,
        oldestLog: stats.oldestLog?.toISOString() ?? null,
        newestLog: stats.newestLog?.toISOString() ?? null,
      }}
    />
  );
}
