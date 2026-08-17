export type ScheduleOperationalStatus =
  | "Needs input"
  | "Running"
  | "Paused"
  | "Failed"
  | "Scheduled";

export function scheduleOperationalStatus(schedule: {
  enabled: boolean;
  activeStatus: "waiting_for_input" | "running" | null;
  latestRun: {
    status: "queued" | "materialized" | "failed" | "cancelled";
    turnStatus:
      | "queued"
      | "running"
      | "waiting_for_input"
      | "completed"
      | "failed"
      | "cancelled"
      | null;
  } | null;
}): ScheduleOperationalStatus {
  const run = schedule.latestRun;
  if (schedule.activeStatus === "waiting_for_input") return "Needs input";
  if (schedule.activeStatus === "running") return "Running";
  if (!schedule.enabled) return "Paused";
  if (run?.status === "failed" || run?.turnStatus === "failed") {
    return "Failed";
  }
  return "Scheduled";
}
