export type ProfileSessionIdentity = {
  id: string;
  userAgent?: string | null;
};

export function partitionProfileSessions<T extends ProfileSessionIdentity>(
  sessions: readonly T[],
  currentSessionId?: string,
) {
  return {
    currentSession: sessions.find(
      (session) => session.id === currentSessionId,
    ),
    otherSessions: sessions.filter(
      (session) =>
        session.id !== currentSessionId && Boolean(session.userAgent),
    ),
  };
}
