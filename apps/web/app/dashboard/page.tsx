import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect("/sign-in");
  }

  return (
    <AppPage>
      <AdminPageHeader
        description="Manage your personal workspace, account settings, and organization access from a single shell."
        eyebrow="Workspace"
        title="Dashboard"
      />

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>User Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-muted-foreground">
              Manage your account, sessions, and preferences.
            </p>
            <Link
              className="font-medium text-primary hover:underline"
              href="/dashboard/user"
            >
              Go to User Settings →
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Organizations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-muted-foreground">
              Manage your organizations, members, invitations, and billing.
            </p>
            <Link
              className="font-medium text-primary hover:underline"
              href="/dashboard/organizations"
            >
              Go to Organizations →
            </Link>
          </CardContent>
        </Card>
      </div>
    </AppPage>
  );
}
