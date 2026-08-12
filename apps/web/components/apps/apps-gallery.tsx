"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppGallery } from "@/components/apps/app-gallery";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AppCatalogItem,
  AppCategory,
  AppsOverview,
} from "@/lib/apps/types";

const CATEGORY_LABELS: Record<AppCategory, string> = {
  kestrel: "Kestrel",
  search_research: "Search & Research",
  productivity: "Productivity",
  engineering: "Engineering",
  communication: "Communication",
  workflow: "Workflows",
  custom: "Custom",
};

const READINESS_LABELS: Record<AppCatalogItem["readiness"], string> = {
  ready: "Ready",
  setup_required: "Setup required",
  install_required: "Available",
  degraded: "Needs attention",
  disabled: "Disabled",
};

type GalleryView = "installed" | "available";

export function AppsGallery({
  initial,
  addAppHref,
}: {
  initial: AppsOverview;
  addAppHref?: string;
}) {
  const [view, setView] = useState<GalleryView>("installed");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<AppCategory | "all">("all");

  const visibleApps = useMemo(() => {
    const query = search.trim().toLowerCase();
    return initial.apps.filter((app) => {
      const isAvailable = app.installationStatus === "not_installed";
      if (view === "installed" && isAvailable) return false;
      if (view === "available" && !isAvailable) return false;
      if (category !== "all" && app.category !== category) return false;
      if (!query) return true;
      return [
        app.displayName,
        app.description,
        CATEGORY_LABELS[app.category],
        ...app.capabilityGroups,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [category, initial.apps, search, view]);

  return (
    <div className="space-y-7">
      <PageHeader
        actions={
          initial.canCreateCustomApp && addAppHref ? (
            <Button asChild>
              <Link href={addAppHref}>
                <Plus className="size-4" />
                Add App
              </Link>
            </Button>
          ) : undefined
        }
        description="Services and built-in capabilities available to agents and Projects."
        title="Apps"
      />

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <Tabs
          onValueChange={(value) => setView(value as GalleryView)}
          value={view}
        >
          <TabsList>
            <TabsTrigger value="installed">Installed</TabsTrigger>
            <TabsTrigger value="available">Available</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex w-full flex-col gap-2 sm:flex-row xl:max-w-xl">
          <div className="relative min-w-0 flex-1">
            <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Search Apps"
              className="pl-9"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search Apps"
              value={search}
            />
          </div>
          <select
            aria-label="Filter by category"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) =>
              setCategory(event.target.value as AppCategory | "all")
            }
            value={category}
          >
            <option value="all">All categories</option>
            {initial.categories.map((item) => (
              <option key={item} value={item}>
                {CATEGORY_LABELS[item]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {visibleApps.length ? (
        <AppGallery
          getHref={(app) => `/apps/${encodeURIComponent(app.key)}`}
          items={visibleApps.map((app) => ({
            key: app.key,
            name: app.displayName,
            description: app.description,
            icon: app.icon,
            status: `${READINESS_LABELS[app.readiness]} · ${CATEGORY_LABELS[app.category]}`,
            statusTone:
              app.readiness === "ready"
                ? "ready"
                : app.readiness === "setup_required" ||
                    app.readiness === "degraded"
                  ? "warning"
                  : "neutral",
          }))}
        />
      ) : (
        <div className="border-y px-6 py-12 text-center">
          <p className="font-medium">No Apps match this view</p>
          <p className="mt-1 text-muted-foreground text-sm">
            Try another category or clear the search.
          </p>
        </div>
      )}
    </div>
  );
}
