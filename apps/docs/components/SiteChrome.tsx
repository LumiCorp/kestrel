"use client";

import MiniSearch from "minisearch";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SEARCH_FIELDS, SEARCH_STORE_FIELDS, searchWithIndex } from "@/lib/search-utils";
import type { DocsNavSection, NavGroup, SearchDocument, SearchResultEntry } from "@/lib/types";

interface SiteChromeProps {
  navigation: NavGroup[];
  currentUrl: string;
  activeSection?: DocsNavSection;
}

interface SearchPayload {
  initialResults: SearchResultEntry[];
  serializedIndex: string;
}

function MobileMenu({ navigation, currentUrl }: Omit<SiteChromeProps, "activeSection">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => dialogRef.current?.close(), []);
  const open = useCallback(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  return (
    <>
      <button ref={triggerRef} type="button" className="header-action mobile-menu-trigger" onClick={open}>
        Menu
      </button>
      <dialog
        ref={dialogRef}
        className="mobile-nav-dialog"
        aria-labelledby="mobile-nav-title"
        onClose={() => triggerRef.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="mobile-nav-panel">
          <div className="dialog-heading-row">
            <strong id="mobile-nav-title">Browse the docs</strong>
            <button type="button" className="dialog-close" onClick={close}>Close</button>
          </div>
          <nav aria-label="Mobile documentation">
            {navigation.map((section) => (
              <section className="mobile-nav-section" key={section.section}>
                <Link className="mobile-nav-section-title" href={section.landing?.url ?? "/"} onClick={close}>
                  {section.title}
                </Link>
                {section.groups.map((group) => (
                  <div className="mobile-nav-group" key={`${section.section}-${group.title}`}>
                    <span>{group.title}</span>
                    {group.entries.map((entry) => (
                      <Link
                        key={entry.url}
                        href={entry.url}
                        onClick={close}
                        aria-current={currentUrl === entry.url ? "page" : undefined}
                      >
                        {entry.title}
                      </Link>
                    ))}
                  </div>
                ))}
              </section>
            ))}
            <section className="mobile-nav-section mobile-nav-external" aria-label="Kestrel links">
              <a href="https://lumicorp.ai">lumicorp.ai</a>
              <a href="https://github.com/LumiCorp/kestrel">GitHub</a>
            </section>
          </nav>
        </div>
      </dialog>
    </>
  );
}

function SearchDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const engine = useMemo(() => {
    if (!payload) return null;
    return MiniSearch.loadJSON<SearchDocument>(payload.serializedIndex, {
      fields: [...SEARCH_FIELDS],
      storeFields: [...SEARCH_STORE_FIELDS],
    });
  }, [payload]);

  const results = useMemo(() => {
    if (!(payload && engine)) return [];
    return query.trim().length === 0 ? payload.initialResults : searchWithIndex(engine, query);
  }, [engine, payload, query]);

  const loadIndex = useCallback(async () => {
    if (payload || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch("/search-index.json");
      if (!response.ok) throw new Error(`Search index failed with ${response.status}.`);
      setPayload((await response.json()) as SearchPayload);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [loading, payload]);

  const open = useCallback(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    void loadIndex();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [loadIndex]);

  const close = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => setSelectedIndex(0), [query]);

  const choose = useCallback((url: string) => {
    close();
    router.push(url);
  }, [close, router]);

  return (
    <>
      <button ref={triggerRef} type="button" className="header-action search-trigger" onClick={open}>
        <span>Search</span><kbd>⌘K</kbd>
      </button>
      <dialog
        ref={dialogRef}
        className="search-dialog"
        aria-labelledby="search-dialog-title"
        onClose={() => {
          setQuery("");
          triggerRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="search-dialog-panel">
          <div className="dialog-heading-row">
            <strong id="search-dialog-title">Search Kestrel Docs</strong>
            <button type="button" className="dialog-close" onClick={close}>Close</button>
          </div>
          <label className="sr-only" htmlFor="global-docs-search">Search documentation</label>
          <input
            ref={inputRef}
            id="global-docs-search"
            className="dialog-search-input"
            type="search"
            autoComplete="off"
            placeholder="Search Desktop, SDK, deployment, CLI…"
            value={query}
            aria-controls="global-search-results"
            aria-activedescendant={results[selectedIndex] ? `global-result-${selectedIndex}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter" && results[selectedIndex]) {
                event.preventDefault();
                choose(results[selectedIndex].url);
              }
            }}
          />
          <div id="global-search-results" className="dialog-search-results" role="listbox" aria-label="Search results">
            {loading ? <p className="search-status">Loading search…</p> : null}
            {failed ? <p className="search-status">Search could not load. Use the full search page instead.</p> : null}
            {!(loading || failed ) && results.length === 0 ? <p className="search-status">No public pages match that search.</p> : null}
            {results.map((result, index) => (
              <button
                key={result.url}
                id={`global-result-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`dialog-result ${index === selectedIndex ? "is-selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => choose(result.url)}
              >
                <span className="dialog-result-meta">{result.navSection}</span>
                <strong>{result.title}</strong>
                <span>{result.summary}</span>
              </button>
            ))}
          </div>
          <Link className="full-search-link" href={query ? `/search?q=${encodeURIComponent(query)}` : "/search"} onClick={close}>
            Open full search
          </Link>
        </div>
      </dialog>
    </>
  );
}

export function SiteChrome({ navigation, currentUrl, activeSection }: SiteChromeProps) {
  return (
    <header className="global-header">
      <div className="global-header-inner">
        <Link href="/" className="global-brand" aria-label="Kestrel Docs home">
          <Image src="/brand/kestrel-mark.png" width={32} height={32} alt="" priority />
          <span>Kestrel <strong>Docs</strong></span>
        </Link>
        <nav className="global-nav" aria-label="Primary documentation">
          {navigation.map((group) => (
            <Link
              key={group.section}
              href={group.landing?.url ?? "/"}
              aria-current={activeSection === group.section ? "page" : undefined}
            >
              {group.title}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <a className="lumicorp-link" href="https://lumicorp.ai">lumicorp.ai</a>
          <SearchDialog />
          <a className="github-link" href="https://github.com/LumiCorp/kestrel">GitHub</a>
          <MobileMenu navigation={navigation} currentUrl={currentUrl} />
        </div>
      </div>
    </header>
  );
}
