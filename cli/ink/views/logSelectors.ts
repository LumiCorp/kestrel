import type { AgentRunLogLine, UiLogFilters } from "../../contracts.js";

export function filterRunLogs(lines: AgentRunLogLine[], filters: UiLogFilters): AgentRunLogLine[] {
  const eventNeedle = filters.eventQuery.trim().toLowerCase();
  const runNeedle = filters.runIdQuery.trim().toLowerCase();

  return lines.filter((line) => {
    if (filters.level !== "ALL" && line.level !== filters.level) {
      return false;
    }

    if (eventNeedle.length > 0 && line.eventName.toLowerCase().includes(eventNeedle) === false) {
      return false;
    }

    if (runNeedle.length > 0) {
      const runId = line.runId?.toLowerCase() ?? "";
      if (runId.includes(runNeedle) === false) {
        return false;
      }
    }

    return true;
  });
}
