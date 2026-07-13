import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import type { SerializedSessionRecord, Session } from "@/lib/auth-types";
import { dbClient } from "@/lib/db-client";
import UserCard from "../user-card";
import { GithubConnectionCard } from "./github-connection-card";

export default async function UserPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect("/sign-in");
  }

  // Get active sessions for the user
  const activeSessions = await dbClient
    .selectFrom("session")
    .selectAll()
    .where("userId", "=", session.user.id)
    .where("expiresAt", ">", new Date())
    .orderBy("createdAt", "desc")
    .execute();

  return (
    <AppPage>
      <AdminPageHeader
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/api-keys">Personal API Keys</Link>
          </Button>
        }
        description="Manage your account settings, active sessions, and workspace preferences."
        eyebrow="Account"
        title="User Settings"
      />

      <UserCard
        activeSessions={activeSessions.map(
          (s): SerializedSessionRecord => ({
            id: s.id,
            token: s.token,
            expiresAt: s.expiresAt.toISOString(),
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
            ipAddress: s.ipAddress || null,
            userAgent: s.userAgent || null,
            userId: s.userId,
            activeOrganizationId:
              (s as { activeOrganizationId?: string | null })
                .activeOrganizationId || null,
            impersonatedBy:
              (s as { impersonatedBy?: string | null }).impersonatedBy || null,
          })
        )}
        session={session as Session}
      />
      <GithubConnectionCard />
    </AppPage>
  );
}
