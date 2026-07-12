import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsShell } from "@/components/DocsShell";
import { getNavigation, getPageMetaBySlug, getRelatedPages, getRenderedPageBySlug, getSectionPages } from "@/lib/content";
import { SITE_TITLE } from "@/lib/site";

function RelatedPages({ pages }: { pages: Awaited<ReturnType<typeof getRelatedPages>> }) {
  if (pages.length === 0) {
    return null;
  }

  return (
    <section className="related-pages">
      <div className="section-listing-header">
        <h2>Related pages</h2>
      </div>
      <div className="related-grid">
        {pages.map((page) => (
          <article key={page.url} className="related-card">
            <h3>
              <a href={page.url}>{page.title}</a>
            </h3>
            <p>{page.summary}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SectionListing({ pages, currentUrl }: { pages: Awaited<ReturnType<typeof getSectionPages>>; currentUrl: string }) {
  const includeArchiveEntries = currentUrl === "/archive";
  const listing = pages.filter((page) => page.meta.url !== currentUrl && (includeArchiveEntries || !page.meta.archive));
  if (listing.length === 0) {
    return null;
  }

  return (
    <section className="section-listing">
      <div className="section-listing-header">
        <h2>Pages in this section</h2>
      </div>
      <div className="related-grid">
        {listing.map((page) => (
          <article key={page.meta.url} className="related-card">
            <h3>
              <a href={page.meta.url}>{page.meta.title}</a>
            </h3>
            <p>{page.meta.summary}</p>
            {page.meta.archiveGroup ? <div className="archive-chip">{page.meta.archiveGroup}</div> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export async function generateStaticParams() {
  const { getPublicPages } = await import("@/lib/content");
  const pages = await getPublicPages();
  return pages
    .map((page) => page.meta)
    .filter((page) => page.slug.length > 0)
    .map((page) => ({
      slug: page.slug,
    }));
}

export const dynamicParams = false;

export async function generateMetadata(props: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const meta = await getPageMetaBySlug(params.slug);

  if (!meta) {
    return {};
  }

  return {
    title: meta.title,
    description: meta.summary,
    keywords: [meta.section, SITE_TITLE],
  };
}

export default async function DocsPageRoute(props: {
  params: Promise<{ slug: string[] }>;
}) {
  const params = await props.params;
  const [page, navigation] = await Promise.all([getRenderedPageBySlug(params.slug), getNavigation()]);

  if (!page) {
    notFound();
  }

  const [relatedPages, sectionPages] = await Promise.all([
    getRelatedPages(page.meta),
    page.meta.slug.length === 1 ? getSectionPages(page.meta.section) : Promise.resolve([]),
  ]);

  return (
    <DocsShell
      currentUrl={page.meta.url}
      navigation={navigation}
      pageMeta={page.meta}
      toc={page.meta.toc}
      sectionListing={<SectionListing pages={sectionPages} currentUrl={page.meta.url} />}
      relatedListing={page.meta.slug[0] === "archive" ? null : <RelatedPages pages={relatedPages} />}
    >
      {page.content}
    </DocsShell>
  );
}
