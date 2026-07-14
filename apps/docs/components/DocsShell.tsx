import Link from "next/link";
import React from "react";
import type { ReactNode } from "react";

import { SiteChrome } from "@/components/SiteChrome";
import { getNavSectionForUrl } from "@/lib/content";
import { DOCS_RELEASE } from "@/lib/release";
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
  const reportIssueUrl = pageMeta
    ? `https://github.com/LumiCorp/kestrel/issues/new?title=${encodeURIComponent(`Docs: ${pageMeta.title}`)}&body=${encodeURIComponent(`Page: ${pageMeta.url}\n\nWhat was unclear or incorrect?\n`)}`
    : null;
  const surfaceLabels: Partial<Record<NonNullable<DocsPageMeta["surface"]>, string>> = {
    "kestrel-one": "Kestrel One",
    cli: "CLI",
    nextjs: "Next.js",
    sdk: "SDK",
  };
  const surfaceLabel = pageMeta
    ? surfaceLabels[pageMeta.surface] ?? pageMeta.surface.replace(/^./u, (letter) => letter.toUpperCase())
    : undefined;

  return (
    <div className="site-frame">
      {renderChrome ? <SiteChrome navigation={navigation} currentUrl={currentUrl} activeSection={pageMeta ? navSection : undefined} /> : null}
      <div className={`site-body ${isWidePage ? "site-body-wide" : ""} ${pageMeta ? `site-body-${pageMeta.archetype}` : ""}`}>
        {pageMeta ? <LocalNavigation currentUrl={currentUrl} navigation={navigation} /> : null}
        <main id="app-main" className="content-column" tabIndex={-1}>
          {pageMeta ? (
            <header className="article-header">
              <div className="article-kicker">{navSection}</div>
              <h1>{pageMeta.title}</h1>
              <p className="article-summary">{pageMeta.summary}</p>
              <div className="article-facts" aria-label="Page details">
                <span>{surfaceLabel}</span>
                <span>{pageMeta.experienceLevel}</span>
                {pageMeta.estimatedTime ? <span>{pageMeta.estimatedTime}</span> : null}
                <span>{DOCS_RELEASE.version} {DOCS_RELEASE.channel}</span>
              </div>
              <div className="article-details">
                <span>Verified {pageMeta.updatedAt}</span>
                <a href={pageMeta.sourceUrl}>View source</a>
                {reportIssueUrl ? <a href={reportIssueUrl}>Report a docs issue</a> : null}
              </div>
            </header>
          ) : null}
          <article className={pageMeta ? "doc-prose" : "wide-page-content"}>{children}</article>
          {pageMeta?.journey ? (
            <nav className="journey-navigation" aria-label={`${pageMeta.journey.label} progress`}>
              <div className="journey-progress">
                <span>{pageMeta.journey.label}</span>
                <strong>Step {pageMeta.journey.step} of {pageMeta.journey.total}</strong>
              </div>
              <div className="journey-links">
                {pageMeta.journey.previous ? (
                  <Link href={pageMeta.journey.previous.url}>← {pageMeta.journey.previous.title}</Link>
                ) : <span />}
                {pageMeta.journey.next ? (
                  <Link href={pageMeta.journey.next.url}>{pageMeta.journey.next.title} →</Link>
                ) : null}
              </div>
            </nav>
          ) : null}
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
