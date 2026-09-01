export const HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE =
  "BROWSER_ACTION_OUTCOME_UNKNOWN" as const;

export type HostedBrowserViewerCleanupUnknownPresentation = {
  title: string;
  instruction: string;
};

export type HostedBrowserViewerAvailability = {
  available: boolean;
  sessionState?: string;
  cleanupPending?: boolean;
};

export async function classifyHostedBrowserViewerAvailabilityResponse(
  response: Response,
): Promise<
  | { kind: "authoritative"; availability: HostedBrowserViewerAvailability }
  | { kind: "unavailable" }
  | { kind: "transient" }
> {
  if (response.ok) {
    return {
      kind: "authoritative",
      availability: await response.json() as HostedBrowserViewerAvailability,
    };
  }
  if (response.status !== 404) return { kind: "transient" };
  const body = await response.json().catch(() => null) as
    | { error?: { code?: unknown } }
    | null;
  return body?.error?.code === "BROWSER_SESSION_LOST"
    ? { kind: "unavailable" }
    : { kind: "transient" };
}

export function hostedBrowserViewerCleanupUnknownPresentation(
  code: string,
): HostedBrowserViewerCleanupUnknownPresentation | null {
  if (code !== HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE) return null;
  return {
    title: "Browser cleanup status unknown",
    instruction: "The Browser Session remains blocked. Wait for Kestrel to confirm it closed before reconnecting.",
  };
}
