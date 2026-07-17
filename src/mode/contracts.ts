export type InteractionMode = "chat" | "plan" | "build";
export type LegacyBuildSubmode = "strict" | "safe" | "full_auto";
export type ActSubmode = LegacyBuildSubmode;
export type ToolExecutionClass = "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect";
export type ApprovalCapabilityClass =
  | "workspace.read"
  | "workspace.write"
  | "shell.exec"
  | "project.board.write"
  | "project.task_queue.write"
  | "network.call"
  | "code.execute"
  | "mcp.invoke"
  | "delegation.control"
  | "external.confirm";

export interface ExecutionPolicyOverride {
  toolClassPolicy?: Partial<Record<ToolExecutionClass, boolean>> | undefined;
  capabilityPolicy?: Partial<Record<ApprovalCapabilityClass, boolean>> | undefined;
  approvalPolicy?: {
    strictApprovalPerCall?: boolean | undefined;
  } | undefined;
}

export interface InteractionModeResolution {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
}

export const DEFAULT_INTERACTION_MODE: InteractionMode = "chat";
export const DEFAULT_ACT_SUBMODE: LegacyBuildSubmode = "safe";
const TOOL_EXECUTION_CLASSES: ToolExecutionClass[] = [
  "read_only",
  "planning_write",
  "sandboxed_only",
  "external_side_effect",
];

export const APPROVAL_CAPABILITY_CLASSES: ApprovalCapabilityClass[] = [
  "workspace.read",
  "workspace.write",
  "shell.exec",
  "project.board.write",
  "project.task_queue.write",
  "network.call",
  "code.execute",
  "mcp.invoke",
  "delegation.control",
  "external.confirm",
];

export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "chat" || value === "plan" || value === "build";
}

export function isLegacyBuildSubmode(value: unknown): value is LegacyBuildSubmode {
  return value === "strict" || value === "safe" || value === "full_auto";
}

export function isApprovalCapabilityClass(value: unknown): value is ApprovalCapabilityClass {
  return typeof value === "string" && APPROVAL_CAPABILITY_CLASSES.includes(value as ApprovalCapabilityClass);
}

export function normalizeLegacyBuildSubmode(value: unknown): LegacyBuildSubmode | undefined {
  if (value === "full-auto") {
    return "full_auto";
  }
  return isLegacyBuildSubmode(value) ? value : undefined;
}

export function formatUserFacingModeLabel(input: {
  interactionMode?: InteractionMode | string | undefined;
  actSubmode?: LegacyBuildSubmode | string | undefined;
}): string {
  const mode = input.interactionMode ?? DEFAULT_INTERACTION_MODE;
  if (mode === "chat") {
    return "Chat";
  }
  if (mode === "plan") {
    return "Plan";
  }
  if (mode === "build") {
    return "Build";
  }
  return String(mode);
}

export function formatModeSwitchCommand(input: {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
}): string {
  return `/mode ${input.interactionMode}`;
}

export function formatModeSwitchReply(input: {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
}): string {
  return `switch to ${input.interactionMode}`;
}

export function toCanonicalInteractionMode(
  mode: InteractionMode,
): "chat" | "plan" | "build" {
  return mode;
}

export function normalizeInteractionMode(input: {
  interactionMode?: unknown;
  actSubmode?: unknown;
  defaultInteractionMode?: InteractionMode | undefined;
  defaultActSubmode?: LegacyBuildSubmode | undefined;
}): InteractionModeResolution {
  const defaultInteractionMode = input.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE;
  const candidateMode = input.interactionMode;
  const candidateActSubmode =
    normalizeLegacyBuildSubmode(input.actSubmode) ??
    normalizeLegacyBuildSubmode(input.defaultActSubmode);

  if (isInteractionMode(candidateMode)) {
    return {
      interactionMode: candidateMode,
      ...(candidateMode === "build" && candidateActSubmode !== undefined
        ? { actSubmode: candidateActSubmode }
        : {}),
    };
  }

  return {
    interactionMode: defaultInteractionMode,
    ...(defaultInteractionMode === "build" && candidateActSubmode !== undefined
      ? { actSubmode: candidateActSubmode }
      : {}),
  };
}

export function getAllowedToolClasses(
  interactionMode: InteractionMode,
): ReadonlySet<ToolExecutionClass> {
  if (interactionMode === "chat") {
    return new Set<ToolExecutionClass>(["read_only"]);
  }

  if (interactionMode === "plan") {
    return new Set<ToolExecutionClass>(["read_only", "planning_write"]);
  }

  return new Set<ToolExecutionClass>([
    "read_only",
    "sandboxed_only",
    "external_side_effect",
  ]);
}

