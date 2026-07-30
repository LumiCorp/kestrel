import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  CirclePause,
  Code2,
  Download,
  Github,
  History,
  Laptop,
  RotateCcw,
  SearchCheck,
  TerminalSquare,
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
    status: "Beta",
    title: "Kestrel Desktop",
    description:
      "Work locally with repositories, folders, research, data, and the artifacts Kestrel produces with you.",
    action: "Download Desktop Beta",
    href: "https://docs.kestrelagents.dev/desktop/install",
    icon: Laptop,
  },
  {
    id: "kestrel-one",
    status: "Beta",
    title: "Kestrel One",
    description:
      "Continue durable agent work across people, Projects, organizational Knowledge, Apps, and execution Environments.",
    action: "Explore Kestrel One Beta",
    href: "https://docs.kestrelagents.dev/kestrel-one/getting-started",
    icon: Users,
  },
  {
    id: "developers",
    status: "0.7",
    title: "Build with Kestrel",
    description:
      "Use the runtime, CLI, SDK, framework adapters, and Execution Protocol inside products and operating systems you already own.",
    action: "Build your first agent",
    href: "https://docs.kestrelagents.dev/build/building-your-first-agent",
    icon: Braces,
  },
] as const;

const capabilities = [
  {
    number: "01",
    title: "Continue",
    description:
      "Sessions and context remain available when you close the window or return later.",
    icon: History,
  },
  {
    number: "02",
    title: "Supervise",
    description:
      "Review progress, answer questions, approve important actions, and redirect the work.",
    icon: CirclePause,
  },
  {
    number: "03",
    title: "Recover",
    description:
      "Interrupted or failed work leaves enough state and evidence to understand what happened.",
    icon: RotateCcw,
  },
  {
    number: "04",
    title: "Inspect",
    description:
      "Runs preserve tool outcomes, checkpoints, artifacts, and explicit terminal results.",
    icon: SearchCheck,
  },
] as const;

const betaNotes = [
  "Desktop and Kestrel One are actively evolving Beta products.",
  "Capabilities and availability may change as the products mature.",
  "Release status and known limitations stay documented publicly.",
  "Reproducible issues and product feedback directly inform development.",
] as const;

const footerLinkClass =
  "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const sdkExample = `import { createAgent } from "@kestrel-agents/sdk";

const agent = createAgent({
  id: "project-agent",
  profileId: "reference",
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
        <span>Kestrel Desktop and Kestrel One are in Beta.</span>
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
            An open agent platform for durable work across local, hosted, and
            embedded environments.
          </p>
          <p className="font-mono text-muted-foreground text-xs">
            Kestrel Desktop and Kestrel One are Beta products.
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
        </nav>
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-muted-foreground text-xs sm:px-6 lg:px-8">
          <span>Open source under the MIT License.</span>
          <span>Built by Lumi Corp.</span>
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
                  <span>Open agent platform</span>
                  <span aria-hidden="true">·</span>
                  <span>Beta</span>
                </div>
                <h1 className="text-balance font-semibold text-5xl tracking-[-0.055em] sm:text-6xl lg:text-7xl">
                  Build with Kestrel.
                </h1>
                <p className="text-balance font-medium text-2xl tracking-tight sm:text-3xl">
                  Run real agent work without giving up control.
                </p>
                <p className="max-w-xl text-pretty text-lg text-muted-foreground leading-8">
                  Give agents the durable runtime to carry work through—and
                  keep the context, decisions, tools, and evidence you need to
                  trust the result.
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
                  <Link href="https://docs.kestrelagents.dev/kestrel-one/getting-started">
                    Explore Kestrel One Beta
                    <ArrowRight />
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
                  Local or hosted
                </span>
                <span className="inline-flex items-center gap-2">
                  <Check className="size-4 text-accent" />
                  Open source runtime
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

        <section className="border-b py-20 sm:py-24" id="products">
          <div className="mx-auto max-w-7xl space-y-12 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Start locally, collaborate with a team, or bring the runtime into a product you already own."
              eyebrow="Choose your path"
              title="One platform. Three ways in."
            />

            <div className="grid gap-4 lg:grid-cols-3">
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
              description="The product surfaces are different because the work is different. The underlying model for durable agent execution stays consistent."
              eyebrow="See Kestrel at work"
              title="The product is the proof."
            />
            <ProductShowcase />
          </div>
        </section>

        <section className="border-b py-20 sm:py-24">
          <div className="mx-auto max-w-7xl space-y-14 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Kestrel treats agent execution as durable work rather than a disposable request. People remain part of the operating loop."
              eyebrow="Durable work · visible control"
              title="Stay oriented while the work moves."
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

        <section className="border-b bg-card py-20 sm:py-24">
          <div className="mx-auto max-w-7xl space-y-12 px-4 sm:px-6 lg:px-8">
            <SectionIntro
              description="Desktop, CLI, Kestrel One, and server applications use the same execution architecture and explicit result contracts."
              eyebrow="One runtime · two deployment forms"
              title="Run locally or remotely without changing the model of the work."
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
                description="Use Kestrel from the terminal or connect a trusted Node.js application to Local Core or a hosted runner service."
                eyebrow="Open platform"
                title="Build on explicit contracts."
              />
              <div className="flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="https://docs.kestrelagents.dev/build/building-your-first-agent">
                    <BookOpen />
                    Read the SDK guide
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
                <Badge variant="outline">SDK 0.7</Badge>
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
                    Help shape what Kestrel becomes.
                  </h2>
                  <p className="mt-4 text-pretty text-muted-foreground leading-7">
                    Beta is a product stage, not a hidden program. We document
                    the current state, ship in public, and use real feedback to
                    improve the products.
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
                Start where the work is
              </p>
              <h2 className="text-balance font-semibold text-4xl tracking-[-0.04em] sm:text-6xl">
                Build something useful with Kestrel.
              </h2>
              <p className="mx-auto max-w-2xl text-pretty text-lg text-muted-foreground leading-8">
                Work locally in Desktop, move together in Kestrel One, or bring
                the runtime into your own application.
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
                <Link href="https://docs.kestrelagents.dev/kestrel-one/getting-started">
                  <Users />
                  Explore Kestrel One Beta
                </Link>
              </Button>
              <Button
                asChild
                className="h-11 px-5"
                size="lg"
                variant="ghost"
              >
                <Link href="https://docs.kestrelagents.dev/build/building-your-first-agent">
                  <TerminalSquare />
                  Build with the SDK
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
