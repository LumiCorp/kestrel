export const PROJECT_TABS = [
  "overview",
  "context",
  "members",
  "apps",
  "activity",
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export function resolveProjectTab(input: {
  tab: string | null;
  hasGoogle: boolean;
}): ProjectTab {
  if (input.hasGoogle) return "apps";
  return PROJECT_TABS.includes(input.tab as ProjectTab)
    ? (input.tab as ProjectTab)
    : "overview";
}

export function projectTabHref(projectId: string, tab: ProjectTab) {
  const base = `/projects/${projectId}`;
  return tab === "overview" ? base : `${base}?tab=${tab}`;
}
