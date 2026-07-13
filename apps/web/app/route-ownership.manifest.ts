export type KestrelOneRouteOwner =
  | "admin"
  | "agent-config"
  | "artifacts"
  | "auth"
  | "credential-boundary"
  | "projects"
  | "dashboard"
  | "debug"
  | "dev"
  | "environments"
  | "files"
  | "health"
  | "integrations"
  | "knowledge"
  | "media"
  | "messages"
  | "models"
  | "public"
  | "runtime-tools"
  | "sandbox"
  | "snapshot"
  | "sources"
  | "stats"
  | "sync"
  | "threads"
  | "tool-boundary"
  | "webhook";

export type KestrelOneRouteKind = "api" | "page";

export type KestrelOneRouteAccess =
  | "admin"
  | "authenticated"
  | "dev-only"
  | "public"
  | "service-boundary"
  | "tool-boundary"
  | "webhook";

export type KestrelOneUnauthorizedBehavior =
  | "admin-denied"
  | "api-unauthorized"
  | "bearer-or-session"
  | "dev-not-found"
  | "public"
  | "redirect-sign-in"
  | "service-bearer"
  | "webhook-validation";

export interface KestrelOneRouteOwnershipEntry {
  readonly file: string;
  readonly route: string;
  readonly kind: KestrelOneRouteKind;
  readonly owner: KestrelOneRouteOwner;
  readonly access: KestrelOneRouteAccess;
  readonly unauthorized: KestrelOneUnauthorizedBehavior;
  readonly primaryNavigation?: boolean;
}

// biome-ignore lint/nursery/useMaxParams: compact manifest declarations keep route ownership auditable.
function page(
  file: string,
  route: string,
  owner: KestrelOneRouteOwner,
  access: KestrelOneRouteAccess,
  unauthorized: KestrelOneUnauthorizedBehavior,
  options?: { primaryNavigation?: boolean }
): KestrelOneRouteOwnershipEntry {
  return {
    file,
    route,
    kind: "page",
    owner,
    access,
    unauthorized,
    ...options,
  };
}

// biome-ignore lint/nursery/useMaxParams: compact manifest declarations keep route ownership auditable.
function api(
  file: string,
  route: string,
  owner: KestrelOneRouteOwner,
  access: KestrelOneRouteAccess,
  unauthorized: KestrelOneUnauthorizedBehavior
): KestrelOneRouteOwnershipEntry {
  return { file, route, kind: "api", owner, access, unauthorized };
}

const PUBLIC_AUTH_PAGE = {
  owner: "auth",
  access: "public",
  unauthorized: "public",
} as const;

const ADMIN_PAGE = {
  owner: "admin",
  access: "admin",
  unauthorized: "admin-denied",
} as const;

const ADMIN_API = {
  owner: "admin",
  access: "admin",
  unauthorized: "admin-denied",
} as const;

const AUTHENTICATED_API = {
  access: "authenticated",
  unauthorized: "api-unauthorized",
} as const;

