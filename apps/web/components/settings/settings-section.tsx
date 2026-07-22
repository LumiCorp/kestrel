import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-8", className)}>{children}</div>;
}

export function SettingsPanel({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("border-y py-5", className)}
      {...props}
    />
  );
}

export function SettingsPanelHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4", className)} {...props} />;
}

export function SettingsPanelTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("font-semibold text-base tracking-tight", className)} {...props} />
  );
}

export function SettingsPanelDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("mt-1 text-muted-foreground text-sm", className)} {...props} />
  );
}

export function SettingsPanelContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0", className)} {...props} />;
}

export function SettingsPanelFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mt-5 flex flex-wrap items-center gap-2", className)} {...props} />
  );
}

export function SettingsPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-muted-foreground text-sm/6">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <SettingsActionGroup>{actions}</SettingsActionGroup> : null}
    </header>
  );
}

export function SettingsSection({
  title,
  description,
  children,
  className,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "grid gap-5 border-t py-6 lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10",
        className
      )}
    >
      <div>
        <div className="flex items-start justify-between gap-3 lg:block">
          <h3 className="font-semibold text-base tracking-tight">{title}</h3>
          {actions ? <div className="lg:mt-4">{actions}</div> : null}
        </div>
        {description ? (
          <p className="mt-1 max-w-sm text-muted-foreground text-sm/6">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function SettingsRows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-y border-y", className)}>{children}</div>
  );
}

export function SettingsActionGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

export function SettingsStatusSummary({
  status,
  detail,
  tone = "neutral",
  className,
}: {
  status: string;
  detail?: string;
  tone?: "neutral" | "positive" | "warning";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full bg-muted-foreground/50",
          tone === "positive" && "bg-emerald-600",
          tone === "warning" && "bg-amber-600"
        )}
      />
      <span className="font-medium text-sm">{status}</span>
      {detail ? (
        <span className="truncate text-muted-foreground text-sm">{detail}</span>
      ) : null}
    </div>
  );
}

export function SettingsMetric({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="border-y py-4">
      <div className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-1 font-semibold text-2xl tabular-nums">{value}</div>
    </div>
  );
}

export function SettingsExpandableRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-t bg-muted/20 px-0 py-5 sm:px-4", className)}>
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 py-4 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.4fr)] sm:items-center sm:gap-8",
        className
      )}
    >
      <div>
        <div className="font-medium text-sm">{label}</div>
        {description ? (
          <p className="mt-0.5 text-muted-foreground text-xs/5">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 sm:justify-self-stretch">{children}</div>
    </div>
  );
}
