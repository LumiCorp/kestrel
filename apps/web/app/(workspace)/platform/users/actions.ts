"use server";

import type { ActionResult } from "@/lib/actions";
import { deleteAdminUser, updateAdminUserRole } from "@/lib/admin/users";
import { getActiveOrganizationId, requireAdmin } from "@/lib/knowledge/auth";

export async function updateAdminUserRoleAction(input: {
  role: "admin" | "user";
  userId: string;
}): Promise<ActionResult> {
  try {
    const session = await requireAdmin();
    const actorUserId = session.user.id;
    const organizationId = getActiveOrganizationId(session);

    await updateAdminUserRole({
      actorUserId,
      organizationId,
      role: input.role,
      userId: input.userId,
    });

    return {
      ok: true,
      message: "User role updated.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to update role",
    };
  }
}

export async function deleteAdminUserAction(input: {
  userId: string;
}): Promise<ActionResult> {
  try {
    const session = await requireAdmin();
    const actorUserId = session.user.id;
    const organizationId = getActiveOrganizationId(session);

    await deleteAdminUser({
      actorUserId,
      organizationId,
      userId: input.userId,
    });

    return {
      ok: true,
      message: "User deleted.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to delete user",
    };
  }
}
