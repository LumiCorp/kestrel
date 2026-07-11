import { DocsShell } from "@/components/DocsShell";
import { HomePage } from "@/components/HomePage";
import { getNavigation, getRenderedPageBySlug } from "@/lib/content";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site";

export default async function HomeRoute() {
  const [page, navigation] = await Promise.all([getRenderedPageBySlug([]), getNavigation()]);

  if (!page) {
    throw new Error("Home page content is not registered.");
  }

  return (
    <DocsShell currentUrl="/" navigation={navigation}>
      <HomePage page={page} />
      <section className="section-listing">
        <div className="section-listing-header">
          <h2>Choose a path</h2>
          <p>
            {SITE_TITLE} starts with product narrative, then moves into building, deploying, operating, and extending
            the runtime with concrete examples.
          </p>
        </div>
        <div className="section-listing-grid">
          {navigation
            .filter((group) => group.section !== "home")
            .map((group) => (
              <article key={group.section} className="section-listing-card">
                <h3>{group.title}</h3>
                <p>{group.landing?.summary ?? SITE_DESCRIPTION}</p>
                {group.landing ? (
                  <a href={group.landing.url} className="section-listing-link">
                    Open {group.title}
                  </a>
                ) : null}
              </article>
            ))}
        </div>
      </section>
    </DocsShell>
  );
}
