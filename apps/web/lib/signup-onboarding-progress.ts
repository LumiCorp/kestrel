export type SignupEnvironmentMilestoneStatus =
  | "completed"
  | "active"
  | "upcoming";

export type SignupEnvironmentMilestone = {
  id: string;
  label: string;
  status: SignupEnvironmentMilestoneStatus;
};

export type SignupEnvironmentExperience =
  | { kind: "progress" }
  | {
      kind: "action";
      actionLabel: string;
      busyLabel: string;
      title: string;
    }
  | { kind: "blocked"; title: string };

const MILESTONES = [
  { id: "requested", label: "Preparing the Environment" },
  { id: "runtime", label: "Creating the private Environment runtime" },
  { id: "gateway", label: "Starting the Environment gateway" },
  { id: "health", label: "Checking runtime health" },
  { id: "thread", label: "Opening your first Thread" },
] as const;

const ACTIVE_MILESTONE_BY_STAGE: Record<string, number> = {
  "environment.activation.requested": 0,
  "environment.runtime.connecting": 1,
  "environment.machine.starting": 2,
  "environment.health.checking": 3,
  "environment.activation.ready": 4,
};

export function getSignupEnvironmentExperience(
  status: string,
): SignupEnvironmentExperience {
  switch (status) {
    case "provisioning":
    case "ready":
      return { kind: "progress" };
    case "failed":
      return {
        kind: "action",
        actionLabel: "Retry Environment setup",
        busyLabel: "Retrying…",
        title: "Environment setup needs attention",
      };
    case "missing_environment":
    case "rollout_disabled":
      return {
        kind: "action",
        actionLabel: "Continue Environment setup",
        busyLabel: "Continuing…",
        title: "Environment setup is paused",
      };
    case "deployment_disabled":
      return {
        kind: "blocked",
        title: "Hosted Environments are unavailable",
      };
    case "degraded":
      return {
        kind: "blocked",
        title: "Environment setup needs administrator attention",
      };
    default:
      return { kind: "blocked", title: "Environment setup is paused" };
  }
}

export function getSignupEnvironmentMilestones(input: {
  environmentReady: boolean;
  operationStage: string | null;
}): SignupEnvironmentMilestone[] {
  const activeIndex = input.environmentReady
    ? MILESTONES.length - 1
    : (ACTIVE_MILESTONE_BY_STAGE[input.operationStage ?? ""] ?? 0);

  return MILESTONES.map((milestone, index) => ({
    ...milestone,
    status:
      index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "active"
          : "upcoming",
  }));
}
