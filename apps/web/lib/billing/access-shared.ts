export function canManageOrganizationBillingRole(input: {
  isPersonalOrganization: boolean;
  role?: string | null;
}) {
  if (input.isPersonalOrganization) {
    return false;
  }

  return input.role === "owner" || input.role === "admin";
}
