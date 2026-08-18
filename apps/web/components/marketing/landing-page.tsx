import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  Code2,
  Database,
  Download,
  FileText,
  Github,
  Laptop,
  Terminal,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { ProductShowcase } from "@/components/marketing/product-showcase";
import { RuntimeMap } from "@/components/marketing/runtime-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const productPaths = [
  {
    id: "desktop",
    status: "0.8 Beta",
    title: "Kestrel Desktop",
    description:
      "Start with the files and tools in a project on your computer. Choose a model, describe the outcome, and work with Kestrel in the same place.",
    action: "Download Desktop Beta",
    href: "https://docs.kestrelagents.dev/desktop/install",
    icon: Laptop,
  },
  {
    id: "kestrel-one",
    status: "0.8 Beta",
    title: "Kestrel One",
    description:
      "Bring people, shared context, and connected capabilities into the work with Projects, Threads, Knowledge, Apps, and execution Environments.",
    action: "Access hosted Kestrel One",
    href: "/sign-up",
    icon: Users,
  },
  {
    id: "cli",
    status: "0.8 Beta",
    title: "Kestrel CLI/TUI",
    description:
      "Work from the terminal with the same durable sessions, Mission Control, recovery, profiles, tools, and terminal outcomes.",
    action: "Install the CLI/TUI",
    href: "https://docs.kestrelagents.dev/cli/install",
    icon: Terminal,
  },
  {
    id: "developers",
    status: "0.8",
    title: "Build with the SDK",
    description:
      "Embed Kestrel with exact 0.8 packages for execution, Memory, adapters, observability, recovery, and approvals.",
    action: "Build your first agent",
    href: "https://docs.kestrelagents.dev/build/building-your-first-agent",
    icon: Braces,
  },
] as const;

const capabilities = [
  {
    number: "01",
    title: "Change a codebase",
    description:
      "Inspect the repository, edit files, run tests, and leave the result ready for review.",
    icon: Code2,
  },
  {
    number: "02",
    title: "Research a question",
    description:
      "Find sources, compare the evidence, and turn the findings into a useful answer.",
    icon: BookOpen,
  },
  {
    number: "03",
    title: "Work through data",
    description:
      "Inspect a dataset or spreadsheet, perform the analysis, and produce a usable output.",
    icon: Database,
  },
  {
    number: "04",
    title: "Create the deliverable",
    description:
      "Build the report, workbook, presentation, or other file the project requires.",
    icon: FileText,
  },
] as const;

const betaNotes = [
  "Products, packages, and contracts share the canonical 0.8.5 release.",
  "Kestrel One source is public; Lumi-hosted signup requires an invite code.",
  "Desktop 0.8.5 is signed and notarized, with stable OTA support from 0.7.0 and 0.8.0.",
  "Release identity, known Beta limitations, and compatibility remain public.",
] as const;

const footerLinkClass =
  "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const sdkExample = `import { createAgent } from "@kestrel-agents/sdk";

const agent = createAgent({
  id: "project-agent",
  profileId: "kestrel",
  target: {
    kind: "remote",
    baseUrl: runnerUrl,
    authToken: runnerToken,
  },
});

