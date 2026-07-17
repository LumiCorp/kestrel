export type MobileActivityStage =
  | "queued"
  | "preparing"
  | "reading_context"
  | "working"
  | "using_capability"
  | "finalizing"
  | "waiting"
  | "retrying";

const activityCopy: Record<MobileActivityStage, string> = {
  queued: "Queued",
  preparing: "Preparing",
  reading_context: "Reading context",
  working: "Working",
  using_capability: "Using a capability",
  finalizing: "Finishing the answer",
  waiting: "Waiting for you",
  retrying: "Resuming",
};

const activityStages = new Set<MobileActivityStage>(
  Object.keys(activityCopy) as MobileActivityStage[]
);

export function isMobileActivityStage(
  value: unknown
): value is MobileActivityStage {
  return (
    typeof value === "string" &&
    activityStages.has(value as MobileActivityStage)
  );
}

export function mobileActivityForStage<TStage extends MobileActivityStage>(
  stage: TStage
) {
  return { stage, message: activityCopy[stage] };
}

type MobileActivityInput =
  | { kind: "progress"; code?: string | null }
  | { kind: "agent_progress"; text: string }
  | { kind: "tool" }
  | { kind: "runtime_event"; eventType: string; code?: string | null };

type MobileLiveActivityStage =
  | "preparing"
  | "working"
  | "using_capability"
  | "finalizing";

type MobileLiveActivity = {
  stage: MobileLiveActivityStage;
  message: string;
};

function progressActivity(code?: string | null): MobileLiveActivity {
  let stage: MobileLiveActivityStage = "working";
  switch (code) {
    case "RUN_STARTED":
    case "RUN_RESUMED":
    case "RESUMED_FROM_WAIT":
    case "STEP_SELECTED":
      stage = "preparing";
      break;
    case "TOOL_CALL_STARTED":
    case "TOOL_CALL_DONE":
    case "TOOL_CALL_FAILED":
      stage = "using_capability";
      break;
    case "RUN_TERMINAL":
    case "RUN_COMPLETED":
    case "RUN_FAILED":
      stage = "finalizing";
      break;
    default:
      stage = "working";
  }
  return { stage, message: activityCopy[stage] };
}

export function mobileActivity(
  input: Exclude<MobileActivityInput, { kind: "runtime_event" }>
): MobileLiveActivity;
export function mobileActivity(input: {
  kind: "runtime_event";
  eventType: string;
  code?: string | null;
}): MobileLiveActivity | null;
export function mobileActivity(
  input: MobileActivityInput
): MobileLiveActivity | null {
  if (input.kind === "agent_progress") {
    return { stage: "working" as const, message: input.text.trim() };
  }
  if (input.kind === "tool") {
    return mobileActivityForStage("using_capability");
  }
  if (input.kind === "runtime_event") {
    if (input.eventType === "run.progress") {
      return progressActivity(input.code);
    }
    switch (input.eventType) {
      case "run.tool.started":
      case "run.tool.completed":
      case "run.tool.failed":
        return mobileActivityForStage("using_capability");
      case "run.agent_progress":
      case "run.model.reasoning.started":
      case "run.model.reasoning.delta":
      case "run.model.reasoning.completed":
      case "run.model.reasoning.failed":
      case "run.model.reasoning.unavailable":
        return mobileActivityForStage("working");
      default:
        return null;
    }
  }

  return progressActivity(input.code);
}
