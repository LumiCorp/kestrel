import Link from "next/link";

const capabilities = [
  ["Durable sessions", "Keep agent work and context coherent across turns."],
  ["Operator control", "Stop, steer, and recover active work without losing the thread."],
  ["Evidence and replay", "Inspect what happened and reproduce behavior with durable evidence."],
  ["Workspace automation", "Run repeatable work close to the project state it depends on."],
] as const;

export function HomePage() {
  return (
    <div className="home-flow">
      <section className="home-hero">
        <div className="home-kicker">Kestrel Documentation</div>
        <h1>Build agents you can inspect, steer, and replay.</h1>
        <p>
          Kestrel brings a local Desktop workspace and a durable developer platform together, so agent work stays
          visible, controllable, and repeatable.
        </p>
      </section>

      <section className="path-grid" aria-label="Choose how to start">
        <article className="path-card path-card-desktop">
          <span className="path-number">01</span>
          <h2>Use Kestrel Desktop</h2>
          <p>Work in local projects with persistent sessions, workspace context, and operator control.</p>
          <div className="path-actions">
            <Link className="primary-action" href="/apps/desktop">Explore Desktop</Link>
            <Link className="secondary-action" href="/docs/quickstart">Run locally</Link>
          </div>
        </article>
        <article className="path-card path-card-build">
          <span className="path-number">02</span>
          <h2>Build with Kestrel</h2>
          <p>Add durable agent execution with the SDK, server-owned APIs, Next.js helpers, and observability.</p>
          <div className="path-actions">
            <Link className="primary-action" href="/build/building-your-first-agent">Build your first agent</Link>
            <Link className="secondary-action" href="/build">View build guides</Link>
          </div>
        </article>
      </section>

      <section className="capability-section">
        <div className="section-heading-row">
          <div>
            <span className="home-kicker">Why Kestrel</span>
            <h2>Control is part of the product.</h2>
          </div>
          <Link href="/docs/why-kestrel">Read the product point of view</Link>
        </div>
        <div className="capability-grid">
          {capabilities.map(([title, description]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <nav className="home-secondary-nav" aria-label="More ways to explore">
        <Link href="/deploy">Deploy Kestrel</Link>
        <Link href="/cli">CLI reference</Link>
        <Link href="/docs/core-concepts">Core concepts</Link>
        <Link href="/docs/faq">FAQ</Link>
        <a href="https://github.com/LumiCorp/kestrel">GitHub</a>
      </nav>
    </div>
  );
}
