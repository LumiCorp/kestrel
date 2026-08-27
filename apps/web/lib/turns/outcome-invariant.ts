import type { KestrelTerminalStatus } from "@kestrel-agents/ai-sdk";

export function assertVisibleCompletedOutcome(
  status: KestrelTerminalStatus,
  assistantMessageCount: number
) {
  if (status === "completed" && assistantMessageCount === 0) {
    throw new Error("The agent completed without a user-visible answer.");
  }
}

export function assertHostedApprovalOutcomeInvariant(outcome: {
  kind: "success" | "partial" | "failure" | "cancellation";
  effectState: "not_applicable" | "not_started" | "committed" | "unknown";
  retryable?: boolean | undefined;
}) {
  if (outcome.kind === "success" && outcome.effectState !== "committed") {
    throw new Error(
      "A successful hosted approval must carry committed effect evidence.",
    );
  }
  if (outcome.retryable === true && outcome.effectState !== "not_started") {
    throw new Error(
      "A hosted approval is retryable only when the effect did not start.",
    );
  }
}
