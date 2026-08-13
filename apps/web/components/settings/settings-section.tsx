import type { HTMLAttributes, ReactNode } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function SettingsPage({
  children,
  className,
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: "narrow" | "standard" | "wide";
}) {
  return (
    <div
      className={cn(
        "w-full space-y-8",
        width === "narrow" && "max-w-3xl",
        width === "standard" && "max-w-5xl",
        className
      )}
      data-slot="settings-page"
    >
      {children}
    </div>
  );
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
  status,
  actions,
  headingLevel,
  size,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  status?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
  size?: "default" | "large";
}) {
  return (
    <PageHeader
      actions={actions}
      description={description}
      eyebrow={eyebrow}
      headingLevel={headingLevel}
      size={size}
      status={status}
      title={title}
    />
  );
}

export function SettingsSection({
  title,
  description,
  children,
  className,
  actions,
  density = "default",
  tone = "default",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  density?: "default" | "compact";
  tone?: "default" | "danger";
}) {
  return (
    <section
      className={cn(
        "grid gap-5 border-t lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10",
        density === "default" ? "py-6" : "py-4",
        tone === "danger" && "border-destructive/30",
        className
      )}
    >
      <div>
        <div className="flex items-start justify-between gap-3 lg:block">
          <h2
            className={cn(
              "font-semibold text-base tracking-tight",
              tone === "danger" && "text-destructive"
            )}
          >
            {title}
          </h2>
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

export function SettingsMetricStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 border-y lg:grid-cols-4 lg:[&>*:nth-child(3)]:border-l [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+3)]:border-t-0 [&>*]:border-y-0 [&>*]:px-4",
        className
      )}
      data-slot="settings-metric-strip"
    >
      {children}
    </div>
  );
}

export function SettingsDisclosure({
  title,
  description,
  children,
  defaultOpen = false,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      className={cn("group border-y", className)}
      data-slot="settings-disclosure"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-4 outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block font-medium text-sm">{title}</span>
          {description ? (
            <span className="mt-0.5 block text-muted-foreground text-xs/5">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t py-5">{children}</div>
    </details>
  );
}

export function SettingsStatusNotice({
  title,
  description,
  tone = "info",
  className,
}: {
  title: string;
  description?: string;
  tone?: "info" | "success" | "warning" | "error";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-l-2 py-1 pl-3",
        tone === "info" && "border-muted-foreground/40",
        tone === "success" && "border-emerald-600",
        tone === "warning" && "border-amber-600",
        tone === "error" && "border-destructive",
        className
      )}
      data-slot="settings-status-notice"
      role={tone === "error" ? "alert" : "status"}
    >
      <p className="font-medium text-sm">{title}</p>
      {description ? (
        <p className="mt-0.5 text-muted-foreground text-xs/5">{description}</p>
      ) : null}
    </div>
  );
}

export function SettingsFormActions({
  children,
  status,
  className,
}: {
  children: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
      data-slot="settings-form-actions"
    >
      <div className="min-h-5 text-muted-foreground text-xs">{status}</div>
      <SettingsActionGroup>{children}</SettingsActionGroup>
    </div>
  );
}

export function SettingsDangerSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsSection
      className={className}
      description={description}
      title={title}
      tone="danger"
    >
      {children}
    </SettingsSection>
  );
}

export function SettingsRowActionMenu({
  children,
  label = "Open actions",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={label} size="icon" type="button" variant="ghost">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
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
