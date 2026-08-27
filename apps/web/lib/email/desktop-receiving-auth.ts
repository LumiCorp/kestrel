import { authorizeDesktopUser } from "@/lib/desktop-account";
import { canManageOrganization } from "@/lib/knowledge/organization-access";

export async function requireDesktopReceivingAdmin(
  request: Request,
  organizationId: string,
) {
  const { user } = await authorizeDesktopUser(request);
  if (!(await canManageOrganization({ organizationId, userId: user.id }))) {
    throw new Error("Forbidden");
  }
  return user;
}
