import type { ToolApprovalMode } from "@/lib/tools/types";

const APPROVAL_RESTRICTIVENESS: Record<ToolApprovalMode, number> = {
  auto: 0,
  ask: 1,
  deny: 2,
};

export function isProjectApprovalWithinEnvironment(input: {
  environment: ToolApprovalMode;
  project: ToolApprovalMode;
}) {
  return (
    APPROVAL_RESTRICTIVENESS[input.project] >=
    APPROVAL_RESTRICTIVENESS[input.environment]
  );
}

export function intersectAppApprovalModes(
  ...modes: ToolApprovalMode[]
): ToolApprovalMode {
  return modes.reduce<ToolApprovalMode>(
    (strictest, mode) =>
      APPROVAL_RESTRICTIVENESS[mode] > APPROVAL_RESTRICTIVENESS[strictest]
        ? mode
        : strictest,
    "auto"
  );
}
