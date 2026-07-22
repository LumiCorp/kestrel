import type { DesktopRuntimeThreadInspection } from "../../src/contracts";

export function withoutDesktopActiveRun(
  view: DesktopRuntimeThreadInspection,
): DesktopRuntimeThreadInspection {
  const { activeRun: _activeRun, ...withoutActiveRun } = view;
  return withoutActiveRun;
}