export const KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST = [
  page("app/page.tsx", "/", "public", "public", "public"),
  page(
    "app/(auth)/forget-password/page.tsx",
    "/forget-password",
    PUBLIC_AUTH_PAGE.owner,
    PUBLIC_AUTH_PAGE.access,
    PUBLIC_AUTH_PAGE.unauthorized
  ),
  page(
    "app/(auth)/reset-password/page.tsx",
    "/reset-password",
    PUBLIC_AUTH_PAGE.owner,
    PUBLIC_AUTH_PAGE.access,
    PUBLIC_AUTH_PAGE.unauthorized
  ),
  page(
    "app/(auth)/sign-in/page.tsx",
    "/sign-in",
    PUBLIC_AUTH_PAGE.owner,
    PUBLIC_AUTH_PAGE.access,
    PUBLIC_AUTH_PAGE.unauthorized
  ),
  page(
    "app/(auth)/two-factor/otp/page.tsx",
    "/two-factor/otp",
    PUBLIC_AUTH_PAGE.owner,
    PUBLIC_AUTH_PAGE.access,
    PUBLIC_AUTH_PAGE.unauthorized
  ),
  page(
    "app/(auth)/two-factor/page.tsx",
    "/two-factor",
    PUBLIC_AUTH_PAGE.owner,
    PUBLIC_AUTH_PAGE.access,
    PUBLIC_AUTH_PAGE.unauthorized
  ),
  page(
    "app/accept-invitation/[id]/page.tsx",
    "/accept-invitation/:id",
    "auth",
    "public",
    "public"
  ),
  page(
    "app/shared/[token]/page.tsx",
    "/shared/:token",
    "public",
    "public",
    "public"
  ),

  page(
    "app/(workspace)/page.tsx",
    "/",
    "threads",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/threads/page.tsx",
    "/threads",
    "threads",
    "authenticated",
    "redirect-sign-in",
    { primaryNavigation: true }
  ),
  page(
    "app/(workspace)/threads/new/page.tsx",
    "/threads/new",
    "threads",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/threads/[id]/page.tsx",
    "/threads/:id",
    "threads",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/threads/[id]/workspace/page.tsx",
    "/threads/:id/workspace",
    "environments",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/projects/page.tsx",
    "/projects",
    "projects",
    "authenticated",
    "redirect-sign-in",
    { primaryNavigation: true }
  ),
  page(
    "app/(workspace)/projects/[id]/page.tsx",
    "/projects/:id",
    "projects",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/projects/[id]/workspace/page.tsx",
    "/projects/:id/workspace",
    "environments",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/projects/[id]/threads/new/page.tsx",
    "/projects/:id/threads/new",
    "projects",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/search/page.tsx",
    "/search",
    "threads",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/(workspace)/settings/environments/page.tsx",
    "/settings/environments",
    "environments",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/dashboard/page.tsx",
    "/dashboard",
    "dashboard",
    "authenticated",
    "redirect-sign-in",
    { primaryNavigation: true }
  ),
  page(
    "app/dashboard/api-keys/page.tsx",
    "/dashboard/api-keys",
    "dashboard",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/dashboard/billing/page.tsx",
    "/dashboard/billing",
    "dashboard",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/dashboard/organizations/page.tsx",
    "/dashboard/organizations",
    "dashboard",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/dashboard/user/page.tsx",
    "/dashboard/user",
    "dashboard",
    "authenticated",
    "redirect-sign-in"
  ),
  page(
    "app/knowledge/page.tsx",
    "/knowledge",
    "knowledge",
    "authenticated",
    "redirect-sign-in",
    { primaryNavigation: true }
  ),
  page(
    "app/knowledge/import/page.tsx",
    "/knowledge/import",
    "knowledge",
    "authenticated",
    "redirect-sign-in"
  ),

  page(
    "app/admin/page.tsx",
    "/admin",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized,
    {
      primaryNavigation: true,
    }
  ),
  page(
    "app/admin/agent/page.tsx",
    "/admin/agent",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/api-keys/page.tsx",
    "/admin/api-keys",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/billing/page.tsx",
    "/admin/billing",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/docs/page.tsx",
    "/admin/docs",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/docs/[slug]/page.tsx",
    "/admin/docs/:slug",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/environments/page.tsx",
    "/admin/environments",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/gateways/page.tsx",
    "/admin/gateways",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/logs/page.tsx",
    "/admin/logs",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/stats/page.tsx",
    "/admin/stats",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/tools/page.tsx",
    "/admin/tools",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page(
    "app/admin/users/page.tsx",
    "/admin/users",
    ADMIN_PAGE.owner,
    ADMIN_PAGE.access,
    ADMIN_PAGE.unauthorized
  ),
  page("app/debug/page.tsx", "/debug", "debug", "admin", "admin-denied"),
  page(
    "app/debug/sandbox/page.tsx",
    "/debug/sandbox",
    "debug",
    "admin",
    "admin-denied"
  ),

  api("app/api/health/route.ts", "/api/health", "health", "public", "public"),
  api(
    "app/api/auth/[...all]/route.ts",
    "/api/auth/:path*",
    "auth",
    "public",
    "public"
  ),
  api(
    "app/api/shared/[token]/route.ts",
    "/api/shared/:token",
    "public",
    "public",
    "public"
  ),
  api(
    "app/api/dev/auto-login/route.ts",
    "/api/dev/auto-login",
    "dev",
    "dev-only",
    "dev-not-found"
  ),
  api(
    "app/api/webhooks/[platform]/route.ts",
    "/api/webhooks/:platform",
    "webhook",
    "webhook",
    "webhook-validation"
  ),
  api(
    "app/api/kestrel/tools/search-knowledge-documents/route.ts",
    "/api/kestrel/tools/search-knowledge-documents",
    "tool-boundary",
    "tool-boundary",
    "bearer-or-session"
  ),
  api(
    "app/api/kestrel/gateway-credentials/lease/route.ts",
    "/api/kestrel/gateway-credentials/lease",
    "credential-boundary",
    "service-boundary",
    "service-bearer"
  ),
  api(
    "app/api/runtime/github/action/route.ts",
    "/api/runtime/github/action",
    "credential-boundary",
    "service-boundary",
    "service-bearer"
  ),
  api(
    "app/api/runtime/github/git/[resourceId]/[...gitPath]/route.ts",
    "/api/runtime/github/git/[resourceId]/[...gitPath]",
    "credential-boundary",
    "service-boundary",
    "service-bearer"
  ),
  api(
    "app/api/runtime/github/push/route.ts",
    "/api/runtime/github/push",
    "credential-boundary",
    "service-boundary",
    "service-bearer"
  ),
  api(
    "app/api/admin/api-keys/route.ts",
    "/api/admin/api-keys",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/api-keys/[id]/route.ts",
    "/api/admin/api-keys/:id",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/route.ts",
    "/api/admin/environments",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/route.ts",
    "/api/admin/environments/:id",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/operations/route.ts",
    "/api/admin/environments/:id/operations",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/capabilities/subjects/route.ts",
    "/api/admin/environments/:id/capabilities/subjects",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/capabilities/route.ts",
    "/api/admin/environments/:id/capabilities",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/workspaces/route.ts",
    "/api/admin/environments/:id/workspaces",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/workspaces/[workspaceId]/backups/route.ts",
    "/api/admin/environments/:id/workspaces/:workspaceId/backups",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/workspaces/[workspaceId]/backups/[backupId]/restore/route.ts",
    "/api/admin/environments/:id/workspaces/:workspaceId/backups/:backupId/restore",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/capabilities/[capabilityId]/route.ts",
    "/api/admin/environments/:id/mcp/capabilities/:capabilityId",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/credentials/route.ts",
    "/api/admin/environments/:id/mcp/credentials",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/credentials/[credentialId]/route.ts",
    "/api/admin/environments/:id/mcp/credentials/:credentialId",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/health/route.ts",
    "/api/admin/environments/:id/mcp/health",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/oauth/start/route.ts",
    "/api/admin/environments/:id/mcp/oauth/start",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/oauth/callback/route.ts",
    "/api/admin/environments/:id/mcp/oauth/callback",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/servers/route.ts",
    "/api/admin/environments/:id/mcp/servers",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/servers/[serverId]/route.ts",
    "/api/admin/environments/:id/mcp/servers/:serverId",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/servers/[serverId]/discover/route.ts",
    "/api/admin/environments/:id/mcp/servers/:serverId/discover",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/environments/[id]/mcp/servers/[serverId]/snapshots/[snapshotId]/route.ts",
    "/api/admin/environments/:id/mcp/servers/:serverId/snapshots/:snapshotId",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/gateways/route.ts",
    "/api/admin/gateways",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/gateways/[id]/route.ts",
    "/api/admin/gateways/:id",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/gateways/[id]/models/route.ts",
    "/api/admin/gateways/:id/models",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/gateways/[id]/sync/route.ts",
    "/api/admin/gateways/:id/sync",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/logs/route.ts",
    "/api/admin/logs",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/logs/count/route.ts",
    "/api/admin/logs/count",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/logs/stats/route.ts",
    "/api/admin/logs/stats",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/tools/route.ts",
    "/api/admin/tools",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/tools/[providerKey]/route.ts",
    "/api/admin/tools/:providerKey",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/tools/[providerKey]/test/route.ts",
    "/api/admin/tools/:providerKey/test",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/tools/[providerKey]/capabilities/[capabilityKey]/route.ts",
    "/api/admin/tools/:providerKey/capabilities/:capabilityKey",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/tools/discord/binding/route.ts",
    "/api/admin/tools/discord/binding",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/users/route.ts",
    "/api/admin/users",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/admin/users/[id]/route.ts",
    "/api/admin/users/:id",
    ADMIN_API.owner,
    ADMIN_API.access,
    ADMIN_API.unauthorized
  ),
  api(
    "app/api/agent-config/route.ts",
    "/api/agent-config",
    "agent-config",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/agent-config/reset/route.ts",
    "/api/agent-config/reset",
    "agent-config",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/discord/gateway/route.ts",
    "/api/discord/gateway",
    "integrations",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/github/repos/route.ts",
    "/api/github/repos",
    "integrations",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/integrations/github/route.ts",
    "/api/integrations/github",
    "integrations",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/integrations/github/connect/route.ts",
    "/api/integrations/github/connect",
    "integrations",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/integrations/github/repositories/route.ts",
    "/api/integrations/github/repositories",
    "integrations",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/integrations/github/sync/route.ts",
    "/api/integrations/github/sync",
    "integrations",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/sandbox/shell/route.ts",
    "/api/sandbox/shell",
    "sandbox",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/snapshot/config/route.ts",
    "/api/snapshot/config",
    "snapshot",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/snapshot/status/route.ts",
    "/api/snapshot/status",
    "snapshot",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/snapshot/sync/route.ts",
    "/api/snapshot/sync",
    "snapshot",
    "admin",
    "admin-denied"
  ),
  api("app/api/stats/route.ts", "/api/stats", "stats", "admin", "admin-denied"),
  api("app/api/sync/route.ts", "/api/sync", "sync", "admin", "admin-denied"),
  api(
    "app/api/sync/[source]/route.ts",
    "/api/sync/:source",
    "sync",
    "admin",
    "admin-denied"
  ),

  api(
    "app/api/agent-config/public/route.ts",
    "/api/agent-config/public",
    "agent-config",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/artifacts/[id]/route.ts",
    "/api/artifacts/:id",
    "artifacts",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/artifacts/[id]/suggestions/route.ts",
    "/api/artifacts/:id/suggestions",
    "artifacts",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/route.ts",
    "/api/threads",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/route.ts",
    "/api/threads/:id",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/share/route.ts",
    "/api/threads/:id/share",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/stream/route.ts",
    "/api/threads/:id/stream",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/environment/route.ts",
    "/api/threads/:id/environment",
    "environments",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/mcp/interactions/route.ts",
    "/api/threads/:id/mcp/interactions",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/mcp/interactions/[checkpointId]/route.ts",
    "/api/threads/:id/mcp/interactions/:checkpointId",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/workspace/[...path]/route.ts",
    "/api/threads/:id/workspace/:path*",
    "environments",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/files/[...pathname]/route.ts",
    "/api/files/:path*",
    "files",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/route.ts",
    "/api/knowledge/documents",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/[id]/route.ts",
    "/api/knowledge/documents/:id",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/[id]/download/route.ts",
    "/api/knowledge/documents/:id/download",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/[id]/reindex/route.ts",
    "/api/knowledge/documents/:id/reindex",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/promote/route.ts",
    "/api/knowledge/documents/promote",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/knowledge/documents/search/route.ts",
    "/api/knowledge/documents/search",
    "knowledge",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/media/generate/route.ts",
    "/api/media/generate",
    "media",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/media/jobs/[id]/route.ts",
    "/api/media/jobs/:id",
    "media",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/messages/[id]/feedback/route.ts",
    "/api/messages/:id/feedback",
    "messages",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/messages/[id]/speech/route.ts",
    "/api/messages/:id/speech",
    "messages",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/models/approved/route.ts",
    "/api/models/approved",
    "models",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/sandbox/snapshot/route.ts",
    "/api/sandbox/snapshot",
    "sandbox",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/sources/route.ts",
    "/api/sources",
    "sources",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/sources/[id]/route.ts",
    "/api/sources/:id",
    "sources",
    "admin",
    "admin-denied"
  ),
  api(
    "app/api/sources/ocr/route.ts",
    "/api/sources/ocr",
    "sources",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/stats/me/route.ts",
    "/api/stats/me",
    "stats",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/stats/usage/route.ts",
    "/api/stats/usage",
    "stats",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/tools/runtime/route.ts",
    "/api/tools/runtime",
    "runtime-tools",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/threads/[id]/uploads/route.ts",
    "/api/threads/:id/uploads",
    "files",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/route.ts",
    "/api/projects",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/route.ts",
    "/api/projects/:id",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/context/route.ts",
    "/api/projects/:id/context",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/files/route.ts",
    "/api/projects/:id/files",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/environment/route.ts",
    "/api/projects/:id/environment",
    "environments",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/workspace/route.ts",
    "/api/projects/:id/workspace",
    "environments",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/capabilities/route.ts",
    "/api/projects/:id/capabilities",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/members/route.ts",
    "/api/projects/:id/members",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/projects/[id]/members/[memberId]/route.ts",
    "/api/projects/:id/members/:memberId",
    "projects",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
  api(
    "app/api/search/route.ts",
    "/api/search",
    "threads",
    AUTHENTICATED_API.access,
    AUTHENTICATED_API.unauthorized
  ),
] satisfies readonly KestrelOneRouteOwnershipEntry[];

export const PRIMARY_KESTREL_ONE_NAVIGATION_ROUTES =
  KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.filter(
    (entry) => entry.primaryNavigation
  );
