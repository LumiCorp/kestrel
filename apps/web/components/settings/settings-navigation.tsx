"use client";

import {
  Activity,
  Bot,
  Building2,
  CloudCog,
  CreditCard,
  HardDrive,
  KeyRound,
  Mail,
  PlugZap,
  ScrollText,
  ServerCog,
  ShieldCheck,
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
  { href: "/settings/api-keys", icon: KeyRound, label: "API keys" },
  { href: "/apps?view=connections", icon: PlugZap, label: "Connections" },
];

const organizationItems: SettingsItem[] = [
  {
    href: "/settings/organization/members",
    icon: Building2,
    label: "Members",
  },
  {
    href: "/settings/organization/billing",
    icon: CreditCard,
    label: "Billing",
  },
  {
    href: "/settings/organization/agent-defaults",
    icon: Bot,
    label: "Agent defaults",
  },
  {
    href: "/settings/organization/ai-providers",
    icon: CloudCog,
    label: "AI providers",
  },
  {
    href: "/settings/organization/infrastructure",
    icon: ServerCog,
    label: "Infrastructure",
  },
  {
    href: "/settings/organization/email",
    icon: Mail,
    label: "Email",
  },
  {
    href: "/settings/organization/environments",
    icon: HardDrive,
    label: "Environments",
  },
  {
    href: "/settings/organization/api-keys",
    icon: KeyRound,
    label: "API keys",
  },
  {
    href: "/settings/organization/usage",
    icon: Activity,
    label: "Usage",
  },
  {
    href: "/settings/organization/audit",
    icon: ScrollText,
    label: "Audit",
  },
  { href: "/apps", icon: PlugZap, label: "Apps" },
];

const platformItems: SettingsItem[] = [
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
  { href: "/admin", icon: ShieldCheck, label: "Operations" },
];

function isItemActive(pathname: string, href: string) {
  const path = href.split("?")[0];
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function SettingsNavigation({
  canManageOrganization,
  isAppAdmin,
}: {
  canManageOrganization: boolean;
  isAppAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const groups: SettingsGroup[] = [
    { label: "Personal", items: personalItems },
    ...(canManageOrganization
      ? [{ label: "Organization", items: organizationItems }]
      : []),
    ...(isAppAdmin ? [{ label: "Platform", items: platformItems }] : []),
  ];
  const selectedHref =
    groups
      .flatMap((group) => group.items)
      .find((item) => isItemActive(pathname, item.href))?.href ??
    "/settings/profile";

  return (
    <>
      <div className="border-b px-4 py-4 lg:hidden">
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
      <aside className="hidden w-64 shrink-0 border-r px-4 py-6 lg:block">
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
                        "flex items-center gap-2 rounded-md px-2 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground",
                        active && "bg-muted text-foreground"
                      )}
                      href={item.href}
                      key={item.href}
                    >
                      <item.icon className="size-4" />
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
