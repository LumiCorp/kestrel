import type { HostedBrowserOriginAuthority } from "./store";
import type { BrowserPolicyResolutionV1, BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";

export function resolveHostedBrowserViewerPolicyAccess(input: {
  origin: Pick<HostedBrowserOriginAuthority, "environmentId" | "projectId" | "userId">;
  session: Pick<BrowserSessionV1, "effectiveAllowlistRevision">;
  current: Pick<BrowserPolicyResolutionV1, "decision"> & Pick<
    BrowserEffectiveDomainAuthorityV1,
    "environmentId" | "projectId" | "userId" | "effectiveAllowlistRevision"
  >;
}): boolean {
  const authorized = input.current.decision === "allow" &&
    input.current.environmentId === input.origin.environmentId &&
    input.current.projectId === input.origin.projectId &&
    input.current.userId === input.origin.userId;
  if (!authorized) return false;
  if (input.current.effectiveAllowlistRevision !== input.session.effectiveAllowlistRevision) {
    // A committed domain change precedes worker adoption. Deny viewer effects
    // until adoption completes, but do not misclassify it as revoked access:
    // that would destroy the Browser before the approved grant can execute.
    throw new Error("BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED");
  }
  return true;
}

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
