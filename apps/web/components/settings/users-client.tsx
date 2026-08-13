"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TimeText } from "@/components/ui/time-text";
import {
  deleteAdminUserAction,
  updateAdminUserRoleAction,
} from "@/app/(workspace)/platform/users/actions";

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
  const [pendingAction, setPendingAction] = useState<{
    user: AdminUser;
    kind: "role" | "delete";
  } | null>(null);

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
    setPendingAction(null);
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
    setPendingAction(null);
    toast.success(result.message || "User deleted.");
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Inspect account activity, review chat usage, and manage admin role assignment."
        eyebrow="Platform"
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
          query ? (
            <AdminEmptyState
              description="No users match the current query."
              title="No matching users"
            />
          ) : (
            <SettingsStatusNotice
              description="Accounts appear here after their first successful sign-in."
              title="No platform users"
            />
          )
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`Actions for ${user.name}`}
                    disabled={busyUserId === user.id}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setPendingAction({ kind: "role", user })}
                  >
                    {user.role === "admin" ? (
                      <UserRound className="size-4" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    {user.role === "admin" ? "Make user" : "Make admin"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => setPendingAction({ kind: "delete", user })}
                  >
                    <Trash2 className="size-4" /> Delete user
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          };
        })}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || busyUserId)) setPendingAction(null);
        }}
        open={Boolean(pendingAction)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "delete"
                ? `Delete ${pendingAction.user.name}?`
                : `Change ${pendingAction?.user.name}'s platform role?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "delete"
                ? "This removes the account and its platform access. This action cannot be undone."
                : `Their role will change to ${pendingAction?.user.role === "admin" ? "user" : "admin"} immediately.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyUserId)}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={Boolean(busyUserId)}
              onClick={() => {
                if (!pendingAction) return;
                if (pendingAction.kind === "delete") {
                  void deleteUser(pendingAction.user.id);
                  return;
                }
                void updateRole(
                  pendingAction.user.id,
                  pendingAction.user.role === "admin" ? "user" : "admin",
                );
              }}
              variant={
                pendingAction?.kind === "delete" ? "destructive" : "default"
              }
            >
              {busyUserId
                ? "Updating…"
                : pendingAction?.kind === "delete"
                  ? "Delete user"
                  : "Change role"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}
import { MoreHorizontal, ShieldCheck, Trash2, UserRound } from "lucide-react";
