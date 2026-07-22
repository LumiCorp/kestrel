import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { OrganizationChatReadiness } from "@/lib/organizations/chat-readiness";

export function OrganizationReadinessBanner({
  canManage,
  readiness,
}: {
  canManage: boolean;
  readiness: OrganizationChatReadiness;
}) {
  if (!readiness.applicable || readiness.ready) return null;
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b bg-amber-50 px-4 py-3 text-amber-950 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:bg-amber-950/30 dark:text-amber-100"
      role="status"
    >
      <div>
        <p className="font-medium text-sm">Organization setup is incomplete</p>
        <p className="text-xs opacity-80">
          {canManage
            ? "Finish the minimum model, Fly, and Environment setup to start new agent turns."
            : "Waiting for an organization admin. Existing chats remain available."}
        </p>
      </div>
      {canManage ? (
        <Button asChild className="shrink-0" size="sm" variant="outline">
          <Link href="/settings/organization/setup">Finish setup</Link>
        </Button>
      ) : null}
    </div>
  );
}
