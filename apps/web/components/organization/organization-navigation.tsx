"use client";

import {
  Activity,
  Bot,
  Building2,
  CreditCard,
  KeyRound,
  Mail,
  Network,
  PlugZap,
  ScrollText,
  Server,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

type OrganizationNavigationItem = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
};

type OrganizationNavigationGroup = {
  label: string;
  items: OrganizationNavigationItem[];
};

const organizationNavigationGroups: OrganizationNavigationGroup[] = [
  {
    label: "Manage",
    items: [
      { href: "/organization", icon: Building2, label: "Environments" },
      { href: "/organization/setup", icon: Sparkles, label: "Setup" },
      { href: "/organization/people", icon: Users, label: "People" },
      { href: "/organization/billing", icon: CreditCard, label: "Billing" },
    ],
  },
  {
    label: "Configure",
    items: [
      {
        href: "/organization/connections",
        icon: PlugZap,
        label: "Connections",
      },
      {
        href: "/organization/agent-defaults",
        icon: Bot,
        label: "Agent defaults",
      },
      {
        href: "/organization/inference",
        icon: Server,
        label: "Inference",
      },
      { href: "/organization/email", icon: Mail, label: "Email" },
      {
        href: "/organization/api-keys",
        icon: KeyRound,
        label: "API keys",
      },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/organization/systems", icon: Network, label: "Systems" },
      {
        href: "/organization/usage",
        icon: Activity,
        label: "Costs & usage",
      },
      { href: "/organization/audit", icon: ScrollText, label: "Audit" },
      {
        href: "/organization/danger",
        icon: ShieldAlert,
        label: "Danger",
      },
    ],
  },
];

function isItemActive(pathname: string, href: string) {
  if (href === "/organization") {
    return (
      pathname === href || pathname.startsWith("/organization/environments/")
    );
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OrganizationNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const selectedHref =
    organizationNavigationGroups
      .flatMap((group) => group.items)
      .find((item) => isItemActive(pathname, item.href))?.href ?? "";

  return (
    <>
      <div className="border-b py-4 lg:hidden">
        <label
          className="mb-1.5 block font-medium text-muted-foreground text-xs"
          htmlFor="organization-section"
        >
          Organization section
        </label>
        <select
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          id="organization-section"
          onChange={(event) => router.push(event.target.value)}
          value={selectedHref}
        >
          <option disabled value="">
            Choose a section
          </option>
          {organizationNavigationGroups.map((group) => (
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
          {organizationNavigationGroups.map((group) => (
            <nav aria-label={`${group.label} organization`} key={group.label}>
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
