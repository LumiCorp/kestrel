import Link from "next/link";
import React, { type ReactNode } from "react";

import { SITE_TITLE } from "@/lib/site";
import type { DocsPageMeta, NavGroup, TocItem } from "@/lib/types";

interface DocsShellProps {
  currentUrl: string;
  navigation: NavGroup[];
  children: ReactNode;
  pageMeta?: DocsPageMeta;
  toc?: TocItem[];
  sectionListing?: ReactNode;
  relatedListing?: ReactNode;
}

function MetaBadge({ label }: { label: string }) {
  return <span className="meta-badge">{label}</span>;
}

export function DocsShell(props: DocsShellProps) {
  const { children, currentUrl, navigation, pageMeta, toc = [], sectionListing, relatedListing } = props;

  return (
    <div className="site-frame">
      <aside className="site-sidebar" aria-label="Primary">
        <div className="sidebar-inner">
          <Link href="/" className="brandmark">
            <span className="brandmark-kicker">Kestrel</span>
            <strong>{SITE_TITLE}</strong>
          </Link>
          <p className="sidebar-copy">
            Durable runtime documentation for product teams, integrators, and maintainers.
          </p>
          <nav className="sidebar-nav">
            <Link href="/search" className={`nav-search-link ${currentUrl === "/search" ? "is-active" : ""}`}>
              Search
            </Link>
            {navigation.map((group) => (
              <section key={group.section} className="nav-group">
                <div className="nav-group-title">{group.title}</div>
                {group.landing ? (
                  <Link
                    href={group.landing.url}
                    className={`nav-link nav-link-landing ${currentUrl === group.landing.url ? "is-active" : ""}`}
                  >
                    {group.landing.title}
                  </Link>
                ) : null}
                {group.entries.map((entry) => (
                  <Link
                    key={entry.url}
                    href={entry.url}
                    className={`nav-link ${currentUrl === entry.url ? "is-active" : ""}`}
                  >
                    {entry.title}
                  </Link>
                ))}
              </section>
            ))}
          </nav>
        </div>
      </aside>
      <div className="site-column">
        <header className="site-header">
          <div className="site-header-copy">
            <span className="header-kicker">Editorial docs</span>
            <h1 className="site-header-title">{pageMeta?.title ?? SITE_TITLE}</h1>
          </div>
          <Link href="/search" className="header-search-link">
            Search the docs
          </Link>
        </header>
        <div className="site-body">
          <main id="app-main" className="content-column">
            {pageMeta ? (
              <div className="article-meta">
                <div className="article-badges">
                  <MetaBadge label={pageMeta.section} />
                  {pageMeta.internal ? <MetaBadge label="internal" /> : null}
                  {pageMeta.archive ? <MetaBadge label="archived" /> : null}
                  {pageMeta.sourceKind === "repo-inferred" ? <MetaBadge label="repo-inferred" /> : null}
                </div>
                <p className="article-summary">{pageMeta.summary}</p>
              </div>
            ) : null}
            <article className="doc-prose">{children}</article>
            {sectionListing}
            {relatedListing}
          </main>
          <aside className="toc-column" aria-label="On this page">
            {toc.length > 0 ? (
              <div className="toc-card">
                <div className="toc-title">On this page</div>
                <ol className="toc-list">
                  {toc.map((item) => (
                    <li key={item.id} className={`toc-item toc-level-${item.level}`}>
                      <a href={`#${item.id}`}>{item.text}</a>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="toc-card toc-card-muted">
                <div className="toc-title">This page</div>
                <p className="toc-empty">The page is intentionally compact.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
