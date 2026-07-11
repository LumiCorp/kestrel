"use client";

import MiniSearch from "minisearch";
import Link from "next/link";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

import { SEARCH_FIELDS, SEARCH_STORE_FIELDS, searchWithIndex } from "@/lib/search-utils";
import type { SearchDocument, SearchResultEntry } from "@/lib/types";

interface SearchClientProps {
  initialResults: SearchResultEntry[];
  serializedIndex: string;
}

export function SearchClient({ initialResults, serializedIndex }: SearchClientProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [engine] = useState(
    () =>
      MiniSearch.loadJSON<SearchDocument>(serializedIndex, {
        fields: [...SEARCH_FIELDS],
        storeFields: [...SEARCH_STORE_FIELDS],
      }),
  );
  const [results, setResults] = useState<SearchResultEntry[]>(initialResults);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();

    startTransition(() => {
      if (normalizedQuery.length === 0) {
        setResults(initialResults);
        return;
      }

      setResults(searchWithIndex(engine, normalizedQuery));
    });
  }, [deferredQuery, engine, initialResults]);

  return (
    <div className="search-flow">
      <label className="search-label" htmlFor="docs-search">
        Search across titles, summaries, headings, and full page text.
      </label>
      <input
        id="docs-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="search-input"
        placeholder="Search Kestrel runtime, apps, CLI, packages, and archive"
      />
      <div className="search-results">
        {results.map((result) => (
          <h2 key={result.url} className="search-result-title">
            <Link href={result.url}>{result.title}</Link>
          </h2>
        ))}
        {results.length === 0 ? <p className="search-empty">No pages matched the current query.</p> : null}
      </div>
    </div>
  );
}
