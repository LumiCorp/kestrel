import { ArrowRight, Cloud, Code, Desktop, HardDrives, TreeStructure } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { DOCS_RELEASE_LABEL } from "@/lib/release";

const pathways = [
  {
    number: "01",
    title: "Use Kestrel Desktop",
    description: "Install Desktop, connect a model, open a project, and complete your first task.",
    href: "/desktop/install",
    action: "Get Desktop",
    Icon: Desktop,
  },
  {
    number: "02",
    title: "Work in Kestrel One",
    description: "Join your team workspace, open a Project, and start working in a shared Thread.",
    href: "/kestrel-one/getting-started",
    action: "Start with Kestrel One",
    Icon: Cloud,
  },
  {
    number: "03",
    title: "Use the terminal",
    description: "Run Kestrel from the CLI/TUI for project work, scripts, and automation.",
    href: "/reference/cli",
    action: "Use the CLI/TUI",
    Icon: Code,
  },
] as const;

export function HomePage() {
  return (
    <div className="home-flow">
      <section className="home-hero">
        <div className="home-kicker-row">
          <Link href="/start/release-status">{DOCS_RELEASE_LABEL}</Link>
        </div>
        <h1>Start with Kestrel.</h1>
        <p>
          Open a local project in Desktop, work with a team in Kestrel One, use the CLI/TUI directly, or bring the
          TypeScript SDK into your own application.
        </p>
      </section>

      <section className="suite-pathways" aria-label="Choose a Kestrel path">
        {pathways.map(({ number, title, description, href, action, Icon }) => (
          <article className="suite-pathway" key={href}>
            <span className="path-number">{number}</span>
            <Icon className="path-icon" size={44} weight="regular" aria-hidden="true" />
            <h2>{title}</h2>
            <p>{description}</p>
            <Link href={href}>{action}<ArrowRight size={18} aria-hidden="true" /></Link>
          </article>
        ))}
      </section>

      <nav className="home-secondary-paths" aria-label="Build, operate, and reference Kestrel">
        <Link href="/build">
          <Code size={32} aria-hidden="true" />
          <span><strong>Build with TypeScript</strong><small>Create an agent and connect it to a local or remote Kestrel runtime.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
        <Link href="/operate">
          <HardDrives size={32} aria-hidden="true" />
          <span><strong>Operate and deploy</strong><small>Deploy a runtime, understand live behavior, and recover failed work.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
        <Link href="/reference/protocol">
          <TreeStructure size={32} aria-hidden="true" />
          <span><strong>Protocol and packages</strong><small>Find exact contracts, events, commands, packages, and compatibility details.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </nav>
    </div>
  );
}
