import type { KestrelTerminalStatus } from "@kestrel-agents/ai-sdk";

export function assertVisibleCompletedOutcome(
  status: KestrelTerminalStatus,
  assistantMessageCount: number
) {
  if (status === "completed" && assistantMessageCount === 0) {
    throw new Error("The agent completed without a user-visible answer.");
  }
}
