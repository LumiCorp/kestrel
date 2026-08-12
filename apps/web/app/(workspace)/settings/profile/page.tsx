import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SettingsPage, SettingsPageHeader } from "@/components/settings/settings-section";
import { auth } from "@/lib/auth";
import type { SerializedSessionRecord, Session } from "@/lib/auth-types";
import { dbClient } from "@/lib/db-client";
import UserCard from "@/components/settings/profile-client";

export default async function ProfileSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  const activeSessions = await dbClient
    .selectFrom("session")
    .selectAll()
    .where("userId", "=", session.user.id)
    .where("expiresAt", ">", new Date())
    .orderBy("createdAt", "desc")
    .execute();

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Manage your account, active sessions, and personal preferences."
        eyebrow="Personal"
        title="Profile"
      />
      <UserCard
        activeSessions={activeSessions.map(
          (record): SerializedSessionRecord => ({
            id: record.id,
            token: record.token,
            expiresAt: record.expiresAt.toISOString(),
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            ipAddress: record.ipAddress || null,
            userAgent: record.userAgent || null,
            userId: record.userId,
            activeOrganizationId:
              (record as { activeOrganizationId?: string | null })
                .activeOrganizationId || null,
            impersonatedBy:
              (record as { impersonatedBy?: string | null }).impersonatedBy ||
              null,
          })
        )}
        session={session as Session}
      />
    </SettingsPage>
  );
}
