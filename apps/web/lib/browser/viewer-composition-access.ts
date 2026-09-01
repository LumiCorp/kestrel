import type { HostedBrowserOriginAuthority } from "./store";

export function resolveHostedBrowserViewerRequester(input: {
  organizationId: string;
  actorId: string;
  threadId: string;
  origin: HostedBrowserOriginAuthority;
  accessibleProjectId?: string | undefined;
}) {
  if (
    input.origin.organizationId !== input.organizationId ||
    input.origin.threadId !== input.threadId
  ) throw new Error("BROWSER_SESSION_LOST");
  const requestMatchesOriginActor = input.origin.userId === input.actorId;
  const requestMatchesAuthorizedReplacement =
    !requestMatchesOriginActor &&
    input.accessibleProjectId === input.origin.projectId;
  if (!(requestMatchesOriginActor || requestMatchesAuthorizedReplacement)) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  return {
    requestMatchesOriginActor,
    requestMatchesAuthorizedReplacement,
    cleanupBypass: true,
  };
}
