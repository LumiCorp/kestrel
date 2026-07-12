import Link from "next/link";
import React from "react";
import type { ReactNode } from "react";

import { SiteChrome } from "@/components/SiteChrome";
import { getNavSectionForUrl } from "@/lib/content";
import type { DocsPageMeta, NavGroup, TocItem } from "@/lib/types";

interface DocsShellProps {
  currentUrl: string;
  navigation: NavGroup[];
  children: ReactNode;
  pageMeta?: DocsPageMeta;
  toc?: TocItem[];
  sectionListing?: ReactNode;
  relatedListing?: ReactNode;
  renderChrome?: boolean;
}

function LocalNavigation({ currentUrl, navigation }: { currentUrl: string; navigation: NavGroup[] }) {
  const activeSection = getNavSectionForUrl(currentUrl);
  const section = navigation.find((candidate) => candidate.section === activeSection) ?? navigation[0];
  if (!section) return null;

  return (
    <aside className="local-sidebar" aria-label={`${section.title} documentation`}>
      <div className="local-sidebar-inner">
        <Link className="local-sidebar-title" href={section.landing?.url ?? "/"}>{section.title}</Link>
        {section.groups.map((group) => (
          <nav className="local-nav-group" key={group.title} aria-label={group.title}>
            <span className="local-nav-group-title">{group.title}</span>
            {group.entries.map((entry) => (
              <Link key={entry.url} href={entry.url} aria-current={currentUrl === entry.url ? "page" : undefined}>
                {entry.title}
              </Link>
            ))}
          </nav>
        ))}
      </div>
    </aside>
  );
}

export function DocsShell(props: DocsShellProps) {
  const { children, currentUrl, navigation, pageMeta, toc = [], sectionListing, relatedListing, renderChrome = true } = props;
  const isWidePage = !pageMeta;
  const navSection = getNavSectionForUrl(currentUrl);

  return (
    <div className="site-frame">
      {renderChrome ? <SiteChrome navigation={navigation} currentUrl={currentUrl} activeSection={pageMeta ? navSection : undefined} /> : null}
      <div className={`site-body ${isWidePage ? "site-body-wide" : ""}`}>
        {pageMeta ? <LocalNavigation currentUrl={currentUrl} navigation={navigation} /> : null}
        <main id="app-main" className="content-column">
          {pageMeta ? (
            <header className="article-header">
              <div className="article-kicker">{navSection}</div>
              <h1>{pageMeta.title}</h1>
              <p className="article-summary">{pageMeta.summary}</p>
              <div className="article-details">
                <span>Updated {pageMeta.updatedAt}</span>
                <a href={pageMeta.sourceUrl}>View source</a>
              </div>
            </header>
          ) : null}
          <article className={pageMeta ? "doc-prose" : "wide-page-content"}>{children}</article>
          {sectionListing}
          {relatedListing}
        </main>
        {pageMeta && toc.length > 0 ? (
          <aside className="toc-column" aria-label="On this page">
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
          </aside>
        ) : null}
      </div>
    </div>
  );
}
