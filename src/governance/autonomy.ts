import type { AutonomyPolicy } from "./contracts.js";

export interface AutonomyDecision {
  allowed: boolean;
  missingEvidence: string[];
  escalateReasons: string[];
}

export function defaultAutonomyPolicy(
  level: AutonomyPolicy["level"] = "L2",
): AutonomyPolicy {
  const byLevel: Record<AutonomyPolicy["level"], AutonomyPolicy> = {
    L0: {
      level: "L0",
      allowed_actions: ["ask_user", "finalize"],
      required_evidence: [],
      mandatory_escalations: [],
    },
    L1: {
      level: "L1",
      allowed_actions: ["ask_user", "finalize", "tool.read_only"],
      required_evidence: ["plan", "goal"],
      mandatory_escalations: ["external_side_effect", "low_confidence"],
    },
    L2: {
      level: "L2",
      allowed_actions: ["ask_user", "finalize", "tool.read_only", "tool_batch", "effect"],
      required_evidence: ["plan", "goal", "observation_or_tool_result"],
      mandatory_escalations: ["external_side_effect", "missing_capability"],
    },
    L3: {
      level: "L3",
      allowed_actions: [
        "ask_user",
        "finalize",
        "tool.read_only",
        "tool.sandboxed_only",
        "tool_batch",
        "effect",
      ],
      required_evidence: ["plan", "goal", "observation_or_tool_result"],
      mandatory_escalations: ["external_side_effect", "low_confidence"],
    },
    L4: {
      level: "L4",
      allowed_actions: [
        "ask_user",
        "finalize",
        "tool.read_only",
        "tool.sandboxed_only",
        "tool.external_side_effect",
        "tool_batch",
        "effect",
      ],
      required_evidence: ["plan", "goal"],
      mandatory_escalations: [],
    },
  };
  return byLevel[level];
}

export function evaluateAutonomyPolicy(input: {
  policy: AutonomyPolicy;
  action: string;
  evidence: string[];
  riskSignals: string[];
}): AutonomyDecision {
  const missingEvidence = input.policy.required_evidence.filter(
    (required) => input.evidence.includes(required) === false,
  );
  const escalateReasons = input.policy.mandatory_escalations.filter((signal) =>
    input.riskSignals.includes(signal),
  );

  return {
    allowed: input.policy.allowed_actions.includes(input.action) && missingEvidence.length === 0,
    missingEvidence,
    escalateReasons,
  };
}
