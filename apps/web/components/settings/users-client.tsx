"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { SettingsPage, SettingsPageHeader } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimeText } from "@/components/ui/time-text";
import {
  deleteAdminUserAction,
  updateAdminUserRoleAction,
} from "@/app/admin/users/actions";

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  chatCount: number;
  messageCount: number;
  lastSeenAt: string | null;
};

export function UsersAdminClient({
  currentUserId,
  initialUsers,
}: {
  currentUserId: string;
  initialUsers: AdminUser[];
}) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [query, setQuery] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  useEffect(() => {
    setUsers(initialUsers);
  }, [initialUsers]);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return users;
    }

    return users.filter((user) =>
      [user.name, user.email, user.role].some((value) =>
        value?.toLowerCase().includes(q)
      )
    );
  }, [query, users]);

  async function updateRole(userId: string, role: "admin" | "user") {
    setBusyUserId(userId);
    const result = await updateAdminUserRoleAction({
      role,
      userId,
    });
    setBusyUserId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setUsers((current) =>
      current.map((user) => (user.id === userId ? { ...user, role } : user))
    );
    toast.success(result.message || "User role updated.");
  }

  async function deleteUser(userId: string) {
    setBusyUserId(userId);
    const result = await deleteAdminUserAction({
      userId,
    });
    setBusyUserId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setUsers((current) => current.filter((user) => user.id !== userId));
    toast.success(result.message || "User deleted.");
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Inspect account activity, review chat usage, and manage admin role assignment."
        eyebrow="Admin"
        title="Users"
      />

      <div className="flex flex-col gap-3 border-y py-4 md:flex-row md:items-center md:justify-between">
        <Input
          className="max-w-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, email, or role"
          value={query}
        />
        <div className="text-muted-foreground text-sm">
          {visibleUsers.length} of {users.length} user(s)
        </div>
      </div>
      <AdminDataTable
        columns={[
          { key: "user", label: "User" },
          { key: "role", label: "Role" },
          { key: "activity", label: "Activity" },
          { key: "lastSeen", label: "Last Seen" },
          { key: "actions", label: "Actions", className: "text-right" },
        ]}
        empty={
          <AdminEmptyState
            description="No users match the current query."
            title="No matching users"
          />
        }
        rows={visibleUsers.map((user) => {
          const isCurrentUser = user.id === currentUserId;

          return {
            user: (
              <div className="space-y-1">
                <div className="font-medium">{user.name}</div>
                <div className="text-muted-foreground text-sm">
                  {user.email}
                </div>
              </div>
            ),
            role: (
              <Badge variant={user.role === "admin" ? "default" : "outline"}>
                {user.role}
              </Badge>
            ),
            activity: (
              <div className="text-sm">
                {user.chatCount} chats · {user.messageCount} messages
              </div>
            ),
            lastSeen: (
              <div className="text-muted-foreground text-sm">
                <TimeText mode="relative" value={user.lastSeenAt} />
              </div>
            ),
            actions: isCurrentUser ? (
              <div className="text-muted-foreground text-sm">Current user</div>
            ) : (
              <div className="flex justify-end gap-2">
                <Button
                  disabled={busyUserId === user.id}
                  onClick={() =>
                    void updateRole(
                      user.id,
                      user.role === "admin" ? "user" : "admin"
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  {user.role === "admin" ? "Make User" : "Make Admin"}
                </Button>
                <Button
                  disabled={busyUserId === user.id}
                  onClick={() => void deleteUser(user.id)}
                  size="sm"
                  variant="destructive"
                >
                  Delete
                </Button>
              </div>
            ),
          };
        })}
      />
    </SettingsPage>
  );
}
