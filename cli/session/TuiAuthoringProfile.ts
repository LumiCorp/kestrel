import type { ProfileStore } from "../config/ProfileStore.js";
import type { TuiProfile, TuiSessionMeta } from "../contracts.js";

export class TuiAuthoringProfileError extends Error {
  readonly sessionId: string;
  readonly profileId: string;

  constructor(session: TuiSessionMeta) {
    super(
      `Started session '${session.name}' cannot be resumed because its authoring profile '${session.profileId}' is unavailable. Restore that profile before resuming the session.`,
    );
    this.name = "TuiAuthoringProfileError";
    this.sessionId = session.sessionId;
    this.profileId = session.profileId;
  }
}

export function resolveStartedSessionAuthoringProfile(input: {
  session?: TuiSessionMeta | undefined;
  profiles: TuiProfile[];
  profileStore: ProfileStore;
}): TuiProfile | undefined {
  if (input.session?.started !== true) return undefined;
  const profile = input.profileStore.findById(input.profiles, input.session.profileId);
  if (profile === undefined) {
    throw new TuiAuthoringProfileError(input.session);
  }
  return profile;
}
