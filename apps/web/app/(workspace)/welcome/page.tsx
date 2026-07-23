import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WelcomeWorkspaceSwitcher } from "@/components/welcome-workspace-switcher";
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
    <div className="mx-auto flex min-h-full w-full max-w-2xl items-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>
            Welcome to {organization?.name || "your organization"}
          </CardTitle>
          <CardDescription>
            You joined as {membership?.role || "a member"}. Your personal
            workspace remains available from the organization switcher.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {readiness.ready ? (
            <p className="text-muted-foreground text-sm">
              Your organization is ready for a new Thread.
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
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {readiness.ready ? (
            <Button asChild>
              <Link href="/threads/new">Start a Thread</Link>
            </Button>
          ) : null}
          {canManage && !readiness.ready ? (
            <Button asChild>
              <Link href="/settings/organization/setup">
                Set up organization
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/threads">View Threads</Link>
          </Button>
          <WelcomeWorkspaceSwitcher activeOrganizationId={organizationId} />
        </CardFooter>
      </Card>
    </div>
  );
}
