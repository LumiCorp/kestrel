import Link from "next/link";

import type { RenderedPage } from "@/lib/types";

interface HomePageProps {
  page: RenderedPage;
}

const startHereCollections = [
  {
    title: "Start With Desktop",
    description: "See the flagship Kestrel product surface first, then branch into the suite around it.",
    links: [
      { href: "/apps/desktop", label: "Desktop app" },
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/why-kestrel", label: "Why Kestrel" },
    ],
  },
  {
    title: "Use Companion Surfaces",
    description: "Move into the browser product, terminal workflows, and evaluation tooling once the Desktop story is clear.",
    links: [
      { href: "/apps/web", label: "Web app" },
      { href: "/cli", label: "CLI" },
      { href: "/operations/evaluations", label: "Ruhroh evaluations" },
    ],
  },
  {
    title: "Extend The Suite",
    description: "Use the runner service, packages, and operations docs when you need to embed or extend Kestrel beyond the flagship app.",
    links: [
      { href: "/packages/sdk", label: "SDK reference" },
      { href: "/deploy/running-the-runner-service", label: "Runner service" },
      { href: "/operations", label: "Operations" },
    ],
  },
];

export function HomePage({ page }: HomePageProps) {
  return (
    <div className="home-flow">
      <section className="home-intro">
        <div className="home-kicker">Open runtime platform for durable agents</div>
        <h2 className="home-title">{page.meta.title}</h2>
        <p className="home-summary">{page.meta.summary}</p>
      </section>
      <article className="doc-prose doc-prose-home">{page.content}</article>
      <section className="start-grid" aria-label="Start here">
        {startHereCollections.map((collection) => (
          <section key={collection.title} className="start-card">
            <h3>{collection.title}</h3>
            <p>{collection.description}</p>
            <div className="start-links">
              {collection.links.map((link) => (
                <Link key={link.href} href={link.href} className="start-link">
                  {link.label}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}
