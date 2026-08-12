import Link from "next/link";
import { PageContainer } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";

export default async function OrganizationWelcomePage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [organization, membership, readiness, canManage] = await Promise.all([
    knowledgeDb.query.organizations.findFirst({
      where: (table, { eq }) => eq(table.id, organizationId),
      columns: { name: true },
    }),
    knowledgeDb.query.members.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, organizationId),
          eq(table.userId, session.user.id),
        ),
      columns: { role: true },
    }),
    getOrganizationChatReadiness(organizationId),
    canManageOrganization({ organizationId, userId: session.user.id }),
  ]);

  return (
    <PageContainer
      className="flex min-h-full items-center py-12"
      contentClassName="max-w-xl"
    >
      <section className="w-full space-y-6">
        <header className="space-y-2">
          <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">
            Welcome to {organization?.name || "your organization"}
          </h1>
          <p className="text-muted-foreground text-sm/6">
            You joined as {membership?.role || "a member"}.
          </p>
        </header>
        <div className="space-y-4 border-y py-5">
          {readiness.ready ? (
            <p className="text-muted-foreground text-sm">
              Everything is ready for your first Thread.
            </p>
          ) : (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 text-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <p>{readiness.modelAccess.detail}</p>
              {canManage ? (
                <p className="mt-2">
                  Complete organization setup before starting the first Thread.
                </p>
              ) : (
                <p className="mt-2">
                  An organization owner or admin needs to finish setup before
                  you can start a Thread.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {readiness.ready ? (
            <Button asChild>
              <Link href="/threads/new">Start a Thread</Link>
            </Button>
          ) : null}
          {canManage && !readiness.ready ? (
            <Button asChild>
              <Link href="/organization/setup">Set up organization</Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link href="/threads">View Threads</Link>
          </Button>
        </div>
      </section>
    </PageContainer>
  );
}
