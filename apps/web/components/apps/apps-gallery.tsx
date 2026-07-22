"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppGallery } from "@/components/apps/app-gallery";
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
  knowledge_sources: "Knowledge & Sources",
  communication: "Communication",
  custom: "Custom",
};

const READINESS_LABELS: Record<AppCatalogItem["readiness"], string> = {
  ready: "Ready",
  setup_required: "Setup required",
  install_required: "Available",
  degraded: "Needs attention",
  disabled: "Disabled",
};

type GalleryView = "discover" | "installed" | "connections";

export function AppsGallery({ initial }: { initial: AppsOverview }) {
  const [view, setView] = useState<GalleryView>("discover");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<AppCategory | "all">("all");

  const visibleApps = useMemo(() => {
    const query = search.trim().toLowerCase();
    return initial.apps.filter((app) => {
      if (
        view === "installed" &&
        app.installationStatus !== "installed"
      ) {
        return false;
      }
      if (view === "connections" && app.connectionCount === 0) return false;
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
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p className="font-medium text-muted-foreground text-sm">
            Capabilities for your agents and Projects
          </p>
          <h1 className="mt-1 font-semibold text-3xl tracking-tight">Apps</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Add the services and built-in capabilities agents can use, then
            control connections and access where the work happens.
          </p>
        </div>
        {initial.canCreateCustomApp ? (
          <Button asChild>
            <Link href="/settings/organization/environments">
              <Plus className="size-4" />
              Create Custom App
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <Tabs onValueChange={(value) => setView(value as GalleryView)} value={view}>
          <TabsList>
            <TabsTrigger value="discover">Discover</TabsTrigger>
            <TabsTrigger value="installed">Installed</TabsTrigger>
            <TabsTrigger value="connections">My Connections</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full xl:max-w-sm">
          <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Search Apps"
            className="pl-9"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Apps"
            value={search}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="App category">
        <Button
          onClick={() => setCategory("all")}
          size="sm"
          variant={category === "all" ? "default" : "outline"}
        >
          All
        </Button>
        {initial.categories.map((item) => (
          <Button
            key={item}
            onClick={() => setCategory(item)}
            size="sm"
            variant={category === item ? "default" : "outline"}
          >
            {CATEGORY_LABELS[item]}
          </Button>
        ))}
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
                : app.readiness === "setup_required" || app.readiness === "degraded"
                  ? "warning"
                  : "neutral",
          }))}
        />
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <p className="font-medium">No Apps match this view</p>
          <p className="mt-1 text-muted-foreground text-sm">
            Try another category or clear the search.
          </p>
        </div>
      )}
    </div>
  );
}
