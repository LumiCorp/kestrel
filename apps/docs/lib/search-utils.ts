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
  "internal",
  "sourceKind",
  "pageKind",
  "priority",
  "capabilities",
  "headings",
] as const;
export const MAX_SEARCH_RESULTS = 12;
const DEFAULT_RESULT_COUNT = 8;

type SearchResultCandidate = SearchResultEntry & {
  headings: string[];
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
    internal: document.internal,
    sourceKind: document.sourceKind,
    pageKind: document.pageKind,
    priority: document.priority,
    capabilities: document.capabilities,
  };
}

export function getDefaultSearchResults(documents: SearchDocument[]) {
  return documents
    .filter(
      (document) =>
        document.sourceKind !== "archived" &&
        document.internal === false &&
        document.pageKind !== "landing" &&
        document.pageKind !== "home",
    )
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.url.localeCompare(right.url);
    })
    .slice(0, DEFAULT_RESULT_COUNT)
    .map(toEntry);
}

function rerankSearchCandidate(candidate: SearchResultCandidate, query: string) {
  const normalizedQuery = normalizeText(query);
  const terms = getQueryTerms(query);
  const title = candidate.title;
  const headingsText = candidate.headings.join(" ");
  const capabilitiesText = candidate.capabilities.join(" ");

  let score = (candidate.score ?? 0) * 100;
  score += candidate.priority * 10;

  if (candidate.sourceKind === "curated") {
    score += 200;
  } else if (candidate.sourceKind === "repo-inferred") {
    score += 100;
  } else {
    score -= 400;
  }

  if (candidate.pageKind === "home") {
    score += 40;
  } else if (candidate.pageKind === "tutorial") {
    score += 90;
  } else if (candidate.pageKind === "narrative") {
    score += 70;
  } else if (candidate.pageKind === "reference") {
    score += 60;
  } else if (candidate.pageKind === "landing") {
    score -= 20;
  } else {
    score -= 150;
  }

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
      internal: Boolean(match.internal),
      sourceKind: match.sourceKind as SearchDocument["sourceKind"],
      pageKind: match.pageKind as SearchDocument["pageKind"],
      priority: Number(match.priority),
      capabilities: Array.isArray(match.capabilities) ? (match.capabilities as SearchDocument["capabilities"]) : [],
      headings: Array.isArray(match.headings) ? (match.headings as string[]) : [],
      score: match.score,
    }))
    .sort((left, right) => rerankSearchCandidate(right, query) - rerankSearchCandidate(left, query))
    .slice(0, MAX_SEARCH_RESULTS);

  return reranked.map<SearchResultEntry>(({ headings: _headings, score: _score, ...result }) => result);
}
