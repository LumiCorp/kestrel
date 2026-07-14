import type MiniSearch from "minisearch";

import type { SearchDocument, SearchResultEntry } from "@/lib/types";

export const SEARCH_FIELDS = ["title", "summary", "headings", "fullText", "capabilities"] as const;
export const SEARCH_STORE_FIELDS = [
  "id",
  "url",
  "title",
  "summary",
  "section",
  "navSection",
  "priority",
  "capabilities",
  "headings",
] as const;
export const MAX_SEARCH_RESULTS = 12;
const DEFAULT_RESULT_COUNT = 8;

type SearchResultCandidate = SearchResultEntry & {
  headings: string[];
  priority: number;
  score?: number;
};

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function getQueryTerms(query: string) {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function haystackIncludes(haystack: string, needle: string) {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function haystackIncludesAllTerms(haystack: string, terms: string[]) {
  const normalized = normalizeText(haystack);
  return terms.every((term) => normalized.includes(term));
}

function toEntry(document: SearchDocument): SearchResultEntry {
  return {
    id: document.id,
    url: document.url,
    title: document.title,
    summary: document.summary,
    section: document.section,
    navSection: document.navSection,
    capabilities: document.capabilities,
  };
}

export function getDefaultSearchResults(documents: SearchDocument[]) {
  const ranked = documents
    .filter(
      (document) =>
        document.sourceKind !== "archived" &&
        document.internal === false &&
        document.archetype !== "gateway",
    )
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.url.localeCompare(right.url);
    });

  const selected: SearchDocument[] = [];
  for (const section of ["start", "desktop", "kestrel-one", "build", "operate", "reference"] as const) {
    const representative = ranked.find((document) => document.navSection === section);
    if (representative) selected.push(representative);
  }
  for (const document of ranked) {
    if (selected.length >= DEFAULT_RESULT_COUNT) break;
    if (!selected.includes(document)) selected.push(document);
  }
  return selected.map(toEntry);
}

function rerankSearchCandidate(candidate: SearchResultCandidate, query: string) {
  const normalizedQuery = normalizeText(query);
  const terms = getQueryTerms(query);
  const title = candidate.title;
  const headingsText = candidate.headings.join(" ");
  const capabilitiesText = candidate.capabilities.join(" ");

  let score = (candidate.score ?? 0) * 100;
  score += candidate.priority * 10;

  if (haystackIncludes(title, normalizedQuery)) {
    score += 600;
  } else if (haystackIncludesAllTerms(title, terms)) {
    score += 350;
  }

  if (capabilitiesText.length > 0) {
    if (haystackIncludes(capabilitiesText, normalizedQuery)) {
      score += 450;
    } else if (haystackIncludesAllTerms(capabilitiesText, terms)) {
      score += 250;
    }
  }

  if (headingsText.length > 0) {
    if (haystackIncludes(headingsText, normalizedQuery)) {
      score += 250;
    } else if (haystackIncludesAllTerms(headingsText, terms)) {
      score += 150;
    }
  }

  return score;
}

export function searchWithIndex(engine: Pick<MiniSearch<SearchDocument>, "search">, query: string) {
  const matches = engine.search(query, { prefix: query.length > 2 });
  const reranked = matches
    .map((match) => ({
      id: String(match.id),
      url: String(match.url),
      title: String(match.title),
      summary: String(match.summary),
      section: match.section as SearchDocument["section"],
      navSection: match.navSection as SearchDocument["navSection"],
      priority: Number(match.priority),
      capabilities: Array.isArray(match.capabilities) ? (match.capabilities as SearchDocument["capabilities"]) : [],
      headings: Array.isArray(match.headings) ? (match.headings as string[]) : [],
      score: match.score,
    }))
    .sort((left, right) => rerankSearchCandidate(right, query) - rerankSearchCandidate(left, query))
    .slice(0, MAX_SEARCH_RESULTS);

  return reranked.map<SearchResultEntry>(({ headings: _headings, priority: _priority, score: _score, ...result }) => result);
}
