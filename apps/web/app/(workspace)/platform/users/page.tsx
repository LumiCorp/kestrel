import { listAdminUsers } from "@/lib/admin/users";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";
import { UsersAdminClient } from "@/components/settings/users-client";

export default async function AdminUsersPage() {
  const { session } = await requireAuthenticatedShell({
    requireAdmin: true,
    requireActiveOrganization: true,
  });
  const initialUsers = (await listAdminUsers()).map((user) => ({
    ...user,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
  }));

  return (
    <UsersAdminClient
      currentUserId={session.user.id}
      initialUsers={initialUsers}
    />
  );
}
