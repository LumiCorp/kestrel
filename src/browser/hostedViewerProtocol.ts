import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../desktopShell/contracts.js";

export const HOSTED_BROWSER_VIEWER_ROUTE_VERSION =
  "hosted_browser_viewer_route_v1" as const;

export type HostedBrowserViewerClientMessageV1 =
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "authenticate"; ticket: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "accept_takeover" }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "renew_lease"; leaseId: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "input"; leaseId: string; input: DesktopBrowserViewerInputV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "return_control"; leaseId: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "close_session" };

export type HostedBrowserViewerServerMessageV1 =
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "state"; state: DesktopBrowserViewerStateV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "frame"; frame: DesktopBrowserViewerFrameV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "closed"; reason: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "error"; code: string };
