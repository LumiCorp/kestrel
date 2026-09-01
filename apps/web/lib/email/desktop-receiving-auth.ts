import { authorizeDesktopUser } from "@/lib/desktop-account";
import {
  canManageOrganization,
  canReadOrganization,
} from "@/lib/knowledge/organization-access";

export async function requireDesktopReceivingMember(
  request: Request,
  organizationId: string,
) {
  const { user } = await authorizeDesktopUser(request);
  if (!(await canReadOrganization({ organizationId, userId: user.id }))) {
    throw new Error("Forbidden");
  }
  return user;
}

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
