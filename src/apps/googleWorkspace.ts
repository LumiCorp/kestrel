export const GOOGLE_WORKSPACE_APP_ID = "google_workspace" as const;
export const GOOGLE_WORKSPACE_CREDENTIAL_PREFIX = "mcp.standard.google_workspace" as const;

export const GOOGLE_WORKSPACE_PACK_SCOPES = Object.freeze({
  calendar: Object.freeze([
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]),
});
export type GoogleWorkspacePack = keyof typeof GOOGLE_WORKSPACE_PACK_SCOPES;

export const GOOGLE_WORKSPACE_PACK_TOOLS = Object.freeze({
  calendar: Object.freeze([
    "google_workspace.list_events",
    "google_workspace.create_event",
    "google_workspace.update_event",
    "google_workspace.delete_event",
  ]),
});

export type GoogleWorkspaceOperation =
  | "events.list"
  | "events.create"
  | "events.update"
  | "events.delete";

export interface GoogleWorkspaceServicePort {
  invoke(operation: GoogleWorkspaceOperation, input: Record<string, unknown>): Promise<unknown>;
}

export function scopesForGoogleWorkspacePacks(packs: readonly GoogleWorkspacePack[]): string[] {
  return [...new Set(packs.flatMap((pack) => GOOGLE_WORKSPACE_PACK_SCOPES[pack]))];
}

export function isGoogleWorkspacePack(value: string): value is GoogleWorkspacePack {
  return Object.hasOwn(GOOGLE_WORKSPACE_PACK_SCOPES, value);
}
