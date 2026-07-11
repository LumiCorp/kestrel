import type { KestrelTerminalStatus } from "@/lib/agent/kestrel-stream-events";

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
  if (input.terminalStatus === "runner_error") {
    return "Interrupted";
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
    terminalStatus === "runner_error"
  );
}
