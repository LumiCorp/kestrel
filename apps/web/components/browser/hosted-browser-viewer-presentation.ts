export const HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE =
  "BROWSER_ACTION_OUTCOME_UNKNOWN" as const;

export type HostedBrowserViewerCleanupUnknownPresentation = {
  title: string;
  instruction: string;
};

export function hostedBrowserViewerCleanupUnknownPresentation(
  code: string,
): HostedBrowserViewerCleanupUnknownPresentation | null {
  if (code !== HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE) return null;
  return {
    title: "Browser cleanup status unknown",
    instruction: "The Browser Session remains blocked. Wait for Kestrel to confirm it closed before reconnecting.",
  };
}