const terminal = await agent.run({
  sessionId: "project-123",
  message: "Summarize the current project.",
}, context);`;

function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
        {eyebrow}
      </p>
      <h2 className="text-balance font-semibold text-4xl tracking-[-0.035em] sm:text-5xl">
        {title}
      </h2>
      <p className="max-w-2xl text-pretty text-lg text-muted-foreground leading-8">
        {description}
      </p>
    </div>
  );
}

function BetaNotice() {
  return (
    <aside className="border-border/80 border-b bg-secondary text-secondary-foreground">
      <div className="mx-auto flex min-h-10 max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-sm sm:px-6 lg:px-8">
        <Badge className="border-primary/40 bg-primary/10" variant="outline">
          Beta
        </Badge>
        <span>Kestrel 0.8 is one coordinated Beta release across every product surface.</span>
        <Link
          className="inline-flex items-center gap-1 rounded-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          href="https://docs.kestrelagents.dev/start/release-status"
        >
          View release status
          <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </aside>
  );
}

function MarketingFooter() {
  return (
    <footer className="border-t bg-card">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1fr_auto] lg:px-8">
        <div className="space-y-4">
          <Link
            aria-label="Kestrel home"
            className="inline-flex items-center gap-2.5 font-semibold text-lg"
            href="/"
          >
            <BrandMark decorative size={28} />
            Kestrel
          </Link>
          <p className="max-w-md text-muted-foreground text-sm leading-6">
            Open-source agent platform for software, research, data, and
            document work.
          </p>
          <p className="font-mono text-muted-foreground text-xs">
            Kestrel 0.8 is Beta across Desktop, One, CLI/TUI, and SDK integrations.
          </p>
          <p className="max-w-md text-muted-foreground text-sm leading-6">
            Kestrel is maintained and supported by Lumi.
          </p>
        </div>
        <nav
          aria-label="Footer navigation"
          className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm sm:grid-cols-3"
        >
          <Link
            className={footerLinkClass}
            href="https://docs.kestrelagents.dev"
          >
            Documentation
          </Link>
          <Link
            className={footerLinkClass}
            href="https://github.com/LumiCorp/kestrel"
          >
            GitHub
          </Link>
          <Link
            className={footerLinkClass}
            href="https://docs.kestrelagents.dev/start/release-status"
          >
            Release status
          </Link>
          <Link
            className={footerLinkClass}
            href="https://docs.kestrelagents.dev/docs/architecture-overview"
          >
            Architecture
          </Link>
          <Link
            className={footerLinkClass}
            href="https://github.com/LumiCorp/kestrel/issues"
          >
            Support
          </Link>
          <Link
            className={footerLinkClass}
            href="https://github.com/LumiCorp/kestrel/security/policy"
          >
            Security
          </Link>
          <Link
            className={footerLinkClass}
            href="https://www.lumicorp.ai"
          >
            Lumi
          </Link>
        </nav>
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-muted-foreground text-xs sm:px-6 lg:px-8">
          <span>Open source under the MIT License.</span>
          <Link className={footerLinkClass} href="https://www.lumicorp.ai">
            www.lumicorp.ai
          </Link>
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        className="-translate-y-20 fixed top-3 left-3 z-50 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm shadow-elevation-light transition-transform focus:translate-y-0 focus:outline-none focus:ring-[3px] focus:ring-ring/50"
        href="#main-content"
      >
        Skip to content
      </a>
      <BetaNotice />
      <MarketingHeader />

      <main id="main-content">
        <section className="overflow-hidden border-b">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,0.86fr)_minmax(34rem,1.14fr)] lg:items-center lg:gap-16 lg:px-8 lg:py-28">
            <div className="space-y-8">
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3 font-mono text-muted-foreground text-xs uppercase tracking-[0.18em]">
                  <span>Kestrel 0.8</span>
                  <span aria-hidden="true">·</span>
                  <span>Beta</span>
                </div>
                <h1 className="text-balance font-semibold text-5xl tracking-[-0.055em] sm:text-6xl lg:text-7xl">
                  One Kestrel everywhere.
                </h1>
                <p className="text-balance font-medium text-2xl tracking-tight sm:text-3xl">
                  Kestrel is an open-source agent platform for building
                  software, researching questions, analyzing data, and
                  producing reports, spreadsheets, presentations, and other
                  files.
                </p>
                <p className="max-w-xl text-pretty text-lg text-muted-foreground leading-8">
                  Desktop, Kestrel One, the CLI/TUI, and SDK integrations use
                  the same 0.8 Runtime, Protocol, Mission Control, recovery,
                  Memory, approvals, and evidence contracts.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild className="h-11 px-5" size="lg">
                  <Link href="https://docs.kestrelagents.dev/desktop/install">
                    <Download />
                    Download Desktop Beta
                  </Link>
                </Button>
                <Button
                  asChild
                  className="h-11 px-5"
                  size="lg"
                  variant="outline"
                >
                  <Link href="/sign-up">
                    Access hosted Kestrel One
                    <ArrowRight />
                  </Link>
                </Button>
                <Button asChild className="h-11 px-5" size="lg" variant="ghost">
                  <Link href="https://github.com/LumiCorp/kestrel/tree/v0.8.5/apps/web">
                    <Github />
                    View Kestrel One source
                  </Link>
                </Button>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-3 text-muted-foreground text-sm">
                <span className="inline-flex items-center gap-2">
                  <Check className="size-4 text-accent" />
                  Choose your model
                </span>
                <span className="inline-flex items-center gap-2">
                  <Check className="size-4 text-accent" />
                  Work with project files and tools
                </span>
                <span className="inline-flex items-center gap-2">
                  <Check className="size-4 text-accent" />
                  Keep the result with the project
                </span>
              </div>
            </div>

            <figure className="relative">
              <div className="overflow-hidden rounded-xl border bg-card shadow-elevation-light">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <Laptop className="size-4 text-primary" />
                    Fix, test, hand off
                  </div>
                  <Badge variant="outline">Kestrel Desktop · Beta</Badge>
                </div>
                <div className="relative aspect-[1.44/1] bg-surface">
                  <Image
                    alt="Kestrel Desktop showing a completed checkout fix, regression coverage, and passing tests"
                    className="object-contain object-top"
                    fill
                    priority
                    sizes="(min-width: 1024px) 680px, 100vw"
                    src="/product/desktop/checkout-result.png"
                  />
                </div>
              </div>
              <figcaption className="mt-3 text-center text-muted-foreground text-xs">
                The request, the result, and the verification stay together.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="border-b py-20 sm:py-24">
          <div className="mx-auto max-w-7xl space-y-14 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Kestrel can take on the technical, analytical, and document work inside a real project, along with the other work your business needs an agent to handle."
              eyebrow="What Kestrel can do"
              title="From the first question to the finished file."
            />

            <ol className="grid border-y sm:grid-cols-2 lg:grid-cols-4">
              {capabilities.map((capability, index) => (
                <li
                  className="relative flex min-h-64 flex-col justify-between gap-8 border-b p-6 last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0 sm:[&:nth-child(3)]:border-b-0 sm:[&:nth-child(odd)]:border-r"
                  key={capability.title}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-muted-foreground text-xs">
                      {capability.number}
                    </span>
                    <capability.icon className="size-5 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-xl tracking-tight">
                      {capability.title}
                    </h3>
                    <p className="mt-3 text-muted-foreground text-sm leading-6">
                      {capability.description}
                    </p>
                  </div>
                  {index < capabilities.length - 1 ? (
                    <ArrowRight className="-right-3 absolute top-1/2 z-10 hidden size-6 rounded-full border bg-background p-1 text-muted-foreground lg:block" />
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-b py-20 sm:py-24" id="products">
          <div className="mx-auto max-w-7xl space-y-12 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Desktop, Kestrel One, CLI/TUI, and the SDK are peer entry points into one versioned runtime and contract system."
              eyebrow="Desktop · Kestrel One · CLI/TUI · SDK"
              title="Choose the surface. Keep the same Kestrel."
            />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {productPaths.map((product, index) => (
                <Card
                  className="group h-full scroll-mt-24 gap-8 overflow-hidden bg-card transition-colors hover:border-primary/45"
                  id={product.id}
                  key={product.title}
                >
                  <CardHeader className="gap-5">
                    <div className="flex items-center justify-between">
                      <div className="flex size-10 items-center justify-center rounded-lg border bg-background">
                        <product.icon className="size-5 text-primary" />
                      </div>
                      <Badge variant="outline">{product.status}</Badge>
                    </div>
                    <div className="space-y-2">
                      <p className="font-mono text-muted-foreground text-xs">
                        0{index + 1}
                      </p>
                      <CardTitle className="text-2xl tracking-tight">
                        {product.title}
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <CardDescription className="text-base leading-7">
                      {product.description}
                    </CardDescription>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="link">
                      <Link className="px-0" href={product.href}>
                        {product.action}
                        <ArrowUpRight />
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b bg-surface py-20 sm:py-24">
          <div className="mx-auto max-w-7xl space-y-12 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Desktop keeps durable local conversations and project evidence beside the files. Kestrel One carries that model into shared Projects, Threads, context revisions, Knowledge, Apps, and Environments."
              eyebrow="Kestrel Desktop · Kestrel One"
              title="Work in the project, then bring in the team."
            />
            <ProductShowcase />
          </div>
        </section>

        <section className="border-b bg-card py-20 sm:py-24">
          <div className="mx-auto max-w-7xl space-y-12 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Mission Control, policy-bound recovery, action-bound approvals, governed Memory, tool activity, artifacts, and terminal outcomes remain attached to the recorded work and release identity that produced them."
              eyebrow="Kestrel Runtime"
              title="See the run, not just the answer."
            />
            <RuntimeMap />
          </div>
        </section>

        <section
          className="scroll-mt-24 border-b py-20 sm:py-24"
          id="developers"
        >
          <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.72fr)_minmax(30rem,1.28fr)] lg:items-center lg:gap-16 lg:px-8">
            <div className="space-y-6">
              <SectionIntro
                description="Use the CLI/TUI for direct work and automation. Use the SDK to start, stream, resume, and inspect local or remote runs from your own application."
                eyebrow="CLI/TUI · TypeScript SDK"
                title="Use the same runtime from the terminal or TypeScript."
              />
              <div className="flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="https://docs.kestrelagents.dev/build/building-your-first-agent">
                    <BookOpen />
                    Read the SDK guide
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="https://docs.kestrelagents.dev/cli/install">
                    <Terminal />
                    npm install -g @kestrel-agents/kestrel@0.8.5
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="https://github.com/LumiCorp/kestrel">
                    <Github />
                    View on GitHub
                  </Link>
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border bg-code shadow-elevation-light">
              <div className="flex items-center justify-between border-b bg-code-highlight px-4 py-3">
                <div className="flex items-center gap-2 font-mono text-xs">
                  <Code2 className="size-4 text-code-number" />
                  agent.ts
                </div>
                <Badge variant="outline">SDK 0.8</Badge>
              </div>
              <pre className="overflow-x-auto p-5 text-code-foreground text-sm leading-6">
                <code>{sdkExample}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="border-b bg-surface py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid overflow-hidden rounded-xl border bg-background shadow-elevation-light lg:grid-cols-[0.7fr_1.3fr]">
              <div className="flex flex-col justify-between gap-10 border-b bg-secondary p-6 sm:p-8 lg:border-r lg:border-b-0 lg:p-10">
                <div>
                  <Badge className="mb-5" variant="outline">
                    Beta
                  </Badge>
                  <h2 className="text-balance font-semibold text-4xl tracking-[-0.035em]">
                    Help shape Kestrel in Beta.
                  </h2>
                  <p className="mt-4 text-pretty text-muted-foreground leading-7">
                    Kestrel 0.8 evolves in public as one version across distinct
                    distribution and access channels. Source, release evidence,
                    documentation, and known Beta limitations remain visible.
                    Kestrel is maintained and supported by Lumi.
                  </p>
                </div>
                <Button asChild className="w-fit" variant="outline">
                  <Link href="https://docs.kestrelagents.dev/start/release-status">
                    Read release status
                    <ArrowUpRight />
                  </Link>
                </Button>
              </div>
              <div className="grid gap-px bg-border sm:grid-cols-2">
                {betaNotes.map((note) => (
                  <div
                    className="flex min-h-36 items-start gap-3 bg-background p-6 sm:p-8"
                    key={note}
                  >
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <p className="text-sm leading-6">{note}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-5xl space-y-8 px-4 text-center sm:px-6 lg:px-8">
            <div className="space-y-4">
              <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
                Kestrel 0.8
              </p>
              <h2 className="text-balance font-semibold text-4xl tracking-[-0.04em] sm:text-6xl">
                Choose how you want to start.
              </h2>
              <p className="mx-auto max-w-2xl text-pretty text-lg text-muted-foreground leading-8">
                Download Desktop, clone Kestrel One, access the invited hosted service, or read the docs.
              </p>
            </div>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              <Button asChild className="h-11 px-5" size="lg">
                <Link href="https://docs.kestrelagents.dev/desktop/install">
                  <Download />
                  Download Desktop Beta
                </Link>
              </Button>
              <Button
                asChild
                className="h-11 px-5"
                size="lg"
                variant="outline"
              >
                <Link href="https://github.com/LumiCorp/kestrel/tree/v0.8.5/apps/web">
                  <Github />
                  Kestrel One source
                </Link>
              </Button>
              <Button asChild className="h-11 px-5" size="lg" variant="outline">
                <Link href="/sign-up">
                  <Users />
                  Hosted access
                </Link>
              </Button>
              <Button asChild className="h-11 px-5" size="lg" variant="ghost">
                <Link href="https://docs.kestrelagents.dev">
                  <BookOpen />
                  Read the docs
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
