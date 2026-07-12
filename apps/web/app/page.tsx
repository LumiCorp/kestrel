import { headers } from "next/headers";
import Link from "next/link";
import { AsciiHeroSolid } from "@/components/ascii-hero-solid";
import { LandingLearnMoreDialog } from "@/components/landing-learn-more-dialog";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  const primaryHref = session?.session ? "/threads" : "/sign-in";
  const primaryLabel = session?.session ? "Open Workspace" : "Sign In";

  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(to right, color-mix(in oklab, var(--foreground) 10%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 10%, transparent) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage:
            "radial-gradient(circle at center, black 28%, transparent 78%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[12%] top-[-8rem] h-[28rem] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--primary) 20%, transparent) 0%, transparent 68%)",
        }}
      />
      <div className="pointer-events-none absolute inset-4 border border-border/60 border-dashed sm:inset-6 md:inset-8" />

      <section className="relative z-10 mx-auto flex min-h-screen w-full max-w-[88rem] flex-col px-5 py-5 sm:px-6 sm:py-6 md:px-10 md:py-10">
        <div className="relative flex flex-1 items-center py-12 md:py-16">
          <div className="pointer-events-none absolute inset-y-[4%] right-[-2%] z-20 hidden w-[64%] md:block lg:right-[2%] lg:w-[68%]">
            <AsciiHeroSolid />
          </div>

          <div className="relative z-30 w-full max-w-[24rem] border border-border/70 border-dashed bg-background/72 p-6 backdrop-blur-sm sm:max-w-[26rem] sm:p-8 md:p-10">
            <div className="mb-10 flex items-center gap-3">
              <div aria-hidden="true" className="flex items-center gap-1.5">
                <span
                  className="size-2.5 border border-border/50"
                  style={{ backgroundColor: "var(--lumi-cream)" }}
                />
                <span
                  className="size-2.5 border border-border/50"
                  style={{ backgroundColor: "var(--lumi-charcoal)" }}
                />
                <span
                  className="size-2.5 border border-border/50"
                  style={{ backgroundColor: "var(--lumi-amber)" }}
                />
                <span
                  className="size-2.5 border border-border/50"
                  style={{ backgroundColor: "var(--lumi-teal)" }}
                />
              </div>
              <span className="h-px flex-1 bg-border/70" />
            </div>

            <div className="max-w-4xl space-y-6">
              <h1 className="max-w-4xl text-balance font-semibold text-[3.2rem] leading-[0.92] tracking-[-0.08em] sm:text-[4.5rem] md:text-[6.4rem]">
                Kestrel One
              </h1>

              <div className="flex flex-wrap gap-3 pt-2">
                <Link
                  className="hover:-translate-y-px inline-flex min-w-[11rem] items-center justify-center border border-foreground border-dashed bg-foreground px-5 py-3 font-medium font-mono text-[11px] text-background uppercase tracking-[0.24em] transition-transform duration-150 hover:bg-foreground/92"
                  href={primaryHref}
                >
                  {primaryLabel}
                </Link>
                <LandingLearnMoreDialog />
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