export function defaultAllowedInteractionModesForToolClass(
  toolClass: ToolExecutionClass,
): InteractionMode[] {
  if (toolClass === "read_only") {
    return ["chat", "plan", "build"];
  }
  if (toolClass === "planning_write") {
    return ["plan"];
  }
  return ["build"];
}

export function resolveToolAllowedInteractionModes(input: {
  toolClass: ToolExecutionClass;
  allowedInteractionModes?: readonly InteractionMode[] | undefined;
}): InteractionMode[] {
  return input.allowedInteractionModes === undefined
    ? defaultAllowedInteractionModesForToolClass(input.toolClass)
    : [...new Set(input.allowedInteractionModes)];
}

/**
 * Shared model-surface and execution eligibility contract. Mode availability is
 * a hard ceiling: policy overrides may narrow it, but cannot widen it. The only
 * class-level exception is an external app action that explicitly opts into Chat.
 */
export function isToolEligibleForInteractionMode(input: {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
  toolClass: ToolExecutionClass;
  allowedInteractionModes?: readonly InteractionMode[] | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  requiredCapabilities?: readonly string[] | undefined;
}): boolean {
  const allowedModes = resolveToolAllowedInteractionModes(input);
  if (!allowedModes.includes(input.interactionMode)) {
    return false;
  }
  if (!areApprovalCapabilitiesAllowed({
    executionPolicy: input.executionPolicy,
    requiredCapabilities: input.requiredCapabilities,
  })) {
    return false;
  }

  const override = input.executionPolicy?.toolClassPolicy?.[input.toolClass];
  if (override === false) {
    return false;
  }
  if (isToolClassAllowed(input)) {
    return true;
  }
  return input.interactionMode === "chat" &&
    input.toolClass === "external_side_effect" &&
    input.allowedInteractionModes?.includes("chat") === true;
}

export function isToolClassAllowed(input: {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
  toolClass: ToolExecutionClass;
  executionPolicy?: ExecutionPolicyOverride | undefined;
}): boolean {
  const allowed = getAllowedToolClasses(input.interactionMode);
  const policyOverride = input.executionPolicy?.toolClassPolicy;
  const override = policyOverride?.[input.toolClass];

  if (override === false) {
    return false;
  }

  if (override === true) {
    return true;
  }

  return allowed.has(input.toolClass);
}

export function alignExecutionPolicyWithMode(input: {
  executionPolicy?: ExecutionPolicyOverride | undefined;
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
}): ExecutionPolicyOverride | undefined {
  return input.executionPolicy;
}

export function resolveAllowedToolClasses(
  modeResolution: Pick<InteractionModeResolution, "interactionMode" | "actSubmode">,
  executionPolicy?: ExecutionPolicyOverride | undefined,
): ToolExecutionClass[] {
  const effectiveExecutionPolicy = alignExecutionPolicyWithMode({
    executionPolicy,
    interactionMode: modeResolution.interactionMode,
  });

  return TOOL_EXECUTION_CLASSES.filter((toolClass) =>
    isToolClassAllowed({
      interactionMode: modeResolution.interactionMode,
      toolClass,
      executionPolicy: effectiveExecutionPolicy,
    })
  );
}

export function needsPerCallApproval(input: {
  interactionMode: InteractionMode;
  actSubmode?: LegacyBuildSubmode | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
}): boolean {
  if (input.executionPolicy?.approvalPolicy?.strictApprovalPerCall !== undefined) {
    return input.executionPolicy.approvalPolicy.strictApprovalPerCall === true;
  }

  return false;
}

export function readBlockedApprovalCapability(input: {
  executionPolicy?: ExecutionPolicyOverride | undefined;
  requiredCapabilities?: readonly string[] | undefined;
}): ApprovalCapabilityClass | undefined {
  const requiredCapabilities = input.requiredCapabilities?.filter(isApprovalCapabilityClass) ?? [];
  if (requiredCapabilities.length === 0) {
    return ;
  }
  const capabilityPolicy = input.executionPolicy?.capabilityPolicy;
  if (capabilityPolicy === undefined) {
    return ;
  }
  return requiredCapabilities.find((capability) => capabilityPolicy[capability] !== true);
}

export function areApprovalCapabilitiesAllowed(input: {
  executionPolicy?: ExecutionPolicyOverride | undefined;
  requiredCapabilities?: readonly string[] | undefined;
}): boolean {
  return readBlockedApprovalCapability(input) === undefined;
}
