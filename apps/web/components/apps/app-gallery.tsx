import Link from "next/link";
import type { ReactNode } from "react";
import { AppIcon } from "@/components/apps/app-icon";
import { cn } from "@/lib/utils";

export type AppGalleryItem = {
  key: string;
  name: string;
  description: string;
  icon: string | null;
  status?: string;
  statusTone?: "neutral" | "ready" | "warning";
};

function statusClass(tone: AppGalleryItem["statusTone"]) {
  if (tone === "ready") return "bg-emerald-500";
  if (tone === "warning") return "bg-amber-500";
  return "bg-muted-foreground/50";
}

function GalleryItemContent({
  item,
  layout,
}: {
  item: AppGalleryItem;
  layout: "grid" | "list";
}) {
  if (layout === "list") {
    return (
      <>
        <AppIcon appKey={item.key} className="size-9" icon={item.icon} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium text-sm">
            {item.name}
          </span>
          <span className="mt-0.5 line-clamp-1 block text-muted-foreground text-xs">
            {item.description}
          </span>
        </span>
        {item.status ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                statusClass(item.statusTone),
              )}
            />
            {item.status}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <>
      <AppIcon appKey={item.key} className="size-12" icon={item.icon} />
      <span className="mt-3 max-w-full truncate font-medium text-sm">
        {item.name}
      </span>
      <span className="mt-1 line-clamp-2 text-center text-muted-foreground text-xs leading-4">
        {item.description}
      </span>
      {item.status ? (
        <span className="mt-2 inline-flex items-center gap-1.5 text-muted-foreground text-xs">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              statusClass(item.statusTone),
            )}
          />
          {item.status}
        </span>
      ) : null}
    </>
  );
}

export function AppGallery({
  items,
  getHref,
  onSelect,
  empty,
  className,
  layout = "grid",
}: {
  items: AppGalleryItem[];
  getHref?: (item: AppGalleryItem) => string;
  onSelect?: (item: AppGalleryItem) => void;
  empty?: ReactNode;
  className?: string;
  layout?: "grid" | "list";
}) {
  if (!items.length) {
    return (
      empty ?? (
        <div className="border-y py-10 text-center text-muted-foreground text-sm">
          No Apps available.
        </div>
      )
    );
  }

  return (
    <div
      className={cn(
        layout === "grid"
          ? "grid grid-cols-2 border-y sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          : "divide-y border-y",
        className,
      )}
    >
      {items.map((item) => {
        const itemClass = cn(
          "group min-w-0 transition-colors hover:bg-muted/35 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          layout === "grid"
            ? "flex min-h-32 flex-col items-center justify-center border-border/70 border-r border-b px-3 py-4 text-center"
            : "flex w-full items-center gap-3 px-1 py-3 sm:px-2",
        );
        const href = getHref?.(item);
        if (href) {
          return (
            <Link className={itemClass} href={href} key={item.key}>
              <GalleryItemContent item={item} layout={layout} />
            </Link>
          );
        }
        return (
          <button
            className={itemClass}
            key={item.key}
            onClick={() => onSelect?.(item)}
            type="button"
          >
            <GalleryItemContent item={item} layout={layout} />
          </button>
        );
      })}
    </div>
  );
}
