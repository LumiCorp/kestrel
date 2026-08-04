export function mergePinnedFlyImageReleaseHistory<T extends { id: string }>(
  recent: T[],
  pinned: T[],
) {
  const seen = new Set(recent.map((release) => release.id));
  return [
    ...recent,
    ...pinned.filter((release) => {
      if (seen.has(release.id)) return false;
      seen.add(release.id);
      return true;
    }),
  ];
}
