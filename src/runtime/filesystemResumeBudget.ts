export const BROAD_RESUME_MAX_INVENTORY_ACTIONS = 10;
export const BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS = 20;
export const BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET =
  BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS + 1;
export const LEGACY_FILESYSTEM_RESUME_STOP_REASON = "filesystem_budget_exhausted";

export interface FilesystemResumeReadBudgetDetail {
  kind: "filesystem_resume";
  configuredLimits: {
    inventoryReadActions: number;
    groundedReadActions: number;
    groundedReadActionsWithExplicitTarget: number;
  };
  usage: {
    inventoryReadActions: number;
    groundedReadActions: number;
  };
  remaining: {
    inventoryReadActions: number;
    groundedReadActions: number;
    groundedReadActionsWithExplicitTarget: number;
  };
  exhausted: boolean;
  stoppedByBudget: boolean;
  stopReason?: string | undefined;
}

export function isBroadResumeBudgetExhausted(input: {
  inventoryActions: number;
  groundedReadActions: number;
}): boolean {
  return (
    input.inventoryActions >= BROAD_RESUME_MAX_INVENTORY_ACTIONS &&
    input.groundedReadActions >= BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS
  );
}

export function buildFilesystemResumeReadBudgetDetail(input?: {
  inventoryActions?: number | undefined;
  groundedReadActions?: number | undefined;
  stoppedByBudget?: boolean | undefined;
  stopReason?: string | undefined;
}): FilesystemResumeReadBudgetDetail {
  const inventoryActions = readNonNegativeInteger(input?.inventoryActions);
  const groundedReadActions = readNonNegativeInteger(input?.groundedReadActions);
  const resolvedStopReason =
    input?.stopReason ??
    (input?.stoppedByBudget === true ? LEGACY_FILESYSTEM_RESUME_STOP_REASON : undefined);
  return {
    kind: "filesystem_resume",
    configuredLimits: {
      inventoryReadActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
      groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      groundedReadActionsWithExplicitTarget:
        BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET,
    },
    usage: {
      inventoryReadActions: inventoryActions,
      groundedReadActions,
    },
    remaining: {
      inventoryReadActions: Math.max(
        0,
        BROAD_RESUME_MAX_INVENTORY_ACTIONS - inventoryActions,
      ),
      groundedReadActions: Math.max(
        0,
        BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS - groundedReadActions,
      ),
      groundedReadActionsWithExplicitTarget: Math.max(
        0,
        BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET -
          groundedReadActions,
      ),
    },
    exhausted: isBroadResumeBudgetExhausted({
      inventoryActions,
      groundedReadActions,
    }),
    stoppedByBudget: input?.stoppedByBudget === true,
    ...(resolvedStopReason !== undefined ? { stopReason: resolvedStopReason } : {}),
  };
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
