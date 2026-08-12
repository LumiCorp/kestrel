import { LogsAdminClient } from "@/app/(workspace)/settings/organization/audit/page-client";
import { getAdminLogStats, listRecentAdminEvents } from "@/lib/admin/logs";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationAuditPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const [events, stats] = await Promise.all([
    listRecentAdminEvents(organizationId, 25),
    getAdminLogStats(organizationId),
  ]);
  return (
    <LogsAdminClient
      initialEvents={events.map((event) => ({
        id: event.id,
        level: event.level,
        category: event.category,
        action: event.action,
        message: event.message,
        createdAt: event.createdAt.toISOString(),
      }))}
      initialStats={{
        ...stats,
        oldestLog: stats.oldestLog?.toISOString() ?? null,
        newestLog: stats.newestLog?.toISOString() ?? null,
      }}
    />
  );
}
