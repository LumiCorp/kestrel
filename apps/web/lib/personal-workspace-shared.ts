const PERSONAL_WORKSPACE_PREFIX = "personal-";

export function isPersonalOrganizationSlug(slug?: string | null) {
  return typeof slug === "string" && slug.startsWith(PERSONAL_WORKSPACE_PREFIX);
}

export function isPersonalOrganization(
  organization?: { slug?: string | null } | null
) {
  return isPersonalOrganizationSlug(organization?.slug);
}
