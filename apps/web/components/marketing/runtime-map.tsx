import {
  ArrowDown,
  ArrowRight,
  Cloud,
  HardDrive,
  Layers3,
  PackageCheck,
} from "lucide-react";

const deploymentPaths = [
  {
    label: "Local",
    products: "Desktop · CLI · local SDK target",
    boundary: "Local Core",
    icon: HardDrive,
  },
  {
    label: "Hosted",
    products: "Kestrel One · remote SDK target",
    boundary: "Runner service",
    icon: Cloud,
  },
] as const;

export function RuntimeMap() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(18rem,0.62fr)] lg:items-stretch">
      <div className="grid gap-4 sm:grid-cols-2">
        {deploymentPaths.map((path) => (
          <div
            className="flex min-h-52 flex-col justify-between rounded-xl border bg-background/55 p-5"
            key={path.label}
          >
            <div className="flex items-center justify-between">
              <path.icon className="size-5 text-accent" />
              <span className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
                {path.label}
              </span>
            </div>
            <p className="text-sm text-surface-foreground leading-6">
              {path.products}
            </p>
            <div className="flex items-center justify-between rounded-lg border bg-code px-4 py-3 font-medium text-sm">
              {path.boundary}
              <ArrowRight className="hidden size-4 text-muted-foreground lg:block" />
              <ArrowDown className="size-4 text-muted-foreground lg:hidden" />
            </div>
          </div>
        ))}
      </div>

      <div className="hidden items-center text-muted-foreground lg:flex">
        <ArrowRight />
      </div>

      <div className="flex min-h-52 flex-col justify-between rounded-xl border border-primary/40 bg-primary/8 p-5">
        <div className="flex items-center justify-between">
          <Layers3 className="size-5 text-primary" />
          <span className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            Shared contracts
          </span>
        </div>
        <div>
          <p className="font-semibold text-xl tracking-tight">
            Kestrel runtime
          </p>
          <p className="mt-2 text-muted-foreground text-sm leading-6">
            The same execution model for sessions, runs, tools, persistence,
            cancellation, recovery, and terminal results.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <PackageCheck className="size-4 text-primary" />
          Evidence and artifacts retained
        </div>
      </div>
    </div>
  );
}
