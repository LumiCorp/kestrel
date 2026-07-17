export type UserVisibleTextField =
  | "finalize.message"
  | "handoff_to_build.message"
  | "cannot_satisfy.message"
  | "ask_user.prompt";

export interface UserVisibleTextViolation {
  message: string;
  details: {
    reason: "user_visible_text_not_operator_facing";
    path: "nextAction.message" | "nextAction.prompt";
    field: UserVisibleTextField;
    matchedText: string;
    matchedRule:
      | "internal_next_action_narration"
      | "internal_deferred_answer_narration"
      | "internal_completion_narration"
      | "internal_already_satisfied_narration"
      | "internal_turn_management_narration"
      | "internal_ask_user_narration"
      | "internal_wrapup_narration";
    correction: string;
  };
}

const INVALID_USER_VISIBLE_PATTERNS: Array<{
  pattern: RegExp;
  matchedRule: UserVisibleTextViolation["details"]["matchedRule"];
}> = [
  {
    pattern: /\b(next (action|move|step)|best next step)\b/iu,
    matchedRule: "internal_next_action_narration",
  },
  {
    pattern: /\b(answer|response|report|closeout)\s+(can|could|will)\s+be\s+(given|provided|delivered|returned)\b/iu,
    matchedRule: "internal_deferred_answer_narration",
  },
  {
    pattern: /\b(no further|no more)\s+(tool|tools|action|actions|check|checks|step|steps)\s+(are|is)\s+(needed|required)\b/iu,
    matchedRule: "internal_completion_narration",
  },
  {
    pattern: /\b(request|goal)\s+is\s+already\s+satisfied\b/iu,
    matchedRule: "internal_already_satisfied_narration",
  },
  {
    pattern: /\balready satisfied\b/iu,
    matchedRule: "internal_already_satisfied_narration",
  },
  {
    pattern: /\b(in|within)\s+this\s+turn\b/iu,
    matchedRule: "internal_turn_management_narration",
  },
  {
    pattern: /^\s*(ask|prompt)\s+the\s+user\b/iu,
    matchedRule: "internal_ask_user_narration",
  },
  {
    pattern: /\bwrap(?:ping)?\s+this\s+up\b/iu,
    matchedRule: "internal_wrapup_narration",
  },
];

export function findUserVisibleTextViolation(input: {
  field: UserVisibleTextField;
  text: string;
}): UserVisibleTextViolation | undefined {
  const normalizedText = input.text.trim();
  if (normalizedText.length === 0) {
    return ;
  }

  for (const rule of INVALID_USER_VISIBLE_PATTERNS) {
    const match = rule.pattern.exec(normalizedText);
    if (match === null) {
      continue;
    }
    return {
      message: buildViolationMessage(input.field),
      details: {
        reason: "user_visible_text_not_operator_facing",
        path: input.field === "ask_user.prompt" ? "nextAction.prompt" : "nextAction.message",
        field: input.field,
        matchedText: match[0],
        matchedRule: rule.matchedRule,
        correction: correctionForField(input.field),
      },
    };
  }

  return ;
}

function buildViolationMessage(field: UserVisibleTextField): string {
  if (field === "ask_user.prompt") {
    return "Ask-user requires the prompt to be the exact user-facing question or approval prompt, not internal narration.";
  }
  if (field === "cannot_satisfy.message") {
    return "cannot_satisfy requires the message to be the exact user-facing blocker or refusal, not internal narration.";
  }
  if (field === "handoff_to_build.message") {
    return "Build handoff requires the message to be operator-facing because runtime reuses it in the handoff prompt.";
  }
  return "Finalize requires the message to be the exact user-facing answer or closeout, not internal narration.";
}

function correctionForField(field: UserVisibleTextField): string {
  if (field === "ask_user.prompt") {
    return "Put the exact question or approval prompt the user should read in the prompt. Do not describe that you should ask the user.";
  }
  if (field === "cannot_satisfy.message") {
    return "Put the exact blocker or refusal the user should read in the message. Do not narrate turn management or internal workflow.";
  }
  if (field === "handoff_to_build.message") {
    return "Put the exact operator-facing handoff summary in the message so it can be reused inside the confirmation prompt.";
  }
  return "Put the exact answer or closeout the user should read in the message. Do not narrate planner state or what could happen next.";
}
