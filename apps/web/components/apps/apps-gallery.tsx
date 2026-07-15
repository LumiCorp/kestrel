"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppIcon } from "@/components/apps/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AppCatalogItem,
  AppCategory,
  AppsOverview,
} from "@/lib/apps/types";
import { cn } from "@/lib/utils";

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

function statusClasses(readiness: AppCatalogItem["readiness"]) {
  if (readiness === "ready") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300";
  }
  if (readiness === "setup_required" || readiness === "degraded") {
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

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
            <Link href="/settings/environments">
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
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
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
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {visibleApps.map((app) => (
            <Link
              className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              href={`/apps/${encodeURIComponent(app.key)}`}
              key={app.key}
            >
              <Card className="h-full transition-colors group-hover:border-foreground/25 group-hover:bg-muted/20">
                <CardContent className="flex h-full flex-col p-5">
                  <div className="flex items-start gap-4">
                    <AppIcon appKey={app.key} icon={app.icon} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="font-semibold text-lg leading-6">
                          {app.displayName}
                        </h2>
                        <Badge
                          className={cn("shrink-0", statusClasses(app.readiness))}
                          variant="outline"
                        >
                          {READINESS_LABELS[app.readiness]}
                        </Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {CATEGORY_LABELS[app.category]}
                      </p>
                    </div>
                  </div>
                  <p className="mt-5 line-clamp-3 flex-1 text-muted-foreground text-sm leading-6">
                    {app.description}
                  </p>
                  <div className="mt-5 flex items-center justify-between border-t pt-4 text-xs">
                    <span className="text-muted-foreground">
                      {app.capabilityCount} capabilit{app.capabilityCount === 1 ? "y" : "ies"}
                    </span>
                    <span className="font-medium text-foreground">
                      {app.connectionModel === "none"
                        ? "Built in"
                        : app.connectionModel === "personal"
                          ? "Personal account"
                          : app.connectionModel === "hybrid"
                            ? "Personal or shared"
                            : app.connectionRequirement === "optional"
                              ? "Optional connection"
                              : "Environment connection"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
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
