import type { TuiSessionMeta } from "../../contracts.js";

export function filterSessions(sessions: TuiSessionMeta[], query: string): TuiSessionMeta[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return sessions;
  }

  return sessions.filter(
    (session) =>
      session.name.toLowerCase().includes(needle) ||
      session.sessionId.toLowerCase().includes(needle),
  );
}
