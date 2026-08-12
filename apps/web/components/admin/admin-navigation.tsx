"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const adminItems = [
  { href: "/admin/environments", label: "Operations" },
  { href: "/admin/releases", label: "Releases" },
  { href: "/admin/billing", label: "Billing" },
  { href: "/admin/docs", label: "Docs" },
] as const;

export function AdminNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Platform administration"
      className="overflow-x-auto border-b"
    >
      <div className="flex min-w-max gap-5">
        {adminItems.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "border-transparent border-b-2 pb-3 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground",
                active && "border-foreground text-foreground",
              )}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
