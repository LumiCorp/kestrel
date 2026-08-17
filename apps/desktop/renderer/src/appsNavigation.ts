import type { DesktopCapabilityId } from "../../src/contracts";

export type DesktopAppsNavigationTarget =
  | { kind: "app"; appId: string }
  | { kind: "workflow"; workflowId: string }
  | { kind: "capability"; capabilityId: DesktopCapabilityId };

export interface DesktopAppsNavigationRequest {
  requestId: number;
  target?: DesktopAppsNavigationTarget | undefined;
}
