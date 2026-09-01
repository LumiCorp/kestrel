import {
  normalizeInteractionMode,
  type ActSubmode,
  type InteractionMode,
  type ModeResolutionV1,
  type ToolExecutionClass,
} from "../mode/contracts.js";
import {
  parseExplicitModeCommand,
  type UserReplyIntent,
} from "./userReplyIntent.js";

export interface RuntimeModeBlockedRequest {
  requestId: string;
  runId: string;
  eventType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeModeReplyResolution {
  modeResolution: ModeResolutionV1;
  userReplyIntent: UserReplyIntent;
  requiredMode: InteractionMode;
}

export async function resolveModeBlockedReplyAtRuntime(input: {
  request: RuntimeModeBlockedRequest;
  message: string;
  currentMode: InteractionMode;
  currentActSubmode?: ActSubmode | undefined;
  explicitInteractionMode?: InteractionMode | undefined;
  explicitActSubmode?: ActSubmode | undefined;
  classify: () => Promise<UserReplyIntent>;
}): Promise<RuntimeModeReplyResolution | undefined> {
  if (isRuntimeModeBlockedRequest(input.request) === false) return;
  const requiredMode = modeForToolClass(input.request.metadata?.requiredToolClass);
  const explicit = parseExplicitModeCommand(input.message) ?? (
    input.explicitInteractionMode === undefined
      ? undefined
      : {
          interactionMode: input.explicitInteractionMode,
          ...(input.explicitActSubmode !== undefined
            ? { actSubmode: input.explicitActSubmode }
            : {}),
        }
  );
  if (explicit !== undefined) {
    const effective = normalizeInteractionMode({
      interactionMode: explicit.interactionMode,
      actSubmode: explicit.actSubmode,
      defaultInteractionMode: input.currentMode,
      defaultActSubmode: input.currentActSubmode,
    });
    return {
      requiredMode,
      userReplyIntent: {
        kind: "mode_switch",
        proceed: true,
        interactionMode: effective.interactionMode,
        ...(effective.actSubmode !== undefined ? { actSubmode: effective.actSubmode } : {}),
        confidence: "high",
        reason: "explicit_mode_command",
      },
      modeResolution: createModeResolution({
        request: input.request,
        effective,
        source: "explicit_command",
        disposition: effective.interactionMode === requiredMode ? "resume" : "decline",
      }),
    };
  }

  const intent = await input.classify();
  const selectedMode = intent.kind === "mode_switch" && intent.proceed === true
    ? intent.interactionMode ?? requiredMode
    : input.currentMode;
  const effective = normalizeInteractionMode({
    interactionMode: selectedMode,
    actSubmode: intent.actSubmode ?? input.currentActSubmode,
    defaultInteractionMode: input.currentMode,
    defaultActSubmode: input.currentActSubmode,
  });
  const disposition = intent.kind === "mode_switch" && intent.confidence === "high"
    ? intent.proceed === false
      ? "decline"
      : effective.interactionMode === requiredMode ? "resume" : "decline"
    : "clarify";
  return {
    requiredMode,
    userReplyIntent: intent,
    modeResolution: createModeResolution({
      request: input.request,
      effective,
      source: "classified_reply",
      disposition,
    }),
  };
}

export function isRuntimeModeBlockedRequest(request: RuntimeModeBlockedRequest): boolean {
  const reason = request.metadata?.reason;
  return request.eventType === "user.reply" && (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  );
}

function createModeResolution(input: {
  request: RuntimeModeBlockedRequest;
  effective: { interactionMode: InteractionMode; actSubmode?: ActSubmode | undefined };
  source: ModeResolutionV1["source"];
  disposition: ModeResolutionV1["disposition"];
}): ModeResolutionV1 {
  return {
    version: "mode_resolution_v1",
    requestId: input.request.requestId,
    runId: input.request.runId,
    interactionMode: input.effective.interactionMode,
    ...(input.effective.actSubmode !== undefined ? { actSubmode: input.effective.actSubmode } : {}),
    source: input.source,
    disposition: input.disposition,
  };
}

function modeForToolClass(value: unknown): InteractionMode {
  const toolClass = value as ToolExecutionClass | undefined;
  return toolClass === "read_only" || toolClass === "planning_write" ? "plan" : "build";
}
