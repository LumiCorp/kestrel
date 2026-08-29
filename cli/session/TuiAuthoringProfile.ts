import type { ProfileStore } from "../config/ProfileStore.js";
import type { TuiProfile, TuiSessionMeta } from "../contracts.js";

export class TuiAuthoringProfileError extends Error {
  readonly code = "TUI_AUTHORING_PROFILE_UNAVAILABLE";
  readonly sessionId: string;
  readonly profileId: string;
  readonly details: { sessionId: string; profileId: string };

  constructor(session: TuiSessionMeta) {
    super(
      `Session '${session.name}' cannot be resumed because its authoring profile '${session.profileId}' is unavailable. Restore that profile before resuming the session.`,
    );
    this.name = "TuiAuthoringProfileError";
    this.sessionId = session.sessionId;
    this.profileId = session.profileId;
    this.details = {
      sessionId: session.sessionId,
      profileId: session.profileId,
    };
  }
}

export function resolveStartedSessionAuthoringProfile(input: {
  session?: TuiSessionMeta | undefined;
  profiles: TuiProfile[];
  profileStore: ProfileStore;
}): TuiProfile | undefined {
  if (input.session === undefined || hasDurableTuiRuntimeBinding(input.session) === false) {
    return undefined;
  }
  const profile = input.profileStore.findById(input.profiles, input.session.profileId);
  if (profile === undefined) {
    throw new TuiAuthoringProfileError(input.session);
  }
  return profile;
}

export function hasDurableTuiRuntimeBinding(session: TuiSessionMeta): boolean {
  return session.started === true
    || session.effectiveAssemblyId !== undefined
    || session.focusedThreadId !== undefined
    || session.acceptedRunThreadId !== undefined
    || (session.queuedRunReservations?.length ?? 0) > 0
    || (session.terminalQueuedRuns?.length ?? 0) > 0;
}
