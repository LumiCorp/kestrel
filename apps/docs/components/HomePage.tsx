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
    description: "Install the supported 0.8 CLI/TUI and work in a project from macOS or Linux.",
    href: "/cli/install",
    action: "Install the CLI/TUI",
    Icon: Code,
  },
  {
    number: "04",
    title: "Build with the SDK",
    description: "Bring the same runtime, protocol, recovery, and evidence into a TypeScript application.",
    href: "/build/building-your-first-agent",
    action: "Build your first agent",
    Icon: TreeStructure,
  },
] as const;

export function HomePage() {
  return (
    <div className="home-flow">
      <section className="home-hero">
        <div className="home-kicker-row">
          <Link href="/start/release-status">{DOCS_RELEASE_LABEL}</Link>
        </div>
        <h1>One Kestrel everywhere.</h1>
        <p>
          Kestrel 0.8 carries the same durable runtime, explicit control, recovery, and evidence through Desktop,
          Kestrel One, the CLI/TUI, and TypeScript integrations.
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
        <Link href="/start/runtime-model">
          <Cloud size={32} aria-hidden="true" />
          <span><strong>Understand the runtime</strong><small>Follow a request through identity, execution, recovery, and durable evidence.</small></span>
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
        <Link href="/start/release-status">
          <Code size={32} aria-hidden="true" />
          <span><strong>Release and compatibility</strong><small>Verify 0.8 versions, platforms, downloads, hosted identity, and known limitations.</small></span>
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </nav>
    </div>
  );
}
