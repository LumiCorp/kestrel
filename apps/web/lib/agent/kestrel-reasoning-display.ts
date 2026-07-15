import type { KestrelTerminalStatus } from "@kestrel-agents/ai-sdk";

export function getReasoningTriggerLabel(input: {
  isStreaming: boolean;
  duration: number;
  terminalStatus?: KestrelTerminalStatus | null;
}) {
  if (input.terminalStatus === "failed") {
    return "Failed";
  }
  if (input.terminalStatus === "cancelled") {
    return "Cancelled";
  }
  if (input.terminalStatus === "contract_failure") {
    return "Interrupted";
  }
  if (input.terminalStatus === "waiting") {
    return "Waiting";
  }

  return input.isStreaming || input.duration === 0
    ? "Thinking"
    : `${input.duration}s`;
}

export function shouldAutoCloseReasoning(
  terminalStatus?: KestrelTerminalStatus | null
) {
  return !(
    terminalStatus === "failed" ||
    terminalStatus === "cancelled" ||
    terminalStatus === "contract_failure"
  );
}
