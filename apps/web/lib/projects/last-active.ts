const LAST_ACTIVE_PROJECT_COOKIE_PREFIX = "kestrel_last_project_";

export function getLastActiveProjectCookieName(organizationId: string) {
  return `${LAST_ACTIVE_PROJECT_COOKIE_PREFIX}${organizationId}`;
}
