"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function EnvironmentTabs({
  base,
  tabs,
}: {
  base: string;
  tabs: ReadonlyArray<readonly [string, string]>;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Environment sections"
      className="flex flex-wrap gap-6 border-b"
    >
      {tabs.map(([label, suffix]) => {
        const href = `${base}${suffix}`;
        const active =
          pathname === href || (suffix.length > 0 && pathname.startsWith(`${href}/`));
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-transparent border-b-2 py-2 font-medium text-muted-foreground text-sm transition-colors hover:border-foreground/30 hover:text-foreground",
              active && "border-primary text-foreground"
            )}
            href={href}
            key={label}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
