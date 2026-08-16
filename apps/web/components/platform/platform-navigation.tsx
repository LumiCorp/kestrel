"use client";

import {
  BookOpen,
  CreditCard,
  Mail,
  ServerCog,
  TicketCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

type PlatformNavigationItem = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
};

const platformNavigationGroups: Array<{
  label: string;
  items: PlatformNavigationItem[];
}> = [
  {
    label: "Configure",
    items: [
      { href: "/platform/users", icon: Users, label: "Users" },
      {
        href: "/platform/signup-codes",
        icon: TicketCheck,
        label: "Signup codes",
      },
      { href: "/platform/email", icon: Mail, label: "System email" },
    ],
  },
  {
    label: "Operate",
    items: [
      {
        href: "/platform/operations",
        icon: ServerCog,
        label: "Environment operations",
      },
      {
        href: "/platform/billing",
        icon: CreditCard,
        label: "Billing diagnostics",
      },
      { href: "/platform/docs", icon: BookOpen, label: "Docs" },
    ],
  },
];

function isItemActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PlatformNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const selectedHref =
    platformNavigationGroups
      .flatMap((group) => group.items)
      .find((item) => isItemActive(pathname, item.href))?.href ??
    "/platform/users";

  return (
    <>
      <div className="border-b py-4 lg:hidden">
        <label
          className="mb-1.5 block font-medium text-muted-foreground text-xs"
          htmlFor="platform-section"
        >
          Platform section
        </label>
        <select
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          id="platform-section"
          onChange={(event) => router.push(event.target.value)}
          value={selectedHref}
        >
          {platformNavigationGroups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.href} value={item.href}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <aside className="hidden w-56 shrink-0 border-r py-6 pr-6 lg:block">
        <div className="sticky top-6 space-y-6">
          {platformNavigationGroups.map((group) => (
            <nav aria-label={`${group.label} platform`} key={group.label}>
              <div className="mb-2 px-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = isItemActive(pathname, item.href);
                  return (
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-10 items-center gap-2 rounded-md px-2 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground",
                        active && "bg-muted text-foreground",
                      )}
                      href={item.href}
                      key={item.href}
                    >
                      <item.icon className="size-4 shrink-0" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          ))}
        </div>
      </aside>
    </>
  );
}
