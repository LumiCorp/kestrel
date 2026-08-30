import {
  resolveBlockedWaitModeReply,
  type BlockedReplyActSubmode,
  type BlockedReplyInteractionMode,
} from "../../../src/runtime/blockedWaitModeReply.js";
import { readActiveTaskGoalFromState } from "../../../src/runtime/turnObjective.js";
import {
  isHighConfidenceContinuation,
  readUserReplyIntent,
} from "../../../src/runtime/userReplyIntent.js";
import { readActiveWaitState } from "../../../src/runtime/waitState.js";
import { asRecord, asString } from "../../shared/valueAccess.js";

export interface BlockedResumeRequest {
  goal?: string;
  userRequest?: string;
  applyEventOverride: boolean;
  interactionMode?: BlockedReplyInteractionMode;
  actSubmode?: BlockedReplyActSubmode;
  resumeBlockedRun?: true;
  modeDisposition?: "resume" | "decline" | "clarify" | undefined;
}

export function resolveBlockedResumeRequest(
  reactState: Record<string, unknown>,
  event: { type: string; payload: unknown },
): BlockedResumeRequest {
  const payload = asRecord(event.payload);
  const currentMessage = asString(payload?.message)?.trim();
  const isUserReply = event.type === "user.reply";
  const waitFor = readActiveWaitState(reactState);
  const blockedModeReply =
    isUserReply === true ? resolveBlockedWaitModeReply(waitFor, currentMessage, payload?.userReplyIntent) : undefined;
  const authoritativeModeResolution = readAuthoritativeModeResolution(payload?.modeResolution);
  const transcriptGoal = readActiveTaskGoalFromState(reactState)?.trim();
  if (
    isBlockedModeResumeSignal(reactState, event.type, payload) === false &&
    blockedModeReply === undefined &&
    authoritativeModeResolution === undefined
  ) {
    return { applyEventOverride: false };
  }

  const priorGoal = transcriptGoal;
  const result: BlockedResumeRequest = {
    applyEventOverride: priorGoal !== undefined,
    ...(authoritativeModeResolution !== undefined
      ? {
          interactionMode: authoritativeModeResolution.interactionMode,
          ...(authoritativeModeResolution.actSubmode !== undefined
            ? { actSubmode: authoritativeModeResolution.actSubmode }
            : {}),
          ...(authoritativeModeResolution.disposition === "resume"
            ? { resumeBlockedRun: true as const }
            : {}),
          modeDisposition: authoritativeModeResolution.disposition,
        }
      : blockedModeReply !== undefined
      ? {
          interactionMode: blockedModeReply.interactionMode,
          ...(blockedModeReply.actSubmode !== undefined
            ? { actSubmode: blockedModeReply.actSubmode }
            : {}),
          resumeBlockedRun: true,
        }
      : {}),
  };
  if (priorGoal !== undefined) {
    result.goal = priorGoal;
    result.userRequest = priorGoal;
  }
  return result;
}

function readAuthoritativeModeResolution(value: unknown): {
  interactionMode: BlockedReplyInteractionMode;
  actSubmode?: BlockedReplyActSubmode | undefined;
  disposition: "resume" | "decline" | "clarify";
} | undefined {
  const record = asRecord(value);
  const interactionMode = record?.interactionMode;
  const actSubmode = record?.actSubmode;
  const disposition = record?.disposition;
  if (
    record?.version !== "mode_resolution_v1" ||
    (interactionMode !== "chat" && interactionMode !== "plan" && interactionMode !== "build") ||
    (disposition !== "resume" && disposition !== "decline" && disposition !== "clarify") ||
    (actSubmode !== undefined && actSubmode !== "strict" && actSubmode !== "safe" && actSubmode !== "full_auto")
  ) {
    return;
  }
  return {
    interactionMode,
    ...(actSubmode !== undefined ? { actSubmode } : {}),
    disposition,
  };
}

function isBlockedModeResumeSignal(
  reactState: Record<string, unknown>,
  eventType: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (eventType !== "user.reply") {
    return false;
  }

  const explicitResume = payload?.resumeBlockedRun === true;
  const intent = readUserReplyIntent(payload?.userReplyIntent);
  if (explicitResume !== true && isHighConfidenceContinuation(intent) === false) {
    return false;
  }

  const waitFor = readActiveWaitState(reactState);
  if (waitFor?.eventType !== "user.reply") {
    return false;
  }

  const metadata = asRecord(waitFor.metadata);
  const reason = asString(metadata?.reason);
  return (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  );
}
