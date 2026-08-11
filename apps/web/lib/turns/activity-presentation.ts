import type { ThreadTurnView } from "@/lib/turns/client-contract";

export function isTerminalThreadTurnStatus(
  status: ThreadTurnView["status"] | undefined
) {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function agentProgressSummary(updateCount: number) {
  return `Agent progress · ${updateCount} ${updateCount === 1 ? "update" : "updates"}`;
}
