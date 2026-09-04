type ExactToolDecision = {
  available?: unknown;
  approvalDisposition?: {
    mode?: unknown;
    reasonCode?: unknown;
  } | null;
  rememberApprovalEligible?: unknown;
};

type CurrentApprovalPolicy = {
  environmentApprovalMode?: unknown;
  projectApprovalMode?: unknown;
  subjectApprovalMode?: unknown;
  rememberApprovalEligible?: unknown;
};

export function createExecCommandCanaryApprovalResponse(input: {
  requestId: string;
  turnId: string;
  messageId: string;
}) {
  return {
    interactionResponse: {
      ...input,
      eventType: "user.approval",
      decision: "approve_once",
      reason: "Kestrel post-cutover exec_command canary",
    },
  } as const;
}

export function matchesExactExecCommandApprovalScope(
  scope: unknown,
  command: string,
): boolean {
  const exact = asRecord(scope);
  return (
    exact?.kind === "exec_command_exact" &&
    exact.command === command &&
    exact.cwd === "." &&
    exact.envMode === "inherit" &&
    Array.isArray(exact.envNames) &&
    exact.envNames.length === 0
  );
}

export function assertExecCommandNoSpendPreflight(
  value: unknown,
): asserts value is { toolName: "exec_command"; decision: ExactToolDecision } {
  const result = asRecord(value);
  const decision = asRecord(result?.decision);
  const disposition = asRecord(decision?.approvalDisposition);
  if (
    result?.toolName !== "exec_command" ||
    decision?.available !== true ||
    disposition?.mode !== "ask" ||
    (disposition.reasonCode !== "environment_policy" &&
      disposition.reasonCode !== "project_restriction") ||
    decision.rememberApprovalEligible !== true
  ) {
    throw new Error(
      "The no-spend exec_command preflight did not resolve to an eligible Ask First decision.",
    );
  }
}

export function isCurrentExecCommandApprovalActionable(
  policy: CurrentApprovalPolicy | undefined,
): boolean {
  return (
    policy !== undefined &&
    policy.rememberApprovalEligible === true &&
    policy.environmentApprovalMode !== "deny" &&
    policy.projectApprovalMode !== "deny" &&
    policy.subjectApprovalMode !== "deny" &&
    (policy.environmentApprovalMode === "ask" ||
      policy.projectApprovalMode === "ask")
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
