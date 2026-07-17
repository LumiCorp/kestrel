import type { DocsJourneyId, DocsPageMeta, JourneyMeta } from "@/lib/types";

interface JourneyDefinition {
  label: string;
  urls: readonly string[];
}

export const DOCS_JOURNEYS: Record<DocsJourneyId, JourneyDefinition> = {
  "desktop-first-success": {
    label: "Your first durable Desktop session",
    urls: [
      "/desktop/install",
      "/desktop/first-run",
      "/desktop/workspaces-and-sessions",
      "/desktop/operator-control",
      "/desktop/recovery",
    ],
  },
  "kestrel-one-collaboration": {
    label: "Move work forward with your team",
    urls: [
      "/kestrel-one/getting-started",
      "/kestrel-one/threads",
      "/kestrel-one/projects",
      "/kestrel-one/context-revisions",
      "/kestrel-one/knowledge",
      "/kestrel-one/artifacts-and-sharing",
    ],
  },
  "workspace-copilot-build": {
    label: "Build a durable Workspace Copilot",
    urls: [
      "/build/building-your-first-agent",
      "/build/running-your-first-streamed-request",
      "/build/adding-session-memory",
      "/build/integrating-with-nextjs",
      "/build/waiting-resume-and-cancellation",
      "/build/adding-observability",
    ],
  },
};

export function buildJourneyMeta(
  journeyId: DocsJourneyId | undefined,
  currentUrl: string,
  pagesByUrl: ReadonlyMap<string, Pick<DocsPageMeta, "title" | "url">>,
): JourneyMeta | undefined {
  if (!journeyId) return ;
  const journey = DOCS_JOURNEYS[journeyId];
  const index = journey.urls.indexOf(currentUrl);
  if (index === -1) {
    throw new Error(`Docs journey '${journeyId}' does not contain '${currentUrl}'.`);
  }
  const pageLink = (url: string | undefined) => {
    if (!url) return ;
    const page = pagesByUrl.get(url);
    if (!page) throw new Error(`Docs journey '${journeyId}' references missing page '${url}'.`);
    return { title: page.title, url: page.url };
  };

  return {
    id: journeyId,
    label: journey.label,
    step: index + 1,
    total: journey.urls.length,
    previous: pageLink(journey.urls[index - 1]),
    next: pageLink(journey.urls[index + 1]),
  };
}
