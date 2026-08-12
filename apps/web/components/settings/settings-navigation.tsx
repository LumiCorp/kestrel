"use client";

import {
  KeyRound,
  Mail,
  Palette,
  PlugZap,
  ScrollText,
  Server,
  Sparkles,
  ShieldCheck,
  TicketCheck,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

type SettingsItem = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
};

type SettingsGroup = {
  label: string;
  items: SettingsItem[];
};

const personalItems: SettingsItem[] = [
  { href: "/settings/profile", icon: User, label: "Profile" },
  { href: "/settings/appearance", icon: Palette, label: "Appearance" },
  { href: "/settings/api-keys", icon: KeyRound, label: "API keys" },
  { href: "/apps?view=connections", icon: PlugZap, label: "Connections" },
];

const platformItems: SettingsItem[] = [
  {
    href: "/settings/platform/signup-codes",
    icon: TicketCheck,
    label: "Signup codes",
  },
  {
    href: "/settings/platform/users",
    icon: Users,
    label: "Users",
  },
  {
    href: "/settings/platform/email",
    icon: Mail,
    label: "System email",
  },
];

function isItemActive(pathname: string, href: string) {
  const path = href.split("?")[0];
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function SettingsNavigation({
  isAppAdmin,
}: {
  isAppAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const groups: SettingsGroup[] = [
    { label: "Personal", items: personalItems },
    ...(isAppAdmin ? [{ label: "Platform", items: platformItems }] : []),
  ];
  const selectedHref =
    groups
      .flatMap((group) => group.items)
      .find((item) => isItemActive(pathname, item.href))?.href ??
    "/settings/profile";

  return (
    <>
      <div className="border-b py-4 lg:hidden">
        <label
          className="mb-1.5 block font-medium text-muted-foreground text-xs"
          htmlFor="settings-section"
        >
          Settings section
        </label>
        <select
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          id="settings-section"
          onChange={(event) => router.push(event.target.value)}
          value={selectedHref}
        >
          {groups.map((group) => (
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
          {groups.map((group) => (
            <nav aria-label={`${group.label} settings`} key={group.label}>
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
