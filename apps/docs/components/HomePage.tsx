import { ArrowRight, Cloud, Code, Desktop, HardDrives, TreeStructure } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { DOCS_RELEASE_LABEL } from "@/lib/release";

const pathways = [
  {
    number: "01",
    title: "Use Kestrel Desktop",
    description: "Run agents locally. Pick up exactly where you left off.",
    href: "/desktop/install",
    action: "Get Desktop Beta",
    Icon: Desktop,
  },
  {
    number: "02",
    title: "Work in Kestrel One",
    description: "Keep agent work, context, and decisions together so your team can move it forward.",
    href: "/kestrel-one/getting-started",
    action: "Start with Kestrel One",
    Icon: Cloud,
  },
  {
    number: "03",
    title: "Build with Kestrel",
    description: "Add durable agent workflows to your product without rebuilding execution, recovery, and observability.",
    href: "/build/building-your-first-agent",
    action: "Build your first agent",
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
        <h1>Run real agent work<br /> without giving up control.</h1>
        <p>
          Kestrel gives agents the durable runtime to carry work through—and gives you the control to trust the result.
          Context survives across sessions, important decisions can wait for you, and every run leaves evidence you can
          inspect, recover, and replay. Use it locally, collaborate with your team, or build it into your own product.
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

      <nav className="home-secondary-paths" aria-label="Operate and reference Kestrel">
        <Link href="/operate">
          <HardDrives size={32} aria-hidden="true" />
          <span><strong>Operate and deploy</strong><small>Deploy with clear controls, evidence, and recovery paths.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
        <Link href="/reference/protocol">
          <TreeStructure size={32} aria-hidden="true" />
          <span><strong>Protocol and packages</strong><small>Use stable contracts across runtimes, packages, and applications.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </nav>
    </div>
  );
}
